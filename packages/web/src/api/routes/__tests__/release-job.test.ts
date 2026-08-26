/**
 * POST /api/bookings/:id/release — a tech handing back a job they ACCEPTED —
 * and the authorization hole that used to sit on POST /:id/cancel.
 *
 * Why this exists:
 *
 * 1. RELEASE. Before this, a tech could only Decline, and only while the job was
 *    still "offered". The moment they tapped Accept there was no way out in the
 *    app: van breaks down, family emergency, running two hours late — the job
 *    stayed pinned to them and the office found out by phone, if at all. Release
 *    returns the job to the dispatch queue UNASSIGNED (status confirmed,
 *    rider_id null, assign_status released) with a required reason, frees the
 *    tech, and notifies the office. The customer is deliberately told nothing —
 *    the office owns that conversation.
 *
 * 2. CANCEL AUTHZ. POST /:id/cancel was guarded by `requireAuth` alone, which
 *    only checks that *somebody* is signed in. Any signed-in user in the tenant
 *    — a tech, or a customer passing another customer's booking id — could
 *    cancel a work order that wasn't theirs. It now requires office role or
 *    ownership.
 *
 * Harness: shared local Postgres (see ../../database/__tests__/setup.ts),
 * full drizzle migration applied once per process, ids prefixed "rel-". No
 * notification rules are seeded, so fireEvent resolves zero recipients and
 * sends nothing.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { ensureSchema } from "../../database/__tests__/setup";

await ensureSchema();

const { db } = await import("../../database/index");
const { bookingsRoutes } = await import("../bookings");
const { AppError } = await import("../../lib/errors");

const CO = "rel-co";
const HOLDER_USER = "rel-user-holder";
const OTHER_USER = "rel-user-other";
const ADMIN_USER = "rel-user-admin";
const CUST = "rel-cust";
const CUST2 = "rel-cust2";
const HOLDER_RIDER = "rel-rider-holder";
const OTHER_RIDER = "rel-rider-other";
const SVC = "rel-svc";

const app = new Hono().use("*", async (c, next) => {
  c.set("companyId", c.req.header("X-Test-Company") || CO);
  const uid = c.req.header("X-Test-User");
  const role = c.req.header("X-Test-Role") || "rider";
  c.set("user", uid ? { id: uid, role, email: `${uid}@t.test`, name: uid } : null);
  return next();
});
app.route("/bookings", bookingsRoutes);
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.expose ? err.message : "error" } }, err.status as 400);
  }
  return c.json({ error: { code: "internal", message: String((err as Error).message) } }, 500);
});

const sqlClient = () => (db as any).$client;

/** A fresh job in a given state, assigned to HOLDER_RIDER unless told otherwise. */
async function seedJob(opts: {
  id: string;
  status: string;
  assignStatus?: string;
  riderId?: string | null;
  customerId?: string;
}) {
  const s = sqlClient();
  await s.query("DELETE FROM bookings WHERE id = $1", [opts.id]);
  await s.query(
    `INSERT INTO bookings
            (id, company_id, customer_id, service_id, title, status, assign_status, scheduled_at,
             address, rider_id, price, public_token, enroute_at, started_at, clock_state,
             on_site_minutes, mileage_km, eta_mins)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      opts.id, CO, opts.customerId ?? CUST, SVC, "Furnace repair", opts.status,
      opts.assignStatus ?? "accepted", new Date(Date.now() + 3_600_000), "1 Test St",
      opts.riderId === undefined ? HOLDER_RIDER : opts.riderId, 250, `tok-${opts.id}`,
      new Date(Date.now() - 1_800_000), new Date(Date.now() - 600_000), "running", 12, 8.4, 14,
    ],
  );
}

async function row(id: string) {
  const r = await sqlClient().query("SELECT * FROM bookings WHERE id = $1", [id]);
  return r.rows[0] as any;
}

async function riderStatus(id: string) {
  const r = await sqlClient().query("SELECT status FROM riders WHERE id = $1", [id]);
  return (r.rows[0] as any)?.status as string;
}

function release(
  id: string,
  user: string,
  body: Record<string, unknown>,
  role = "rider",
) {
  return app.request(`/bookings/${id}/release`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Test-Company": CO,
      "X-Test-User": user,
      "X-Test-Role": role,
    },
    body: JSON.stringify(body),
  });
}

function cancel(id: string, user: string, role = "customer") {
  return app.request(`/bookings/${id}/cancel`, {
    method: "POST",
    headers: { "X-Test-Company": CO, "X-Test-User": user, "X-Test-Role": role },
  });
}

beforeAll(async () => {
  const s = sqlClient();
  // NOTE: deliberately no `companies` row. Postgres is shared across test
  // files in one process, and tenant.test.ts asserts the exact company
  // registry — a fixture company here would break it. Nothing under test
  // reads the name.
  for (const [id, name, role] of [
    [HOLDER_USER, "Holder Tech", "rider"],
    [OTHER_USER, "Other Tech", "rider"],
    [ADMIN_USER, "Office", "admin"],
    [CUST, "Customer One", "customer"],
    [CUST2, "Customer Two", "customer"],
  ] as const) {
    await s.query(
      `INSERT INTO "user" (id, company_id, name, email, role, email_verified) VALUES ($1,$2,$3,$4,$5,false) ON CONFLICT DO NOTHING`,
      [id, CO, name, `${id}@t.test`, role],
    );
  }
  for (const [rid, uid] of [
    [HOLDER_RIDER, HOLDER_USER],
    [OTHER_RIDER, OTHER_USER],
  ] as const) {
    await s.query(
      "INSERT INTO riders (id, company_id, user_id, status) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [rid, CO, uid, "onsite"],
    );
  }
  await s.query(
    "INSERT INTO services (id, company_id, name, category, base_price) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [SVC, CO, "Furnace repair", "hvac", 250],
  );
});

beforeEach(async () => {
  await sqlClient().query(
    // fresh GPS heartbeat: presence downgrades a tech with a stale device to
    // "offline" regardless of jobs, so without this the freed-tech assertion
    // would be testing liveness, not the release.
    "UPDATE riders SET status = 'onsite', location_updated_at = $1 WHERE company_id = $2",
    [new Date(), CO],
  );
});

describe("POST /bookings/:id/release", () => {
  it("returns an accepted job to the dispatch queue, unassigned, with the reason on the record", async () => {
    await seedJob({ id: "rel-job-1", status: "in_progress" });
    const res = await release("rel-job-1", HOLDER_USER, {
      reason: "vehicle",
      note: "brake line blew on the highway",
    });
    expect(res.status).toBe(200);
    const b = await row("rel-job-1");
    expect(b.rider_id).toBeNull();
    expect(b.status).toBe("confirmed");
    expect(b.assign_status).toBe("released");
    expect(b.decline_reason).toBe("Vehicle breakdown — brake line blew on the highway");
    // the trip that just ended must not bleed into the next tech's drive/clock
    expect(b.enroute_at).toBeNull();
    expect(b.started_at).toBeNull();
    expect(b.clock_state).toBe("idle");
    expect(b.eta_mins).toBeNull();
    // work already done stays on the record for the office to settle pay
    expect(b.on_site_minutes).toBe(12);
    expect(b.mileage_km).toBeCloseTo(8.4, 5);
  });

  it("frees the tech so dispatch can hand them something else", async () => {
    await seedJob({ id: "rel-job-2", status: "enroute" });
    expect(await riderStatus(HOLDER_RIDER)).toBe("onsite");
    const res = await release("rel-job-2", HOLDER_USER, { reason: "emergency" });
    expect(res.status).toBe(200);
    expect(await riderStatus(HOLDER_RIDER)).toBe("available");
  });

  it("works at every stage a tech can be at — arrived and assigned included", async () => {
    for (const status of ["assigned", "arrived", "onsite", "paused"]) {
      await seedJob({ id: `rel-stage-${status}`, status });
      const res = await release(`rel-stage-${status}`, HOLDER_USER, { reason: "running_late" });
      expect(res.status).toBe(200);
      expect((await row(`rel-stage-${status}`)).rider_id).toBeNull();
    }
  });

  it("refuses a tech who isn't the one holding the job", async () => {
    await seedJob({ id: "rel-job-3", status: "arrived" });
    const res = await release("rel-job-3", OTHER_USER, { reason: "other" });
    expect(res.status).toBe(403);
    const b = await row("rel-job-3");
    expect(b.rider_id).toBe(HOLDER_RIDER);
    expect(b.status).toBe("arrived");
  });

  it("lets the office release on a tech's behalf (phone call to dispatch)", async () => {
    await seedJob({ id: "rel-job-4", status: "enroute" });
    const res = await release("rel-job-4", ADMIN_USER, { reason: "emergency" }, "admin");
    expect(res.status).toBe(200);
    expect((await row("rel-job-4")).rider_id).toBeNull();
  });

  it("sends an un-accepted offer down the decline path instead", async () => {
    await seedJob({ id: "rel-job-5", status: "assigned", assignStatus: "offered" });
    const res = await release("rel-job-5", HOLDER_USER, { reason: "other" });
    expect(res.status).toBe(409);
    expect((await row("rel-job-5")).rider_id).toBe(HOLDER_RIDER);
  });

  it("won't release a finished or cancelled job", async () => {
    for (const status of ["completed", "cancelled"]) {
      await seedJob({ id: `rel-dead-${status}`, status });
      const res = await release(`rel-dead-${status}`, HOLDER_USER, { reason: "other" });
      expect(res.status).toBe(409);
      expect((await row(`rel-dead-${status}`)).status).toBe(status);
    }
  });

  it("requires a real reason — no silent hand-back", async () => {
    await seedJob({ id: "rel-job-6", status: "in_progress" });
    for (const body of [{}, { reason: "" }, { reason: "because" }]) {
      const res = await release("rel-job-6", HOLDER_USER, body);
      expect(res.status).toBe(400);
    }
    expect((await row("rel-job-6")).rider_id).toBe(HOLDER_RIDER);
  });

  it("keeps the release out of the customer's view of the job", async () => {
    await seedJob({ id: "rel-job-7", status: "enroute" });
    await release("rel-job-7", HOLDER_USER, { reason: "unsafe_site", note: "dog off leash" });
    const ev = await sqlClient().query("SELECT kind, customer_visible, detail FROM job_events WHERE booking_id = $1", ["rel-job-7"]);
    const released = (ev.rows as any[]).find((r) => r.kind === "released");
    expect(released).toBeTruthy();
    expect(Number(released.customer_visible)).toBe(0);
    expect(String(released.detail)).toContain("Unsafe site conditions");
  });
});

describe("POST /bookings/:id/cancel authorization", () => {
  it("refuses a customer poking at someone else's work order", async () => {
    await seedJob({ id: "rel-cancel-1", status: "assigned", customerId: CUST });
    const res = await cancel("rel-cancel-1", CUST2);
    expect(res.status).toBe(403);
    expect((await row("rel-cancel-1")).status).toBe("assigned");
  });

  it("refuses a tech — dropping a job is a release, not a cancellation", async () => {
    await seedJob({ id: "rel-cancel-2", status: "enroute", customerId: CUST });
    const res = await cancel("rel-cancel-2", HOLDER_USER, "rider");
    expect(res.status).toBe(403);
    expect((await row("rel-cancel-2")).status).toBe("enroute");
  });

  // Superseded on purpose (Aug 2026): the owning customer used to get a 200 and
  // the job went straight to "cancelled". A job can no longer leave the dispatch
  // board without the office deciding it should — the customer now files a
  // request instead. See __tests__/change-requests.test.ts for the full flow.
  it("no longer lets even the owning customer hard-cancel — it becomes an office request", async () => {
    await seedJob({ id: "rel-cancel-3", status: "assigned", customerId: CUST });
    const res = await cancel("rel-cancel-3", CUST);
    expect(res.status).toBe(409);
    expect((await res.json()).useEndpoint).toBe("/api/bookings/rel-cancel-3/cancel-request");
    expect((await row("rel-cancel-3")).status).toBe("assigned");
  });

  it("still lets the office cancel anything in the tenant", async () => {
    await seedJob({ id: "rel-cancel-4", status: "assigned", customerId: CUST2 });
    const res = await cancel("rel-cancel-4", ADMIN_USER, "admin");
    expect(res.status).toBe(200);
    expect((await row("rel-cancel-4")).status).toBe("cancelled");
  });
});
