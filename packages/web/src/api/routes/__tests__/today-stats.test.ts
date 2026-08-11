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
import { getTableConfig, type SQLiteColumn } from "drizzle-orm/sqlite-core";

process.env.DATABASE_URL = ":memory:";
process.env.DATABASE_AUTH_TOKEN = "";

const { db } = await import("../../database/index");
const schema = await import("../../database/schema");
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

function ddlFor(table: any): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((col: SQLiteColumn) => {
    const parts = [`"${col.name}"`, col.getSQLType()];
    if (col.primary) parts.push("PRIMARY KEY");
    const dflt = (col as any).default;
    let lit: string | null = null;
    if (dflt !== undefined) {
      lit =
        typeof dflt === "string" ? `'${dflt.replace(/'/g, "''")}'`
        : typeof dflt === "boolean" ? (dflt ? "1" : "0")
        : typeof dflt === "number" ? String(dflt)
        : null;
    }
    if (col.notNull && (lit !== null || col.primary)) parts.push("NOT NULL");
    if (lit !== null) parts.push(`DEFAULT ${lit}`);
    return parts.join(" ");
  });
  return `CREATE TABLE IF NOT EXISTS "${cfg.name}" (${cols.join(", ")})`;
}

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
  for (const t of [
    schema.companySettings, schema.bookings, schema.services, schema.riders,
    schema.user, schema.invoices, schema.serviceZones, schema.properties,
    schema.jobEvents,
  ]) {
    await sql.execute(ddlFor(t));
  }

  for (const [co, tz, rider] of [
    [WPG_CO, TZ, RIDER_WPG],
    [UTC_CO, "UTC", RIDER_UTC],
  ] as const) {
    await sql.execute({
      sql: "INSERT OR IGNORE INTO company_settings (id, company_id, timezone) VALUES (?,?,?)",
      args: [`tds-settings-${co}`, co, tz],
    });
    await sql.execute({
      sql: "INSERT OR IGNORE INTO riders (id, company_id, user_id) VALUES (?,?,?)",
      args: [rider, co, USER],
    });
    await sql.execute({
      sql: "INSERT OR IGNORE INTO services (id, company_id, name, category, base_price) VALUES (?,?,?,?,?)",
      args: [`tds-svc-${co}`, co, "Service", "hvac", 100],
    });

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
      await sql.execute({
        sql: `INSERT OR IGNORE INTO bookings
                (id, company_id, customer_id, service_id, title, status, scheduled_at, address, rider_id, price, public_token)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        args: [id, co, "tds-cust", `tds-svc-${co}`, "Job", status,
          localAt(0, h, m).getTime(), "1 Test St", rider, price, `tok-${id}`],
      });
    }
    await sql.execute({
      sql: `INSERT OR IGNORE INTO bookings
              (id, company_id, customer_id, service_id, title, status, scheduled_at, address, rider_id, price, public_token)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: [`tds-job-tomorrow-${co}`, co, "tds-cust", `tds-svc-${co}`, "Job", "completed",
        localAt(1, 10, 0).getTime(), "1 Test St", rider, 500, `tok-tomorrow-${co}`],
    });
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
