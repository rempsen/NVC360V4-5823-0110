/**
 * The driver's status flow and the geofenced on-site clock — the two things a
 * technician's pay, the dispatcher's board and the customer's tracking link all
 * read from.
 *
 * Three real field bugs are pinned here:
 *
 * 1. SKIPPED ARRIVAL. `POST /bookings/:id/status` accepted any status string.
 *    A driver (or a retried request) could go enroute -> completed: transit
 *    time never finalised, on-site clock never started, and the customer never
 *    got the "your technician is here" notification — the job was simply
 *    closed from the van. The reverse (completed -> enroute) re-fired the
 *    on-my-way SMS on already-billed work.
 *
 * 2. MANUAL ARRIVAL PAUSED ITSELF. Tapping "I've Arrived" set
 *    `inside_geofence = 1` as though GPS had confirmed it. The next ping, 8
 *    seconds later, saw the tech outside the radius and paused their clock —
 *    "you've stepped away" while standing in the customer's building. Anyone
 *    parking further from the geocoded pin than the radius lost paid on-site
 *    time.
 *
 * 3. EXIT DETECTION DIED AFTER A MANUAL ARRIVAL. `resumeClock` returned early
 *    when the clock was already running, so re-entering the radius never set
 *    `inside_geofence`. Leaving the site was then never detected and the clock
 *    kept billing after the tech drove away.
 *
 * Harness: shared local Postgres (see ../../database/__tests__/setup.ts),
 * full drizzle migration applied once per process, ids prefixed "sfc-". No
 * notification rules are seeded, so fireEvent resolves zero recipients and
 * sends nothing.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import { ensureSchema } from "../../database/__tests__/setup";

await ensureSchema();

const { db } = await import("../../database/index");
const { bookingsRoutes } = await import("../bookings");
const { pauseClock, resumeClock, applyBookingStatus, StatusTransitionError } = await import(
  "../../../services/booking-status"
);
const { AppError } = await import("../../lib/errors");

const CO = "sfc-co";
const TECH_USER = "sfc-user-tech";
const ADMIN_USER = "sfc-user-admin";
const CUST = "sfc-cust";
const RIDER = "sfc-rider";
const SVC = "sfc-svc";

const app = new Hono().use("*", async (c, next) => {
  c.set("companyId", CO);
  const uid = c.req.header("X-Test-User");
  const role = c.req.header("X-Test-Role") || "rider";
  c.set("user", uid ? { id: uid, role, email: `${uid}@t.test`, name: uid } : null);
  return next();
});
app.route("/bookings", bookingsRoutes);
app.onError((err, c) => {
  if (err instanceof AppError)
    return c.json({ error: { code: err.code, message: err.expose ? err.message : "error" } }, err.status as 400);
  return c.json({ error: { code: "internal", message: String((err as Error).message) } }, 500);
});

const sqlClient = () => (db as any).$client;

async function seedJob(opts: {
  id: string;
  status: string;
  clockState?: string;
  insideGeofence?: boolean;
  startedAt?: number | null;
  enrouteAt?: number | null;
  accumulatedMs?: number;
}) {
  const s = sqlClient();
  const d = (ms: number | null) => (ms === null ? null : new Date(ms));
  await s.query("DELETE FROM bookings WHERE id = $1", [opts.id]);
  await s.query(
    `INSERT INTO bookings
            (id, company_id, customer_id, service_id, title, status, assign_status, scheduled_at,
             address, lat, lng, rider_id, price, public_token, enroute_at, started_at, clock_state,
             last_resume_at, inside_geofence, accumulated_ms, on_site_minutes, mileage_km)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [
      opts.id, CO, CUST, SVC, "Rooftop unit service", opts.status, "accepted",
      d(Date.now() + 3_600_000), "1 Test Plaza", 43.6532, -79.3832, RIDER, 250, `sfc-tok-${opts.id}`,
      opts.enrouteAt === undefined ? d(Date.now() - 1_800_000) : d(opts.enrouteAt),
      opts.startedAt === undefined ? null : d(opts.startedAt),
      opts.clockState ?? "idle",
      opts.clockState === "running" ? d(Date.now() - 60_000) : null,
      !!opts.insideGeofence,
      opts.accumulatedMs ?? 0, 0, 0,
    ],
  );
}

async function row(id: string) {
  const r = await sqlClient().query("SELECT * FROM bookings WHERE id = $1", [id]);
  return r.rows[0] as any;
}

function setStatus(id: string, status: string, role = "rider", user = TECH_USER) {
  return app.request(`/bookings/${id}/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Test-User": user,
      "X-Test-Role": role,
    },
    body: JSON.stringify({ status }),
  });
}

beforeAll(async () => {
  const s = sqlClient();
  for (const [id, name, role] of [
    [TECH_USER, "Field Tech", "rider"],
    [ADMIN_USER, "Office", "admin"],
    [CUST, "Customer", "customer"],
  ] as const) {
    await s.query(
      `INSERT INTO "user" (id, company_id, name, email, role, email_verified) VALUES ($1,$2,$3,$4,$5,false) ON CONFLICT DO NOTHING`,
      [id, CO, name, `${id}@t.test`, role],
    );
  }
  await s.query(
    "INSERT INTO riders (id, company_id, user_id, status) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    [RIDER, CO, TECH_USER, "enroute"],
  );
  await s.query(
    "INSERT INTO services (id, company_id, name, category, base_price) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [SVC, CO, "Rooftop unit service", "hvac", 250],
  );
});

describe("POST /bookings/:id/status — stage guard", () => {
  it("refuses to complete a job the tech never arrived at, and says why", async () => {
    await seedJob({ id: "sfc-skip", status: "enroute" });
    const res = await setStatus("sfc-skip", "completed");
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.message.toLowerCase()).toContain("arrived");
    // and the record did not move
    expect((await row("sfc-skip")).status).toBe("enroute");
  });

  it("refuses to reopen a completed job", async () => {
    await seedJob({ id: "sfc-reopen", status: "completed" });
    const res = await setStatus("sfc-reopen", "enroute");
    expect(res.status).toBe(409);
    expect((await row("sfc-reopen")).status).toBe("completed");
  });

  it("still walks the normal flow through arrival", async () => {
    await seedJob({ id: "sfc-flow", status: "assigned", enrouteAt: null });
    expect((await setStatus("sfc-flow", "enroute")).status).toBe(200);
    expect((await setStatus("sfc-flow", "arrived")).status).toBe(200);
    expect((await setStatus("sfc-flow", "completed")).status).toBe(200);
    const b = await row("sfc-flow");
    expect(b.status).toBe("completed");
    // arrival happened, so drive time was finalised and the clock ran
    expect(b.started_at).not.toBeNull();
    expect(b.transit_minutes).toBeGreaterThanOrEqual(0);
    expect(b.finished_at).not.toBeNull();
  });

  it("does not error on a retried request that repeats the current status", async () => {
    await seedJob({ id: "sfc-retry", status: "enroute" });
    expect((await setStatus("sfc-retry", "enroute")).status).toBe(200);
  });

  it("lets the office correct a record the field app is not allowed to", async () => {
    await seedJob({ id: "sfc-force", status: "completed" });
    const res = await setStatus("sfc-force", "enroute", "admin", ADMIN_USER);
    expect(res.status).toBe(200);
    expect((await row("sfc-force")).status).toBe("enroute");
  });

  it("throws a typed error the route can turn into a message", async () => {
    await seedJob({ id: "sfc-typed", status: "enroute" });
    let caught: unknown = null;
    try {
      await applyBookingStatus(CO, "sfc-typed", "completed");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StatusTransitionError);
    expect((caught as InstanceType<typeof StatusTransitionError>).from).toBe("enroute");
  });
});

describe("on-site clock vs the geofence", () => {
  it("starts the clock on a manual arrival WITHOUT claiming GPS saw the tech on site", async () => {
    await seedJob({ id: "sfc-manual", status: "enroute" });
    expect((await setStatus("sfc-manual", "arrived")).status).toBe(200);
    const b = await row("sfc-manual");
    expect(b.clock_state).toBe("running");
    // The bug: this used to be 1, so the very next ping paused the clock.
    expect(b.inside_geofence).toBe(false);
  });

  it("marks the geofence flag when the arrival came FROM the geofence", async () => {
    await seedJob({ id: "sfc-auto", status: "enroute" });
    await applyBookingStatus(CO, "sfc-auto", "arrived", { byGeofence: true });
    const b = await row("sfc-auto");
    expect(b.clock_state).toBe("running");
    expect(b.inside_geofence).toBe(true);
  });

  it("does not pause a manually-arrived tech who GPS has never seen inside the radius", async () => {
    await seedJob({ id: "sfc-nopause", status: "enroute" });
    await setStatus("sfc-nopause", "arrived");
    // pauseClock is only ever called on `!inside && insideGeofence`; with the
    // flag correctly false that branch cannot fire. Prove the state is the one
    // that keeps the tech's clock running.
    const b = await row("sfc-nopause");
    expect(b.inside_geofence).toBe(false);
    expect(b.clock_state).toBe("running");
  });

  it("reconciles the geofence flag when the tech later drives into the radius", async () => {
    await seedJob({ id: "sfc-late", status: "arrived", clockState: "running", insideGeofence: false });
    await resumeClock(CO, "sfc-late");
    // Used to early-return and leave this at 0, which killed exit detection for
    // the rest of the job.
    expect((await row("sfc-late")).inside_geofence).toBe(true);
  });

  it("then detects the tech leaving and banks the time", async () => {
    await seedJob({ id: "sfc-leave", status: "arrived", clockState: "running", insideGeofence: true });
    await pauseClock(CO, "sfc-leave");
    const b = await row("sfc-leave");
    expect(b.clock_state).toBe("paused");
    expect(b.inside_geofence).toBe(false);
    expect(Number(b.accumulated_ms)).toBeGreaterThan(0);
  });

  it("does not restart the clock (or lose banked time) when resume is called twice", async () => {
    await seedJob({ id: "sfc-twice", status: "arrived", clockState: "running", insideGeofence: true, accumulatedMs: 90_000 });
    const before = await row("sfc-twice");
    await resumeClock(CO, "sfc-twice");
    const after = await row("sfc-twice");
    expect(after.clock_state).toBe("running");
    expect(Number(after.accumulated_ms)).toBe(Number(before.accumulated_ms));
    expect(Number(after.last_resume_at)).toBe(Number(before.last_resume_at));
  });
});
