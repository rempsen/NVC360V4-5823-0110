/**
 * GET /api/bookings/today-stats — two regressions.
 *
 * 1. ROUTE ORDER. The handler was declared at the very bottom of bookings.ts,
 *    below `.get("/:id")`. Hono matches in registration order, so every call
 *    resolved as "fetch booking with id = today-stats" and returned 404. The
 *    driver app maps a non-ok response to zeros, so every technician's home
 *    screen showed 0 jobs / $0 earnings, always. Proven live before the fix:
 *    the endpoint returned {"message":"Not found"}.
 *
 * 2. TIME ZONE. The window was built with setHours(0,0,0,0) on a Date, i.e. the
 *    server process time zone (UTC in production). For a Winnipeg tenant the
 *    day rolled over at 19:00 local — this morning's completed jobs dropped off
 *    the counter mid-evening and an evening job counted toward tomorrow. It now
 *    uses company_settings.timezone.
 *
 * Harness: ephemeral in-memory libsql, ids prefixed "tds-".
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import { ensureSchema } from "../../database/__tests__/setup";

await ensureSchema();

const { db } = await import("../../database/index");
const { bookingsRoutes } = await import("../bookings");
const { clearCompanyTimeZoneCache } = await import("../../../services/company-tz");
const { zonedTimeToInstant, zonedParts } = await import("../../../shared/tz");
const { AppError } = await import("../../lib/errors");

const WPG_CO = "tds-winnipeg-co";
const UTC_CO = "tds-utc-co";
const USER = "tds-tech-user";
const RIDER_WPG = "tds-rider-wpg";
const RIDER_UTC = "tds-rider-utc";
const TZ = "America/Winnipeg";

const app = new Hono().use("*", async (c, next) => {
  c.set("companyId", c.req.header("X-Test-Company") || "default");
  const uid = c.req.header("X-Test-User");
  c.set("user", uid ? { id: uid, role: "rider", email: `${uid}@t.test`, name: uid } : null);
  return next();
});
app.route("/bookings", bookingsRoutes);
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.expose ? err.message : "error" } }, err.status as 400);
  }
  return c.json({ error: { code: "internal", message: String((err as Error).message) } }, 500);
});

/**
 * Fixtures are anchored to the tenant's CURRENT local date, so the assertions
 * stay meaningful whenever the suite runs (a fixed date would quietly stop
 * testing anything the next day).
 */
const TODAY = zonedParts(new Date(), TZ);
const localAt = (dayOffset: number, hour: number, minute = 0) =>
  zonedTimeToInstant(TZ, TODAY.year, TODAY.month, TODAY.day + dayOffset, hour, minute);

beforeAll(async () => {
  const sql = (db as any).$client;

  // FK targets: bookings.customer_id and riders.user_id both reference user.id.
  await sql.query(
    "INSERT INTO \"user\" (id, name, email, email_verified, role, company_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
    [USER, "Technician", "tds-tech@t.test", true, "rider", WPG_CO],
  );
  await sql.query(
    "INSERT INTO \"user\" (id, name, email, email_verified, role, company_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
    ["tds-cust", "Customer", "tds-cust@t.test", true, "customer", WPG_CO],
  );

  for (const [co, tz, rider] of [
    [WPG_CO, TZ, RIDER_WPG],
    [UTC_CO, "UTC", RIDER_UTC],
  ] as const) {
    await sql.query(
      "INSERT INTO company_settings (id, company_id, timezone) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [`tds-settings-${co}`, co, tz],
    );
    await sql.query(
      "INSERT INTO riders (id, company_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [rider, co, USER],
    );
    await sql.query(
      "INSERT INTO services (id, company_id, name, category, base_price) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [`tds-svc-${co}`, co, "Service", "hvac", 100],
    );

    // Three jobs on the technician's LOCAL day (Aug 11 in Winnipeg):
    //   08:00 completed $120 — before the UTC window opened
    //   14:00 completed $80  — inside both windows
    //   23:30 assigned       — after the UTC window closed
    const jobs: Array<[string, number, number, string, number]> = [
      [`tds-job-morning-${co}`, 8, 0, "completed", 120],
      [`tds-job-midday-${co}`, 14, 0, "completed", 80],
      [`tds-job-late-${co}`, 23, 30, "assigned", 60],
      // and one that belongs to the NEXT local day, which must never count
    ];
    for (const [id, h, m, status, price] of jobs) {
      await sql.query(
        `INSERT INTO bookings
                (id, company_id, customer_id, service_id, title, status, scheduled_at, address, rider_id, price, public_token)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
        [id, co, "tds-cust", `tds-svc-${co}`, "Job", status,
          localAt(0, h, m), "1 Test St", rider, price, `tok-${id}`],
      );
    }
    await sql.query(
      `INSERT INTO bookings
              (id, company_id, customer_id, service_id, title, status, scheduled_at, address, rider_id, price, public_token)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
      [`tds-job-tomorrow-${co}`, co, "tds-cust", `tds-svc-${co}`, "Job", "completed",
        localAt(1, 10, 0), "1 Test St", rider, 500, `tok-tomorrow-${co}`],
    );
  }
  clearCompanyTimeZoneCache();
});

function stats(company: string) {
  return app.request("/bookings/today-stats", {
    headers: { "X-Test-Company": company, "X-Test-User": USER },
  });
}

describe("GET /bookings/today-stats", () => {
  it("is reachable — `/:id` must not swallow it", async () => {
    const res = await stats(WPG_CO);
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    // The `/:id` handler answers {message:"Not found"}; the real one has stats.
    expect(j).toHaveProperty("totalToday");
    expect(j.message).toBeUndefined();
  });

  it("counts the whole local day and nothing from the next one", async () => {
    const j = (await (await stats(WPG_CO)).json()) as any;
    expect(j.totalToday).toBe(3); // 08:00, 14:00, 23:30 local — not tomorrow 10:00
    expect(j.jobsDone).toBe(2);
    expect(j.earnings).toBe(200); // 120 + 80; tomorrow's 500 excluded
    expect(j.activeJobs).toBe(1); // the 23:30 assigned job
  });

  it("a UTC tenant gets a different day — which is exactly what every tenant used to get", async () => {
    const wpg = (await (await stats(WPG_CO)).json()) as any;
    const utc = (await (await stats(UTC_CO)).json()) as any;
    // Identical fixtures, same instant, different configured zone. A UTC day
    // clips one end of the Winnipeg day whatever the hour, so it can only ever
    // see 2 of the 3 local jobs.
    expect(utc.totalToday).toBe(2);
    expect(wpg.totalToday).toBe(3);
  });

  it("a signed-in user who is not a technician gets zeros, not an error", async () => {
    const res = await app.request("/bookings/today-stats", {
      headers: { "X-Test-Company": WPG_CO, "X-Test-User": "tds-not-a-rider" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toMatchObject({ jobsDone: 0, earnings: 0, activeJobs: 0 });
  });
});
