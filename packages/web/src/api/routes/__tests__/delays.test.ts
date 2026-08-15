/**
 * Running-late detection and notices, end to end at the service + API layer.
 *
 * What this file exists to lock down, all of it customer-trust behaviour:
 *
 *  1. THE SWEEP NEVER NOTIFIES ON THE PASS THAT FLAGS. A human gets first
 *     refusal during the tenant's grace period, because dispatch knows things
 *     the data doesn't ("he's two minutes out").
 *  2. IF NOBODY ACTS, IT SENDS ITSELF. A notice that depends on a busy
 *     dispatcher remembering is a notice that doesn't go out on the worst days.
 *  3. IT NEVER NAGS. One notice per slip, a second only if things got
 *     materially worse, never inside the quiet gap.
 *  4. MUTE IS RESPECTED, and a job that catches back up is un-flagged rather
 *     than sitting on the board.
 *  5. A stale browser tab cannot text a customer about a job that is fine.
 *
 * Harness: ephemeral in-memory libsql, ids prefixed "dly-". The `delayed`
 * notification rules are seeded DISABLED for the fixture tenants, so fireEvent
 * resolves zero recipients and no test can ever send a real SMS.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { getTableConfig, type SQLiteColumn } from "drizzle-orm/sqlite-core";

process.env.DATABASE_URL = ":memory:";
process.env.DATABASE_AUTH_TOKEN = "";
process.env.RESEND_API_KEY = "";
process.env.TWILIO_AUTH_TOKEN = "";

const { db } = await import("../../database/index");
const schema = await import("../../database/schema");
const { delaysRoutes } = await import("../delays");
const { sweepDelays, listDelays, pendingDelayCount } = await import(
  "../../../services/delay-watch"
);
const { AppError } = await import("../../lib/errors");

const CO = "dly-co";
const CO2 = "dly-co2";
const CUST = "dly-cust";
const ADMIN = "dly-admin";
const ADMIN2 = "dly-admin2";
const TECH_USER = "dly-tech-user";
const RIDER = "dly-rider";
const SVC = "dly-svc";
const MIN = 60_000;

const app = new Hono().use("*", async (c, next) => {
  c.set("companyId", c.req.header("X-Test-Company") || CO);
  const uid = c.req.header("X-Test-User");
  const role = c.req.header("X-Test-Role") || "customer";
  c.set("user", uid ? { id: uid, role, email: `${uid}@example.test`, name: uid } : null);
  return next();
});
app.route("/delays", delaysRoutes);
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json(
      { error: { code: err.code, message: err.expose ? err.message : "error" } },
      err.status as 400,
    );
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

const sqlClient = () => (db as any).$client;

async function setPolicy(
  companyId: string,
  p: { enabled?: boolean; thresholdMins?: number; autoSendAfterMins?: number } = {},
) {
  const s = sqlClient();
  await s.execute({ sql: "DELETE FROM company_settings WHERE company_id = ?", args: [companyId] });
  await s.execute({
    sql: `INSERT INTO company_settings
            (id, company_id, delay_notice_enabled, delay_notice_threshold_mins,
             delay_notice_auto_send_after_mins)
          VALUES (?,?,?,?,?)`,
    args: [
      `cs-${companyId}`,
      companyId,
      p.enabled === false ? 0 : 1,
      p.thresholdMins ?? 15,
      p.autoSendAfterMins ?? 10,
    ],
  });
}

/** A job `minsLate` minutes past its promised time (negative = still ahead). */
async function seedBooking(opts: {
  id: string;
  minsLate?: number;
  status?: string;
  companyId?: string;
  etaMins?: number | null;
  scheduledAt?: number | null;
  flaggedAt?: number | null;
  flaggedMins?: number | null;
  notifiedAt?: number | null;
  notifiedMins?: number | null;
  muted?: boolean;
}) {
  const s = sqlClient();
  const co = opts.companyId ?? CO;
  await s.execute({ sql: "DELETE FROM bookings WHERE id = ?", args: [opts.id] });
  const sched =
    opts.scheduledAt === null
      ? null
      : (opts.scheduledAt ?? Date.now() - (opts.minsLate ?? 20) * MIN);
  await s.execute({
    sql: `INSERT INTO bookings
            (id, company_id, customer_id, service_id, title, status, assign_status, scheduled_at,
             address, rider_id, price, public_token, eta_mins,
             delay_flagged_at, delay_flagged_mins, delay_notified_at, delay_notified_mins, delay_muted)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      opts.id, co, CUST, SVC, "Furnace repair",
      opts.status ?? "assigned", "accepted", sched, "1 Test St", RIDER, 250,
      `dlytok-${opts.id}`, opts.etaMins ?? null,
      opts.flaggedAt ?? null, opts.flaggedMins ?? null,
      opts.notifiedAt ?? null, opts.notifiedMins ?? null, opts.muted ? 1 : 0,
    ],
  });
}

async function bookingRow(id: string) {
  const r = await sqlClient().execute({ sql: "SELECT * FROM bookings WHERE id = ?", args: [id] });
  return r.rows[0] as any;
}

type Who = { user: string; role?: string; company?: string };
function call(path: string, who: Who, init: { method?: string; body?: unknown } = {}) {
  return app.request(path, {
    method: init.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Test-Company": who.company ?? CO,
      "X-Test-User": who.user,
      "X-Test-Role": who.role ?? "customer",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
const asAdmin: Who = { user: ADMIN, role: "admin" };
const asCustomer: Who = { user: CUST, role: "customer" };

beforeAll(async () => {
  const s = sqlClient();
  for (const t of [
    schema.companySettings, schema.bookings, schema.services, schema.riders, schema.user,
    schema.jobEvents, schema.notificationRules, schema.notifications,
    schema.notificationDeliveries, schema.notificationChannels, schema.webhookEndpoints,
    schema.automationRules, schema.auditLog, schema.properties, schema.bookingChangeRequests,
  ]) {
    await s.execute(ddlFor(t));
  }
  for (const [id, name, role, co] of [
    [CUST, "Customer One", "customer", CO],
    [ADMIN, "Office", "admin", CO],
    [ADMIN2, "Office Two", "admin", CO2],
    [TECH_USER, "Tech", "rider", CO],
  ] as const) {
    await s.execute({
      sql: "INSERT OR IGNORE INTO user (id, company_id, name, email, role, email_verified) VALUES (?,?,?,?,?,0)",
      args: [id, co, name, `${id}@example.test`, role],
    });
  }
  await s.execute({
    sql: "INSERT OR IGNORE INTO riders (id, company_id, user_id, status) VALUES (?,?,?,?)",
    args: [RIDER, CO, TECH_USER, "online"],
  });
  await s.execute({
    sql: "INSERT OR IGNORE INTO services (id, company_id, name, category, base_price) VALUES (?,?,?,?,?)",
    args: [SVC, CO, "Furnace repair", "hvac", 250],
  });
  for (const co of [CO, CO2]) {
    await db.insert(schema.notificationRules).values({
      companyId: co, event: "delayed", recipient: "office",
      inApp: false, email: false, sms: false, webhook: false, enabled: false,
    });
  }
});

beforeEach(async () => {
  await sqlClient().execute("DELETE FROM bookings");
  await setPolicy(CO);
  await setPolicy(CO2);
});

// ---------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------

describe("sweep — detection", () => {
  it("flags a late job without notifying anyone on the same pass", async () => {
    await seedBooking({ id: "dly-b1", minsLate: 20 });
    const r = await sweepDelays();
    expect(r.flagged).toBe(1);
    expect(r.notified).toBe(0);
    const b = await bookingRow("dly-b1");
    expect(b.delay_flagged_at).toBeTruthy();
    expect(Number(b.delay_flagged_mins)).toBe(20);
    expect(b.delay_notified_at).toBeFalsy();
  });

  it("leaves a job inside the threshold alone", async () => {
    await seedBooking({ id: "dly-b2", minsLate: 9 });
    const r = await sweepDelays();
    expect(r.flagged).toBe(0);
    expect((await bookingRow("dly-b2")).delay_flagged_at).toBeFalsy();
  });

  it("catches an ETA overrun before the appointment time has even passed", async () => {
    // Slot is 5 minutes away, the tech's live ETA is 40 minutes out.
    await seedBooking({
      id: "dly-b3",
      status: "enroute",
      scheduledAt: Date.now() + 5 * MIN,
      etaMins: 40,
    });
    const r = await sweepDelays();
    expect(r.flagged).toBe(1);
    const rows = await listDelays(CO);
    expect(rows[0].reason).toBe("eta_overrun");
    expect(rows[0].slipMins).toBeGreaterThanOrEqual(34);
  });

  it("ignores a job the tech has already arrived at", async () => {
    await seedBooking({ id: "dly-b4", minsLate: 40, status: "arrived" });
    expect((await sweepDelays()).flagged).toBe(0);
  });

  it("ignores a job with no promised time rather than guessing one", async () => {
    await seedBooking({ id: "dly-b5", scheduledAt: null });
    expect((await sweepDelays()).flagged).toBe(0);
  });

  it("does nothing for a tenant with the feature switched off", async () => {
    await setPolicy(CO, { enabled: false });
    await seedBooking({ id: "dly-b6", minsLate: 45 });
    expect((await sweepDelays()).flagged).toBe(0);
  });

  it("does not re-text yesterday's forgotten job", async () => {
    await seedBooking({ id: "dly-b7", minsLate: 10 * 60 });
    expect((await sweepDelays()).flagged).toBe(0);
  });

  it("un-flags a job that catches back up", async () => {
    await seedBooking({
      id: "dly-b8",
      status: "enroute",
      scheduledAt: Date.now() + 30 * MIN,
      etaMins: 5,
      flaggedAt: Date.now() - 10 * MIN,
      flaggedMins: 20,
    });
    const r = await sweepDelays();
    expect(r.cleared).toBe(1);
    expect((await bookingRow("dly-b8")).delay_flagged_at).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// who sends, and when
// ---------------------------------------------------------------------------

describe("sweep — the grace period", () => {
  it("holds the notice while the dispatcher still has time to act", async () => {
    await seedBooking({ id: "dly-g1", minsLate: 20, flaggedAt: Date.now() - 4 * MIN });
    const r = await sweepDelays();
    expect(r.notified).toBe(0);
    expect((await bookingRow("dly-g1")).delay_notified_at).toBeFalsy();
  });

  it("sends it automatically once the grace period lapses", async () => {
    await seedBooking({ id: "dly-g2", minsLate: 20, flaggedAt: Date.now() - 11 * MIN });
    const r = await sweepDelays();
    expect(r.notified).toBe(1);
    const b = await bookingRow("dly-g2");
    expect(b.delay_notified_at).toBeTruthy();
    // rounded for the customer: "about 20 minutes", never "19 minutes"
    expect(Number(b.delay_notified_mins) % 5).toBe(0);
  });

  it("never auto-sends for a tenant that set the grace to 0 (dispatcher only)", async () => {
    await setPolicy(CO, { autoSendAfterMins: 0 });
    await seedBooking({ id: "dly-g3", minsLate: 60, flaggedAt: Date.now() - 120 * MIN });
    expect((await sweepDelays()).notified).toBe(0);
  });

  it("never auto-sends a muted job", async () => {
    await seedBooking({
      id: "dly-g4", minsLate: 60, flaggedAt: Date.now() - 120 * MIN, muted: true,
    });
    expect((await sweepDelays()).notified).toBe(0);
    expect((await bookingRow("dly-g4")).delay_notified_at).toBeFalsy();
  });

  it("writes a job-event so there's a record of what the customer was told", async () => {
    await seedBooking({ id: "dly-g5", minsLate: 25, flaggedAt: Date.now() - 11 * MIN });
    await sweepDelays();
    const ev = await sqlClient().execute({
      sql: "SELECT * FROM job_events WHERE booking_id = ? AND kind = 'delayed'",
      args: ["dly-g5"],
    });
    expect(ev.rows.length).toBe(1);
  });
});

describe("sweep — not nagging", () => {
  it("does not send the same notice twice", async () => {
    await seedBooking({
      id: "dly-n1", minsLate: 20,
      flaggedAt: Date.now() - 60 * MIN,
      notifiedAt: Date.now() - 40 * MIN, notifiedMins: 20,
    });
    expect((await sweepDelays()).notified).toBe(0);
  });

  it("speaks up again when the slip grows by another full threshold", async () => {
    await seedBooking({
      id: "dly-n2", minsLate: 55,
      flaggedAt: Date.now() - 60 * MIN,
      notifiedAt: Date.now() - 40 * MIN, notifiedMins: 20,
    });
    expect((await sweepDelays()).notified).toBe(1);
    expect(Number((await bookingRow("dly-n2")).delay_notified_mins)).toBeGreaterThan(20);
  });

  it("holds a worse slip back until the quiet gap has passed", async () => {
    await seedBooking({
      id: "dly-n3", minsLate: 55,
      flaggedAt: Date.now() - 20 * MIN,
      notifiedAt: Date.now() - 5 * MIN, notifiedMins: 20,
    });
    expect((await sweepDelays()).notified).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// the dispatcher's board
// ---------------------------------------------------------------------------

describe("GET /delays", () => {
  it("lists flagged jobs worst-first with a count of the ones nobody has handled", async () => {
    await seedBooking({ id: "dly-l1", minsLate: 20, flaggedAt: Date.now() - MIN, flaggedMins: 20 });
    await seedBooking({ id: "dly-l2", minsLate: 70, flaggedAt: Date.now() - MIN, flaggedMins: 70 });
    const res = await call("/delays", asAdmin);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.delays.map((d: any) => d.bookingId)).toEqual(["dly-l2", "dly-l1"]);
    expect(body.pendingCount).toBe(2);
    expect(body.policy.thresholdMins).toBe(15);
  });

  it("does not count a job that was already handled", async () => {
    await seedBooking({
      id: "dly-l3", minsLate: 20, flaggedAt: Date.now() - MIN,
      notifiedAt: Date.now(), notifiedMins: 20,
    });
    await seedBooking({ id: "dly-l4", minsLate: 20, flaggedAt: Date.now() - MIN, muted: true });
    expect(await pendingDelayCount(CO)).toBe(0);
  });

  it("is tenant-isolated", async () => {
    await seedBooking({ id: "dly-l5", minsLate: 20, flaggedAt: Date.now() - MIN, companyId: CO });
    const res = await call("/delays", { user: ADMIN2, role: "admin", company: CO2 });
    const body = await res.json();
    expect(body.delays).toEqual([]);
  });

  it("is admin-only", async () => {
    const res = await call("/delays", asCustomer);
    expect(res.status).toBe(403);
  });
});

describe("POST /delays/:bookingId/notify", () => {
  it("lets a dispatcher send it early, before the grace period lapses", async () => {
    await seedBooking({ id: "dly-s1", minsLate: 20, flaggedAt: Date.now() - MIN });
    const res = await call("/delays/dly-s1/notify", asAdmin, { method: "POST", body: {} });
    expect(res.status).toBe(200);
    const b = await bookingRow("dly-s1");
    expect(b.delay_notified_at).toBeTruthy();
    expect(Number(b.delay_notified_mins)).toBe(20);
  });

  it("refuses to text a customer about a job that is no longer late", async () => {
    // Stale tab: the tech arrived since the board was rendered.
    await seedBooking({ id: "dly-s2", minsLate: 20, status: "arrived", flaggedAt: Date.now() });
    const res = await call("/delays/dly-s2/notify", asAdmin, { method: "POST", body: {} });
    expect(res.status).toBe(409);
    expect((await bookingRow("dly-s2")).delay_notified_at).toBeFalsy();
  });

  it("404s on another tenant's work order", async () => {
    await seedBooking({ id: "dly-s3", minsLate: 20, companyId: CO });
    const res = await call("/delays/dly-s3/notify", { user: ADMIN2, role: "admin", company: CO2 }, {
      method: "POST", body: {},
    });
    expect(res.status).toBe(404);
  });

  it("is admin-only", async () => {
    await seedBooking({ id: "dly-s4", minsLate: 20 });
    const res = await call("/delays/dly-s4/notify", asCustomer, { method: "POST", body: {} });
    expect(res.status).toBe(403);
    expect((await bookingRow("dly-s4")).delay_notified_at).toBeFalsy();
  });
});

describe("POST /delays/:bookingId/mute", () => {
  it("stops the automatic notice without stopping detection", async () => {
    await seedBooking({ id: "dly-m1", minsLate: 20, flaggedAt: Date.now() - 60 * MIN });
    const res = await call("/delays/dly-m1/mute", asAdmin, { method: "POST", body: { muted: true } });
    expect(res.status).toBe(200);
    expect((await sweepDelays()).notified).toBe(0);
    // still on the board, just quiet
    const rows = await listDelays(CO);
    expect(rows.find((r: any) => r.bookingId === "dly-m1")?.muted).toBe(true);
  });

  it("can be un-muted", async () => {
    await seedBooking({ id: "dly-m2", minsLate: 20, flaggedAt: Date.now() - 60 * MIN, muted: true });
    await call("/delays/dly-m2/mute", asAdmin, { method: "POST", body: { muted: false } });
    expect((await bookingRow("dly-m2")).delay_muted).toBeFalsy();
  });

  it("is admin-only", async () => {
    await seedBooking({ id: "dly-m3", minsLate: 20 });
    const res = await call("/delays/dly-m3/mute", asCustomer, { method: "POST", body: { muted: true } });
    expect(res.status).toBe(403);
  });
});
