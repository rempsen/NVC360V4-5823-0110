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
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { ensureSchema } from "../../database/__tests__/setup";

await ensureSchema();

const { db } = await import("../../database/index");
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
  onSiteMinutes?: number;
  lineItems?: unknown[];
}) {
  const s = sqlClient();
  const subtotal = opts.subtotal ?? 250;
  const tax = opts.taxAmount ?? 0;
  await s.query("DELETE FROM bookings WHERE id = $1", [opts.id]);
  const toDate = (v: number | null) => (v === null || v === undefined ? null : new Date(v));
  await s.query(
    `INSERT INTO bookings
            (id, company_id, customer_id, service_id, title, status, assign_status, scheduled_at,
             address, lat, lng, rider_id, price, subtotal, tax_amount, total, payment_status,
             public_token, enroute_at, started_at, accepted_at, clock_state, last_resume_at,
             inside_geofence, accumulated_ms, on_site_minutes, mileage_km, line_items)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
    [
      opts.id, CO, CUST, SVC, "Rooftop unit service", opts.status,
      opts.assignStatus ?? "accepted",
      toDate(opts.scheduledAt ?? Date.now() + 3_600_000),
      "1 Test Plaza", 43.6532, -79.3832,
      opts.riderId === undefined ? RIDER : opts.riderId,
      subtotal + tax, subtotal, tax, subtotal + tax,
      opts.paymentStatus ?? "unpaid",
      `dap-tok-${opts.id}`,
      toDate(opts.status === "enroute" || opts.status === "arrived" ? Date.now() - 1_800_000 : null),
      toDate(opts.status === "arrived" ? Date.now() - 600_000 : null),
      toDate(opts.assignStatus === "accepted" || opts.assignStatus === undefined ? Date.now() - 3_600_000 : null),
      opts.clockState ?? "idle",
      toDate(opts.clockState === "running" ? Date.now() - 60_000 : null),
      opts.insideGeofence ? true : false,
      0, opts.onSiteMinutes ?? 0, 0,
      JSON.stringify(opts.lineItems ?? []),
    ],
  );
}

async function row(id: string) {
  const r = await sqlClient().query("SELECT * FROM bookings WHERE id = $1", [id]);
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
  const r = await sqlClient().query(
    "SELECT * FROM job_events WHERE booking_id = $1 AND kind = $2",
    [bookingId, kind],
  );
  return r.rows as any[];
}

beforeAll(async () => {
  const s = sqlClient();
  for (const [id, name, role] of [
    [TECH_USER, "Field Tech", "rider"],
    [TECH2_USER, "Second Tech", "rider"],
    [ADMIN_USER, "Office", "admin"],
    [CUST, "Customer", "customer"],
  ] as const) {
    await s.query(
      'INSERT INTO "user" (id, company_id, name, email, role, email_verified) VALUES ($1,$2,$3,$4,$5,false) ON CONFLICT DO NOTHING',
      [id, CO, name, `${id}@t.test`, role],
    );
  }
  for (const [rid, uid] of [[RIDER, TECH_USER], [RIDER2, TECH2_USER]] as const) {
    await s.query(
      "INSERT INTO riders (id, company_id, user_id, status) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [rid, CO, uid, "available"],
    );
  }
  await s.query(
    "INSERT INTO services (id, company_id, name, category, base_price) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [SVC, CO, "Rooftop unit service", "hvac", 250],
  );
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
    expect(after.accepted_at).toEqual(before.accepted_at);
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

// pg returns NUMERIC columns as strings (unlike libsql, which returned plain
// numbers) — coerce the money columns back to numbers for these raw-SQL reads.
const NUMERIC_PAYOUT_COLS = ["gross", "fee", "net", "hourly_pay", "unit_pay"] as const;
async function payoutRows() {
  const r = await sqlClient().query("SELECT * FROM payouts ORDER BY created_at");
  return (r.rows as any[]).map((row) => {
    for (const col of NUMERIC_PAYOUT_COLS) row[col] = Number(row[col]);
    return row;
  });
}

const unitLine = (cost: number, name = "Install") => ({
  id: `li-${name}-${cost}`, kind: "unit", name, unit: "sqft",
  qty: 1, unitCost: cost, unitPrice: 0, taxable: true, cost, price: 0,
});

async function setRate(riderId: string, rate: number) {
  await sqlClient().query("UPDATE riders SET pay_rate_per_hour = $1 WHERE id = $2", [rate, riderId]);
}

// Each pay-model case starts from a clean slate: no payouts, and none of the
// other cases' probe jobs sitting unpaid in the window.
async function resetPayouts() {
  await sqlClient().query("DELETE FROM payouts");
  await sqlClient().query("DELETE FROM bookings WHERE id LIKE 'dap-pay%'");
}

describe("POST /payouts/generate — real tech pay", () => {
  const start = Date.now() - 10 * 86_400_000;
  const end = Date.now() - 1 * 86_400_000;
  const mid = Date.now() - 5 * 86_400_000;

  const generate = (s = start, e = end) =>
    req("/payouts/generate", { method: "POST", json: { periodStart: s, periodEnd: e } });

  it("pays on-site hours × the tech's hourly rate, not a percentage of the invoice", async () => {
    await resetPayouts();
    await setRate(RIDER, 40);
    // A 20-minute warranty call on a $4,000 invoice used to pay $3,200.
    await seedJob({
      id: "dap-pay1", status: "completed", paymentStatus: "paid",
      scheduledAt: mid, subtotal: 4000, taxAmount: 520, onSiteMinutes: 20,
    });
    const res = await generate();
    expect(res.status).toBe(201);
    const rows = await payoutRows();
    expect(rows.length).toBe(1);
    expect(rows[0].hourly_pay).toBe(13.2); // 0.33h × $40
    expect(rows[0].unit_pay).toBe(0);
    expect(rows[0].net).toBe(13.2);
    expect(rows[0].gross).toBe(13.2);
    // No platform fee in the real-pay model.
    expect(rows[0].fee).toBe(0);
    expect(rows[0].fee_pct).toBe(0);
  });

  it("adds per-unit pay on top of the hourly pay", async () => {
    await resetPayouts();
    await setRate(RIDER, 30);
    await seedJob({
      id: "dap-pay-unit", status: "completed", scheduledAt: mid,
      onSiteMinutes: 120, lineItems: [unitLine(150)],
    });
    expect((await generate()).status).toBe(201);
    const p = (await payoutRows()).at(-1)!;
    expect(p.hourly_pay).toBe(60);
    expect(p.unit_pay).toBe(150);
    expect(p.net).toBe(210);
  });

  it("pays for completed work even when the customer has not paid the invoice yet", async () => {
    await resetPayouts();
    await setRate(RIDER, 50);
    await seedJob({
      id: "dap-pay-unpaid", status: "completed", paymentStatus: "unpaid",
      scheduledAt: mid, onSiteMinutes: 60,
    });
    expect((await generate()).status).toBe(201);
    const p = (await payoutRows()).at(-1)!;
    expect(p.net).toBe(50);
  });

  it("flags a $0 job whose tech has no hourly rate set instead of hiding it", async () => {
    await resetPayouts();
    await setRate(RIDER, 0);
    await seedJob({ id: "dap-pay-unrated", status: "completed", scheduledAt: mid, onSiteMinutes: 180 });
    expect((await generate()).status).toBe(201);
    const p = (await payoutRows()).at(-1)!;
    expect(p.net).toBe(0);
    expect(p.unrated_jobs).toBeGreaterThanOrEqual(1);
    const jobs = JSON.parse(p.breakdown);
    expect(jobs.find((j: any) => j.bookingId === "dap-pay-unrated").unrated).toBe(true);
  });

  it("records the per-job breakdown and writes it back on the booking so every screen agrees", async () => {
    await resetPayouts();
    await setRate(RIDER, 45);
    await seedJob({
      id: "dap-pay-detail", status: "completed", scheduledAt: mid,
      onSiteMinutes: 90, lineItems: [unitLine(25)],
    });
    expect((await generate()).status).toBe(201);
    const p = (await payoutRows()).at(-1)!;
    const jobs = JSON.parse(p.breakdown);
    const j = jobs.find((x: any) => x.bookingId === "dap-pay-detail");
    expect(j.hourlyPay).toBe(67.5);
    expect(j.unitPay).toBe(25);
    expect(j.techPay).toBe(92.5);
    expect(Number((await row("dap-pay-detail")).tech_pay)).toBe(92.5);
  });

  it("will not pay the same job twice when the period is generated again", async () => {
    const res = await generate();
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).created).toBe(0);
  });

  it("will not pay the same job twice through an overlapping period either", async () => {
    const res = await generate(start - 5 * 86_400_000, end);
    expect(((await res.json()) as any).created).toBe(0);
  });

  it("still picks up a job that was completed late and never paid out", async () => {
    const before = (await payoutRows()).length;
    await setRate(RIDER, 20);
    await seedJob({ id: "dap-pay-late", status: "completed", scheduledAt: mid, onSiteMinutes: 30 });
    const res = await generate();
    expect(((await res.json()) as any).created).toBe(1);
    const rows = await payoutRows();
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)!.net).toBe(10); // 0.5h × $20
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
    expect((await payoutRows()).find((x) => x.id === p.id)!.paid_at).toEqual(paidAt);
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
    const r = await sqlClient().query(
      "SELECT payout_id FROM bookings WHERE id = $1",
      ["dap-pay-late"],
    );
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

// ---------------------------------------------------------------------------
// 5. Availability: double booking + time off
// ---------------------------------------------------------------------------

/**
 * The board would send one tech to two addresses at the same hour, and
 * `tech_shifts` (time off, written from the tech's profile) was read by nothing.
 * Both are now forceable refusals — the office confirms instead of finding out
 * from the second customer.
 */
const HOUR = 3_600_000;
// A fixed instant well clear of "now" so nothing here depends on the clock.
const SLOT = Date.UTC(2026, 8, 15, 18, 0, 0); // 2026-09-15 18:00Z

/**
 * Availability is the one area where the OTHER rows in the table are the input,
 * so each case starts from a clean slate instead of inheriting the previous
 * case's probe job and clashing with it.
 */
async function clearAvailabilityFixtures() {
  const s = sqlClient();
  await s.query(
    "DELETE FROM bookings WHERE id LIKE 'dap-av%' OR id LIKE 'dap-off%' OR id LIKE 'dap-mv%' OR id LIKE 'dap-cr%' OR id LIKE 'dap-pt%'",
  );
  await s.query("DELETE FROM tech_shifts");
}

async function seedTimeOff(id: string, riderId: string, dayMs: number, kind = "timeoff") {
  const s = sqlClient();
  await s.query("DELETE FROM tech_shifts WHERE id = $1", [id]);
  await s.query(
    `INSERT INTO tech_shifts (id, company_id, rider_id, kind, date, start_min, end_min, note)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, CO, riderId, kind, new Date(dayMs), 540, 1020, "Vacation"],
  );
}

describe("dispatch respects the technician's other work", () => {
  beforeEach(clearAvailabilityFixtures);

  it("refuses to double-book a tech, and says when and on what", async () => {
    await seedJob({ id: "dap-av-busy", status: "assigned", riderId: RIDER, scheduledAt: SLOT });
    await seedJob({ id: "dap-av-new", status: "confirmed", assignStatus: "", riderId: null, scheduledAt: SLOT + 30 * 60_000 });
    const res = await assign("dap-av-new", RIDER);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.forceable).toBe(true);
    expect(body.message).toContain("already booked");
    // untouched
    expect((await row("dap-av-new")).rider_id).toBeFalsy();
  });

  it("dispatches anyway when the office confirms", async () => {
    await seedJob({ id: "dap-av-busy2", status: "assigned", riderId: RIDER, scheduledAt: SLOT });
    await seedJob({ id: "dap-av-new2", status: "confirmed", assignStatus: "", riderId: null, scheduledAt: SLOT + 30 * 60_000 });
    const res = await assign("dap-av-new2", RIDER, { force: true });
    expect(res.status).toBe(200);
    expect((await row("dap-av-new2")).rider_id).toBe(RIDER);
  });

  it("does not count a finished job as a clash", async () => {
    await seedJob({ id: "dap-av-done", status: "completed", riderId: RIDER, scheduledAt: SLOT });
    await seedJob({ id: "dap-av-new3", status: "confirmed", assignStatus: "", riderId: null, scheduledAt: SLOT });
    expect((await assign("dap-av-new3", RIDER)).status).toBe(200);
  });

  it("does not count an archived job as a clash", async () => {
    await seedJob({ id: "dap-av-arch", status: "assigned", riderId: RIDER, scheduledAt: SLOT });
    await sqlClient().query("UPDATE bookings SET deleted_at = $1 WHERE id = $2", [new Date(), "dap-av-arch"]);
    await seedJob({ id: "dap-av-new4", status: "confirmed", assignStatus: "", riderId: null, scheduledAt: SLOT });
    expect((await assign("dap-av-new4", RIDER)).status).toBe(200);
  });

  it("lets back-to-back jobs through", async () => {
    await seedJob({ id: "dap-av-first", status: "assigned", riderId: RIDER, scheduledAt: SLOT });
    await seedJob({ id: "dap-av-next", status: "confirmed", assignStatus: "", riderId: null, scheduledAt: SLOT + HOUR });
    expect((await assign("dap-av-next", RIDER)).status).toBe(200);
  });

  it("does not mind another tech being busy at that time", async () => {
    await seedJob({ id: "dap-av-other", status: "assigned", riderId: RIDER2, scheduledAt: SLOT });
    await seedJob({ id: "dap-av-new5", status: "confirmed", assignStatus: "", riderId: null, scheduledAt: SLOT });
    expect((await assign("dap-av-new5", RIDER)).status).toBe(200);
  });
});

describe("dispatch respects booked time off", () => {
  beforeEach(clearAvailabilityFixtures);

  it("refuses to dispatch a tech on a day they booked off", async () => {
    await seedTimeOff("dap-off-1", RIDER, Date.UTC(2026, 8, 15, 5, 0, 0));
    await seedJob({ id: "dap-off-job", status: "confirmed", assignStatus: "", riderId: null, scheduledAt: SLOT });
    const res = await assign("dap-off-job", RIDER);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.forceable).toBe(true);
    expect(body.message).toContain("time off");
    await sqlClient().query("DELETE FROM tech_shifts WHERE id = $1", ["dap-off-1"]);
  });

  it("ignores a regular shift row", async () => {
    await seedTimeOff("dap-off-2", RIDER, Date.UTC(2026, 8, 15, 5, 0, 0), "shift");
    await seedJob({ id: "dap-off-job2", status: "confirmed", assignStatus: "", riderId: null, scheduledAt: SLOT });
    expect((await assign("dap-off-job2", RIDER)).status).toBe(200);
    await sqlClient().query("DELETE FROM tech_shifts WHERE id = $1", ["dap-off-2"]);
  });
});

describe("POST /bookings/:id/schedule — moving a job onto busy time", () => {
  beforeEach(clearAvailabilityFixtures);

  it("refuses to move a job on top of the same tech's other job", async () => {
    await seedJob({ id: "dap-mv-busy", status: "assigned", riderId: RIDER, scheduledAt: SLOT });
    await seedJob({ id: "dap-mv-job", status: "assigned", riderId: RIDER, scheduledAt: SLOT + 5 * HOUR });
    const res = await reschedule("dap-mv-job", SLOT + 15 * 60_000);
    expect(res.status).toBe(409);
    expect((await res.json()).forceable).toBe(true);
    expect(Number((await row("dap-mv-job")).scheduled_at)).toBe(SLOT + 5 * HOUR);
  });

  it("moves it when the office confirms", async () => {
    await seedJob({ id: "dap-mv-busy2", status: "assigned", riderId: RIDER, scheduledAt: SLOT });
    await seedJob({ id: "dap-mv-job2", status: "assigned", riderId: RIDER, scheduledAt: SLOT + 5 * HOUR });
    const res = await req("/bookings/dap-mv-job2/schedule", {
      method: "POST",
      json: { scheduledAt: SLOT + 15 * 60_000, force: true },
    });
    expect(res.status).toBe(200);
    expect(Number((await row("dap-mv-job2")).scheduled_at)).toBe(SLOT + 15 * 60_000);
  });

  it("still moves a job that clashes with nothing", async () => {
    await seedJob({ id: "dap-mv-free", status: "assigned", riderId: RIDER, scheduledAt: SLOT + 30 * HOUR });
    expect((await reschedule("dap-mv-free", SLOT + 40 * HOUR)).status).toBe(200);
  });
});

describe("POST /bookings/admin — booking a new job onto busy time", () => {
  beforeEach(clearAvailabilityFixtures);

  const createJob = (json: Record<string, unknown>) =>
    req("/bookings/admin", { method: "POST", json: { customerId: CUST, serviceId: SVC, address: "9 Test Rd", ...json } });

  it("refuses to book a new job for a tech who is already out on one", async () => {
    await seedJob({ id: "dap-cr-busy", status: "assigned", riderId: RIDER, scheduledAt: SLOT });
    const res = await createJob({ riderId: RIDER, scheduledAt: new Date(SLOT + 20 * 60_000).toISOString() });
    expect(res.status).toBe(409);
    expect((await res.json()).forceable).toBe(true);
  });

  it("books it when the office confirms", async () => {
    await seedJob({ id: "dap-cr-busy2", status: "assigned", riderId: RIDER, scheduledAt: SLOT });
    const res = await createJob({
      riderId: RIDER,
      scheduledAt: new Date(SLOT + 20 * 60_000).toISOString(),
      force: true,
    });
    expect(res.status).toBe(201);
  });

  it("still books an unassigned job at a busy time", async () => {
    await seedJob({ id: "dap-cr-busy3", status: "assigned", riderId: RIDER, scheduledAt: SLOT });
    const res = await createJob({ scheduledAt: new Date(SLOT + 20 * 60_000).toISOString() });
    expect(res.status).toBe(201);
  });
});

describe("PATCH /bookings/:id — editing a job onto busy time", () => {
  beforeEach(clearAvailabilityFixtures);

  it("refuses when the edit puts the tech in two places", async () => {
    await seedJob({ id: "dap-pt-busy", status: "assigned", riderId: RIDER, scheduledAt: SLOT });
    await seedJob({ id: "dap-pt-job", status: "confirmed", assignStatus: "", riderId: null, scheduledAt: SLOT + 10 * 60_000 });
    const res = await req("/bookings/dap-pt-job", { method: "PATCH", json: { riderId: RIDER } });
    expect(res.status).toBe(409);
    expect((await res.json()).forceable).toBe(true);
    expect((await row("dap-pt-job")).rider_id).toBeFalsy();
  });

  it("saves the edit when the office confirms", async () => {
    await seedJob({ id: "dap-pt-busy2", status: "assigned", riderId: RIDER, scheduledAt: SLOT });
    await seedJob({ id: "dap-pt-job2", status: "confirmed", assignStatus: "", riderId: null, scheduledAt: SLOT + 10 * 60_000 });
    const res = await req("/bookings/dap-pt-job2", { method: "PATCH", json: { riderId: RIDER, force: true } });
    expect(res.status).toBe(200);
    expect((await row("dap-pt-job2")).rider_id).toBe(RIDER);
  });

  it("does not warn on an edit that touches neither the tech nor the time", async () => {
    await seedJob({ id: "dap-pt-busy3", status: "assigned", riderId: RIDER, scheduledAt: SLOT });
    await seedJob({ id: "dap-pt-job3", status: "assigned", riderId: RIDER, scheduledAt: SLOT + 10 * 60_000 });
    const res = await req("/bookings/dap-pt-job3", { method: "PATCH", json: { notes: "gate code 1234" } });
    expect(res.status).toBe(200);
  });
});
