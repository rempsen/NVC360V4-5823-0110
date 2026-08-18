/**
 * The office side of the product: dispatching a job, moving an appointment, and
 * paying a technician. Six real bugs are pinned here.
 *
 * 1. ASSIGN HAD NO GUARD. `/accept`, `/decline` and `/release` all compare-and-set;
 *    `POST /bookings/:id/assign` did not. It unconditionally wrote
 *    status="assigned", assignStatus="offered", acceptedAt=null. Assigning (or
 *    mis-clicking) on a job a tech was driving to, standing on site at, or had
 *    already finished silently reset it to an un-accepted offer — the tech's app
 *    lost the job mid-work, and a completed job reappeared on the board. A bad id
 *    also reached `enrich(undefined)`.
 *
 * 2. RESCHEDULE TOLD NOBODY. A `rescheduled` notification exists and is enabled by
 *    default for client (email), tech (SMS) and office — but only the
 *    customer-initiated change-request flow ever fired it. When a dispatcher moved
 *    a job on the calendar, the tech's phone kept showing the old time and the
 *    customer was never told. That is a missed appointment.
 *
 * 3. RESCHEDULE REWROTE HISTORY. `/schedule` accepted any booking, including a
 *    completed or cancelled one. Since revenue reports and payout periods are
 *    selected by `scheduled_at`, dragging a finished job moved money between
 *    reporting periods.
 *
 * 4. TECHS WERE PAID A PERCENTAGE OF SALES TAX. Payout gross summed `b.price`,
 *    which billing.ts sets to `total` = subtotal + tax. On a $1,000 Ontario job at
 *    13% the tech's 80% was taken on $1,130, so $104 of collected HST — money owed
 *    to the government — went out as pay on every $1,000 invoiced.
 *
 * 5. PAYOUTS COULD BE GENERATED TWICE. Nothing linked a booking to the payout that
 *    covered it, so re-running a period (or overlapping two) produced a second
 *    payout row for the same completed jobs. Double pay.
 *
 * 6. "MARK PAID" HAD NO GUARD. No compare-and-set on status, and no 404: a
 *    double-click re-stamped `paid_at` and wrote a second "paid" audit entry, and a
 *    stale id logged `Marked payout paid ($undefined)` with a 200.
 *
 * Plus an access-control hole: `GET /payouts` and `GET /reports/:report` were
 * `requireAuth`, so any signed-in technician could read every tech's pay, the
 * company's margins and its receivables.
 *
 * Harness: ephemeral in-memory libsql, ids prefixed "dap-". No notification rules
 * are seeded, so fireEvent resolves zero recipients and sends no SMS or email —
 * only the job-events timeline row it writes is observable.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import { getTableConfig, type SQLiteColumn } from "drizzle-orm/sqlite-core";

process.env.DATABASE_URL = ":memory:";
process.env.DATABASE_AUTH_TOKEN = "";

const { db } = await import("../../database/index");
const schema = await import("../../database/schema");
const { bookingsRoutes } = await import("../bookings");
const { payoutsRoutes } = await import("../payouts");
const { reportsRoutes } = await import("../reports");
const { AppError } = await import("../../lib/errors");

const CO = "dap-co";
const TECH_USER = "dap-user-tech";
const TECH2_USER = "dap-user-tech2";
const ADMIN_USER = "dap-user-admin";
const CUST = "dap-cust";
const RIDER = "dap-rider";
const RIDER2 = "dap-rider2";
const SVC = "dap-svc";

const app = new Hono().use("*", async (c, next) => {
  c.set("companyId", CO);
  const uid = c.req.header("X-Test-User");
  const role = c.req.header("X-Test-Role") || "rider";
  c.set("user", uid ? { id: uid, role, email: `${uid}@t.test`, name: uid } : null);
  return next();
});
app.route("/bookings", bookingsRoutes);
app.route("/payouts", payoutsRoutes);
app.route("/reports", reportsRoutes);
app.onError((err, c) => {
  if (err instanceof AppError)
    return c.json(
      { error: { code: err.code, message: err.expose ? err.message : "error" }, message: err.message },
      err.status as 400,
    );
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

const sqlClient = () => (db as any).$client;

async function seedJob(opts: {
  id: string;
  status: string;
  assignStatus?: string;
  riderId?: string | null;
  scheduledAt?: number;
  subtotal?: number;
  taxAmount?: number;
  paymentStatus?: string;
  clockState?: string;
  insideGeofence?: boolean;
}) {
  const s = sqlClient();
  const subtotal = opts.subtotal ?? 250;
  const tax = opts.taxAmount ?? 0;
  await s.execute({ sql: "DELETE FROM bookings WHERE id = ?", args: [opts.id] });
  await s.execute({
    sql: `INSERT INTO bookings
            (id, company_id, customer_id, service_id, title, status, assign_status, scheduled_at,
             address, lat, lng, rider_id, price, subtotal, tax_amount, total, payment_status,
             public_token, enroute_at, started_at, accepted_at, clock_state, last_resume_at,
             inside_geofence, accumulated_ms, on_site_minutes, mileage_km)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      opts.id, CO, CUST, SVC, "Rooftop unit service", opts.status,
      opts.assignStatus ?? "accepted",
      opts.scheduledAt ?? Date.now() + 3_600_000,
      "1 Test Plaza", 43.6532, -79.3832,
      opts.riderId === undefined ? RIDER : opts.riderId,
      subtotal + tax, subtotal, tax, subtotal + tax,
      opts.paymentStatus ?? "unpaid",
      `dap-tok-${opts.id}`,
      opts.status === "enroute" || opts.status === "arrived" ? Date.now() - 1_800_000 : null,
      opts.status === "arrived" ? Date.now() - 600_000 : null,
      opts.assignStatus === "accepted" || opts.assignStatus === undefined ? Date.now() - 3_600_000 : null,
      opts.clockState ?? "idle",
      opts.clockState === "running" ? Date.now() - 60_000 : null,
      opts.insideGeofence ? 1 : 0,
      0, 0, 0,
    ],
  });
}

async function row(id: string) {
  const r = await sqlClient().execute({ sql: "SELECT * FROM bookings WHERE id = ?", args: [id] });
  return r.rows[0] as any;
}

function req(path: string, opts: { method?: string; role?: string; user?: string; json?: unknown } = {}) {
  return app.request(path, {
    method: opts.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Test-User": opts.user ?? ADMIN_USER,
      "X-Test-Role": opts.role ?? "admin",
    },
    body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
  });
}

const assign = (id: string, riderId: string, extra: Record<string, unknown> = {}, role = "admin") =>
  req(`/bookings/${id}/assign`, { method: "POST", role, json: { riderId, ...extra } });

const reschedule = (id: string, scheduledAt: number) =>
  req(`/bookings/${id}/schedule`, { method: "POST", json: { scheduledAt } });

async function events(bookingId: string, kind: string) {
  const r = await sqlClient().execute({
    sql: "SELECT * FROM job_events WHERE booking_id = ? AND kind = ?",
    args: [bookingId, kind],
  });
  return r.rows as any[];
}

beforeAll(async () => {
  const s = sqlClient();
  for (const t of [
    schema.companySettings, schema.bookings, schema.services, schema.riders,
    schema.user, schema.invoices, schema.serviceZones, schema.properties, schema.jobEvents,
    schema.notificationRules, schema.notifications, schema.notificationDeliveries,
    schema.webhookEndpoints, schema.automationRules, schema.reviews,
    schema.notificationChannels, schema.trackingPings, schema.memberships,
    schema.scheduledTasks, schema.payouts, schema.auditLog, schema.catalogItems,
  ]) {
    await s.execute(ddlFor(t));
  }
  for (const [id, name, role] of [
    [TECH_USER, "Field Tech", "rider"],
    [TECH2_USER, "Second Tech", "rider"],
    [ADMIN_USER, "Office", "admin"],
    [CUST, "Customer", "customer"],
  ] as const) {
    await s.execute({
      sql: "INSERT OR IGNORE INTO user (id, company_id, name, email, role, email_verified) VALUES (?,?,?,?,?,0)",
      args: [id, CO, name, `${id}@t.test`, role],
    });
  }
  for (const [rid, uid] of [[RIDER, TECH_USER], [RIDER2, TECH2_USER]] as const) {
    await s.execute({
      sql: "INSERT OR IGNORE INTO riders (id, company_id, user_id, status) VALUES (?,?,?,?)",
      args: [rid, CO, uid, "available"],
    });
  }
  await s.execute({
    sql: "INSERT OR IGNORE INTO services (id, company_id, name, category, base_price) VALUES (?,?,?,?,?)",
    args: [SVC, CO, "Rooftop unit service", "hvac", 250],
  });
});

// ---------------------------------------------------------------------------
// 1. Assign guard
// ---------------------------------------------------------------------------

describe("POST /bookings/:id/assign — dispatch guard", () => {
  it("still assigns a job that is waiting for a tech", async () => {
    await seedJob({ id: "dap-fresh", status: "confirmed", assignStatus: "", riderId: null });
    const res = await assign("dap-fresh", RIDER);
    expect(res.status).toBe(200);
    const b = await row("dap-fresh");
    expect(b.rider_id).toBe(RIDER);
    expect(b.status).toBe("assigned");
    expect(b.assign_status).toBe("offered");
  });

  it("404s on an unknown work order instead of blowing up", async () => {
    const res = await assign("dap-nope", RIDER);
    expect(res.status).toBe(404);
  });

  it("refuses to re-dispatch a completed job", async () => {
    await seedJob({ id: "dap-done", status: "completed" });
    const res = await assign("dap-done", RIDER2);
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.message.toLowerCase()).toContain("completed");
    const b = await row("dap-done");
    expect(b.status).toBe("completed");
    expect(b.rider_id).toBe(RIDER);
  });

  it("refuses to re-dispatch a cancelled job", async () => {
    await seedJob({ id: "dap-cxl", status: "cancelled" });
    expect((await assign("dap-cxl", RIDER2)).status).toBe(409);
    expect((await row("dap-cxl")).status).toBe("cancelled");
  });

  it("will not silently pull a job out from under a tech who is on site", async () => {
    await seedJob({ id: "dap-onsite", status: "arrived", clockState: "running", insideGeofence: true });
    const res = await assign("dap-onsite", RIDER2);
    expect(res.status).toBe(409);
    const b = await row("dap-onsite");
    expect(b.status).toBe("arrived");
    expect(b.rider_id).toBe(RIDER);
    expect(b.clock_state).toBe("running");
  });

  it("lets the office reassign an in-flight job when it explicitly confirms, and resets the job cleanly", async () => {
    await seedJob({ id: "dap-force", status: "enroute", clockState: "running", insideGeofence: true });
    const res = await assign("dap-force", RIDER2, { force: true });
    expect(res.status).toBe(200);
    const b = await row("dap-force");
    expect(b.rider_id).toBe(RIDER2);
    expect(b.status).toBe("assigned");
    expect(b.assign_status).toBe("offered");
    expect(b.accepted_at).toBeNull();
    // the new tech must not inherit the old tech's drive/on-site state
    expect(b.enroute_at).toBeNull();
    expect(b.started_at).toBeNull();
    expect(b.clock_state).toBe("idle");
    expect(Number(b.inside_geofence)).toBe(0);
  });

  it("does not wipe an acceptance by re-offering the job to the tech who already accepted it", async () => {
    await seedJob({ id: "dap-same", status: "assigned", assignStatus: "accepted" });
    const before = await row("dap-same");
    const res = await assign("dap-same", RIDER);
    expect(res.status).toBe(409);
    const after = await row("dap-same");
    expect(after.assign_status).toBe("accepted");
    expect(after.accepted_at).toBe(before.accepted_at);
  });

  it("is office-only — a technician cannot dispatch work to themselves", async () => {
    await seedJob({ id: "dap-self", status: "confirmed", assignStatus: "", riderId: null });
    const res = await assign("dap-self", RIDER, {}, "rider");
    expect(res.status).toBe(403);
    expect((await row("dap-self")).rider_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Reschedule
// ---------------------------------------------------------------------------

describe("POST /bookings/:id/schedule — moving an appointment", () => {
  it("tells the tech and the customer that the time moved", async () => {
    await seedJob({ id: "dap-move", status: "assigned" });
    const when = Date.now() + 3 * 86_400_000;
    const res = await reschedule("dap-move", when);
    expect(res.status).toBe(200);
    expect(Number((await row("dap-move")).scheduled_at)).toBe(when);
    expect((await events("dap-move", "rescheduled")).length).toBe(1);
  });

  it("does not announce a reschedule when the time did not actually change", async () => {
    const when = Date.now() + 4 * 86_400_000;
    await seedJob({ id: "dap-same-time", status: "assigned", scheduledAt: when });
    expect((await reschedule("dap-same-time", when)).status).toBe(200);
    expect((await events("dap-same-time", "rescheduled")).length).toBe(0);
  });

  it("refuses to move a completed job into another reporting period", async () => {
    await seedJob({ id: "dap-move-done", status: "completed" });
    const original = Number((await row("dap-move-done")).scheduled_at);
    const res = await reschedule("dap-move-done", Date.now() + 30 * 86_400_000);
    expect(res.status).toBe(409);
    expect(Number((await row("dap-move-done")).scheduled_at)).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// 3. Payouts — the money
// ---------------------------------------------------------------------------

async function payoutRows() {
  const r = await sqlClient().execute("SELECT * FROM payouts ORDER BY created_at");
  return r.rows as any[];
}

describe("POST /payouts/generate — tech pay", () => {
  const start = Date.now() - 10 * 86_400_000;
  const end = Date.now() - 1 * 86_400_000;
  const mid = Date.now() - 5 * 86_400_000;

  it("pays the tech on the pre-tax value of the work, not on the sales tax", async () => {
    await sqlClient().execute("DELETE FROM payouts");
    await seedJob({
      id: "dap-pay1", status: "completed", paymentStatus: "paid",
      scheduledAt: mid, subtotal: 1000, taxAmount: 130,
    });
    const res = await req("/payouts/generate", {
      method: "POST",
      json: { periodStart: start, periodEnd: end, feePct: 20 },
    });
    expect(res.status).toBe(201);
    const rows = await payoutRows();
    expect(rows.length).toBe(1);
    expect(rows[0].gross).toBe(1000);
    expect(rows[0].fee).toBe(200);
    expect(rows[0].net).toBe(800);
  });

  it("will not pay the same job twice when the period is generated again", async () => {
    const res = await req("/payouts/generate", {
      method: "POST",
      json: { periodStart: start, periodEnd: end, feePct: 20 },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).created).toBe(0);
    expect((await payoutRows()).length).toBe(1);
  });

  it("will not pay the same job twice through an overlapping period either", async () => {
    const res = await req("/payouts/generate", {
      method: "POST",
      json: { periodStart: start - 5 * 86_400_000, periodEnd: end + 0, feePct: 20 },
    });
    expect(((await res.json()) as any).created).toBe(0);
    expect((await payoutRows()).length).toBe(1);
  });

  it("still picks up a job that was completed late and never paid out", async () => {
    await seedJob({
      id: "dap-pay-late", status: "completed", paymentStatus: "paid",
      scheduledAt: mid, subtotal: 500, taxAmount: 65,
    });
    const res = await req("/payouts/generate", {
      method: "POST",
      json: { periodStart: start, periodEnd: end, feePct: 20 },
    });
    expect(((await res.json()) as any).created).toBe(1);
    const rows = await payoutRows();
    expect(rows.length).toBe(2);
    expect(rows[1].gross).toBe(500);
    expect(rows[1].net).toBe(400);
  });
});

describe("POST /payouts/:id/pay — marking a payout paid", () => {
  it("404s on an unknown payout instead of logging a $undefined payment", async () => {
    const res = await req("/payouts/dap-ghost/pay", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("refuses a second payment on a payout that is already paid", async () => {
    const [p] = await payoutRows();
    const first = await req(`/payouts/${p.id}/pay`, { method: "POST" });
    expect(first.status).toBe(200);
    const paidAt = (await payoutRows()).find((x) => x.id === p.id)!.paid_at;
    const second = await req(`/payouts/${p.id}/pay`, { method: "POST" });
    expect(second.status).toBe(409);
    expect((await payoutRows()).find((x) => x.id === p.id)!.paid_at).toBe(paidAt);
  });

  it("refuses to delete a payout that has already been paid", async () => {
    const paid = (await payoutRows()).find((x) => x.status === "paid")!;
    const res = await req(`/payouts/${paid.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect((await payoutRows()).some((x) => x.id === paid.id)).toBe(true);
  });

  it("releases the jobs back to the next payout run when a pending payout is deleted", async () => {
    const pending = (await payoutRows()).find((x) => x.status === "pending")!;
    expect((await req(`/payouts/${pending.id}`, { method: "DELETE" })).status).toBe(200);
    const r = await sqlClient().execute({
      sql: "SELECT payout_id FROM bookings WHERE id = ?",
      args: ["dap-pay-late"],
    });
    expect((r.rows[0] as any).payout_id).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// 4. Who can read the money
// ---------------------------------------------------------------------------

describe("financial data is office-only", () => {
  it("does not let a technician list every tech's payouts", async () => {
    const res = await req("/payouts", { role: "rider", user: TECH_USER });
    expect(res.status).toBe(403);
  });

  it("does not let a technician pull the company's revenue report", async () => {
    const res = await req("/reports/revenue", { role: "rider", user: TECH_USER });
    expect(res.status).toBe(403);
  });

  it("does not let a technician pull the payroll report", async () => {
    expect((await req("/reports/payroll", { role: "rider", user: TECH_USER })).status).toBe(403);
  });

  it("still serves reports to the office", async () => {
    expect((await req("/reports/revenue")).status).toBe(200);
  });
});
