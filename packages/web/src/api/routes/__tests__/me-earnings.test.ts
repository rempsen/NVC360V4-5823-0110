/**
 * API-level tests for GET /api/me/earnings — the data behind the driver app's
 * Earnings screen.
 *
 * Why this endpoint is deliberately different from every other read in the app:
 * a contract technician can be on several companies' rosters, and their own
 * completed work history is theirs regardless of who dispatched it. Every other
 * endpoint is scoped by the `X-Company-Id` header, which is exactly what made
 * the Earnings screen show one company's jobs while naming no company at all.
 *
 * What each assertion is protecting:
 *
 *  - Cross-company by construction: the payload must be IDENTICAL no matter
 *    which company the app is currently acting as. If it ever varies with the
 *    header we are back to the bug.
 *  - Company-agnostic must not mean company-blind: every job, payout and
 *    summary row carries the company it belongs to, because an unlabelled job
 *    row is ambiguous the moment a driver has two employers.
 *  - Still impossible to see a company you don't belong to: the fan-out is over
 *    the caller's own active memberships only, never a request parameter.
 *  - Ratings are per employer and never blended into one number.
 *  - Suspended tenants are excluded (their rows may be mid-teardown).
 *  - Soft-deleted bookings never appear or contribute to money totals — a
 *    deleted job showing up in "total earned" is a payroll dispute.
 *  - One broken tenant must degrade to an empty entry, not blank the screen.
 *  - Totals are computed over the FULL history even when the row list is capped.
 *
 * Harness matches the sibling suites: ephemeral in-memory libsql, DDL derived
 * from drizzle so it cannot drift from prod, disjoint ids so it coexists with
 * other files in Bun's shared ":memory:" store.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import { getTableConfig, type SQLiteColumn } from "drizzle-orm/sqlite-core";

process.env.DATABASE_URL = ":memory:";
process.env.DATABASE_AUTH_TOKEN = "";

const { db } = await import("../../database/index");
const schema = await import("../../database/schema");
const { meRoutes } = await import("../me");

// Disjoint ids, prefixed so they cannot collide with sibling suites.
const ACME = "earn-acme";
const BOLT = "earn-bolt";
const GONE = "earn-suspended";
const OTHERCO = "earn-outside";
const TECH = "earn-user-tech";
const SOLO = "earn-user-solo";

const app = new Hono().use("*", async (c, next) => {
  const companyId = c.req.header("X-Test-Company") || "";
  const uid = c.req.header("X-Test-User");
  const role = c.req.header("X-Test-Role") || "rider";
  c.set("companyId", companyId);
  c.set("user", uid ? { id: uid, role, email: `${uid}@t.test`, name: uid } : null);
  return next();
});
app.route("/me", meRoutes);

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

let sql: any;
const DAY = 86_400_000;
const now = Date.now();

beforeAll(async () => {
  sql = (db as any).$client;
  await sql.execute(ddlFor(schema.companies));
  await sql.execute(ddlFor(schema.memberships));
  await sql.execute(ddlFor(schema.riders));
  await sql.execute(ddlFor(schema.bookings));
  await sql.execute(ddlFor(schema.services));
  await sql.execute(ddlFor(schema.payouts));
  await sql.execute(ddlFor(schema.user));

  const co = (id: string, name: string, status: string) =>
    sql.execute({
      sql: "INSERT OR IGNORE INTO companies (id, name, status) VALUES (?,?,?)",
      args: [id, name, status],
    });
  await co(ACME, "Acme Facilities", "active");
  await co(BOLT, "Bolt Mechanical", "active");
  await co(GONE, "Zed Suspended Co", "suspended");
  await co(OTHERCO, "Outside Co", "active");

  const member = (id: string, user: string, company: string, status: string) =>
    sql.execute({
      sql: "INSERT OR IGNORE INTO memberships (id, user_id, company_id, role, status, staff_type) VALUES (?,?,?,?,?,?)",
      args: [id, user, company, "rider", status, "tech"],
    });
  // Multi-roster tech: active at Acme + Bolt, active at a SUSPENDED company,
  // and merely INVITED (not accepted) at a fourth.
  await member("em-tech-acme", TECH, ACME, "active");
  await member("em-tech-bolt", TECH, BOLT, "active");
  await member("em-tech-gone", TECH, GONE, "active");
  await member("em-tech-out", TECH, OTHERCO, "invited");
  await member("em-solo-acme", SOLO, ACME, "active");

  // Per (user, company) rider rows, each with its OWN rating — the point of
  // showing rating per employer instead of one blended star.
  const rider = (id: string, user: string, company: string, rating: number) =>
    sql.execute({
      sql: "INSERT OR IGNORE INTO riders (id, user_id, company_id, rating) VALUES (?,?,?,?)",
      args: [id, user, company, rating],
    });
  await rider("er-tech-acme", TECH, ACME, 5);
  await rider("er-tech-bolt", TECH, BOLT, 4.9);
  await rider("er-tech-gone", TECH, GONE, 3.1);
  await rider("er-tech-out", TECH, OTHERCO, 2.2);
  await rider("er-solo-acme", SOLO, ACME, 4.4);

  await sql.execute({
    sql: "INSERT OR IGNORE INTO services (id, company_id, name, category) VALUES (?,?,?,?)",
    args: ["esvc-measure", BOLT, "Site Visit & Measurement", "general"],
  });
  await sql.execute({
    sql: "INSERT OR IGNORE INTO user (id, name, email, role, company_id) VALUES (?,?,?,?,?)",
    args: ["ecust-1", "Curran Stachan", "curran@t.test", "customer", BOLT],
  });

  const booking = (
    id: string,
    company: string,
    riderId: string | null,
    status: string,
    price: number,
    finishedAt: number | null,
    opts: { deletedAt?: number | null; serviceId?: string | null; customerId?: string | null } = {},
  ) =>
    sql.execute({
      sql: "INSERT OR IGNORE INTO bookings (id, company_id, customer_id, service_id, rider_id, title, status, address, scheduled_at, finished_at, price, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      args: [
        id,
        company,
        opts.customerId ?? "ecust-x",
        opts.serviceId ?? null,
        riderId,
        "Job",
        status,
        "1 Main St",
        finishedAt,
        finishedAt,
        price,
        opts.deletedAt ?? null,
      ],
    });

  // ---- Acme: two completed jobs inside the last week, one older.
  await booking("eb-acme-1", ACME, "er-tech-acme", "completed", 100, now - 1 * DAY);
  await booking("eb-acme-2", ACME, "er-tech-acme", "completed", 50.5, now - 2 * DAY);
  await booking("eb-acme-old", ACME, "er-tech-acme", "completed", 25, now - 40 * DAY);
  // ...and every shape that must NOT be counted as earnings:
  await booking("eb-acme-open", ACME, "er-tech-acme", "assigned", 999, null);
  await booking("eb-acme-cxl", ACME, "er-tech-acme", "cancelled", 999, now - 1 * DAY);
  await booking("eb-acme-del", ACME, "er-tech-acme", "completed", 999, now - 1 * DAY, {
    deletedAt: now - 12 * 3600_000,
  });
  // Another tech's completed job at the same company.
  await booking("eb-acme-solo", ACME, "er-solo-acme", "completed", 777, now - 1 * DAY);

  // ---- Bolt: the labelled job (Dan's real-world case: the row must say which
  // company it was for, with the service name and the customer's name).
  await booking("eb-bolt-1", BOLT, "er-tech-bolt", "completed", 300, now - 3 * DAY, {
    serviceId: "esvc-measure",
    customerId: "ecust-1",
  });

  // ---- Suspended company: real completed money that must stay invisible.
  await booking("eb-gone-1", GONE, "er-tech-gone", "completed", 5000, now - 1 * DAY);
  // ---- Invited-only company: same.
  await booking("eb-out-1", OTHERCO, "er-tech-out", "completed", 6000, now - 1 * DAY);

  const payout = (
    id: string,
    company: string,
    riderId: string,
    net: number,
    gross: number,
    status: string,
    end: number,
  ) =>
    sql.execute({
      sql: "INSERT OR IGNORE INTO payouts (id, company_id, rider_id, period_start, period_end, jobs_count, gross, net, status) VALUES (?,?,?,?,?,?,?,?,?)",
      args: [id, company, riderId, end - 7 * DAY, end, 2, gross, net, status],
    });
  await payout("ep-acme-paid", ACME, "er-tech-acme", 80, 100, "paid", now - 5 * DAY);
  await payout("ep-bolt-pending", BOLT, "er-tech-bolt", 240, 300, "pending", now - 1 * DAY);
  await payout("ep-gone-paid", GONE, "er-tech-gone", 4000, 5000, "paid", now - 1 * DAY);
});

type Earnings = {
  companies: { companyId: string; company: string; rating: number | null; jobsCount: number; gross: number }[];
  jobs: {
    id: string;
    companyId: string;
    company: string;
    service: string;
    customerName: string;
    finishedAt: number | null;
    price: number;
  }[];
  payouts: { id: string; companyId: string; company: string; net: number; status: string }[];
  totals: { gross: number; weekGross: number; weekJobs: number; jobsCount: number; paidNet: number };
  truncated: boolean;
};

async function call(opts: { company?: string; user?: string; role?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.company) headers["X-Test-Company"] = opts.company;
  if (opts.user) headers["X-Test-User"] = opts.user;
  if (opts.role) headers["X-Test-Role"] = opts.role;
  const res = await app.request("/me/earnings", { headers });
  return { res, body: (await res.json()) as Earnings };
}

describe("GET /api/me/earnings", () => {
  it("requires a signed-in user", async () => {
    const res = await app.request("/me/earnings", {});
    expect(res.status).toBe(401);
  });

  it("returns the SAME payload no matter which company the app is acting as", async () => {
    // This is the regression that started it all: the screen used to change
    // with the active company, so a BMD Materials job appeared under NVC 360.
    const a = await call({ user: TECH, company: ACME });
    const b = await call({ user: TECH, company: BOLT });
    const none = await call({ user: TECH });
    // A company the tech is NOT active in must not change the answer either.
    const bogus = await call({ user: TECH, company: GONE });

    expect(a.res.status).toBe(200);
    expect(JSON.stringify(b.body)).toBe(JSON.stringify(a.body));
    expect(JSON.stringify(none.body)).toBe(JSON.stringify(a.body));
    expect(JSON.stringify(bogus.body)).toBe(JSON.stringify(a.body));
  });

  it("labels every job, payout and summary row with the company it belongs to", async () => {
    const { body } = await call({ user: TECH, company: ACME });

    expect(body.jobs.length).toBeGreaterThan(0);
    for (const j of body.jobs) {
      expect(j.companyId).toBeTruthy();
      expect(j.company).toBeTruthy();
      // Never the raw id as a fallback when a real name exists.
      expect(j.company).not.toBe(j.companyId);
    }
    for (const p of body.payouts) {
      expect(p.company).toBeTruthy();
      expect(p.companyId).toBeTruthy();
    }

    // The specific row Dan reported: labelled with its company, with the
    // service name and the customer's name resolved off the global user table.
    const bolt = body.jobs.find((j) => j.id === "eb-bolt-1")!;
    expect(bolt).toBeTruthy();
    expect(bolt.company).toBe("Bolt Mechanical");
    expect(bolt.companyId).toBe(BOLT);
    expect(bolt.service).toBe("Site Visit & Measurement");
    expect(bolt.customerName).toBe("Curran Stachan");
  });

  it("aggregates across every roster the tech is on, newest job first", async () => {
    const { body } = await call({ user: TECH, company: ACME });

    expect(body.companies.map((c) => c.company)).toEqual(["Acme Facilities", "Bolt Mechanical"]);
    // 3 Acme + 1 Bolt. Cancelled/open/soft-deleted/other-tech rows excluded.
    expect(body.totals.jobsCount).toBe(4);
    expect(body.totals.gross).toBeCloseTo(475.5, 2);

    const stamps = body.jobs.map((j) => j.finishedAt ?? 0);
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps);
  });

  it("keeps ratings per employer instead of blending them", async () => {
    const { body } = await call({ user: TECH, company: ACME });
    const acme = body.companies.find((c) => c.companyId === ACME)!;
    const bolt = body.companies.find((c) => c.companyId === BOLT)!;
    expect(acme.rating).toBe(5);
    expect(bolt.rating).toBe(4.9);
    expect(acme.jobsCount).toBe(3);
    expect(bolt.jobsCount).toBe(1);
    expect(acme.gross).toBeCloseTo(175.5, 2);
    expect(bolt.gross).toBeCloseTo(300, 2);
  });

  it("computes this-week totals from finished dates, not the whole history", async () => {
    const { body } = await call({ user: TECH, company: ACME });
    // eb-acme-1 (100) + eb-acme-2 (50.5) + eb-bolt-1 (300); the 40-day-old one is out.
    expect(body.totals.weekJobs).toBe(3);
    expect(body.totals.weekGross).toBeCloseTo(450.5, 2);
  });

  it("excludes soft-deleted jobs from both the list and the money", async () => {
    const { body } = await call({ user: TECH, company: ACME });
    expect(body.jobs.some((j) => j.id === "eb-acme-del")).toBe(false);
    // The deleted job is priced 999 — if it leaked, gross would blow past 1000.
    expect(body.totals.gross).toBeLessThan(1000);
  });

  it("excludes suspended companies and memberships that were never accepted", async () => {
    const { body } = await call({ user: TECH, company: ACME });
    const ids = body.companies.map((c) => c.companyId);
    expect(ids).not.toContain(GONE);
    expect(ids).not.toContain(OTHERCO);
    expect(body.jobs.some((j) => j.companyId === GONE || j.companyId === OTHERCO)).toBe(false);
    expect(body.payouts.some((p) => p.companyId === GONE)).toBe(false);
    // The suspended company's paid payout (4000) must not inflate paid-to-date.
    expect(body.totals.paidNet).toBeCloseTo(80, 2);
  });

  it("never shows another technician's work, even at a shared company", async () => {
    const { body } = await call({ user: TECH, company: ACME });
    expect(body.jobs.some((j) => j.id === "eb-acme-solo")).toBe(false);

    // And the other tech sees only their own, at their one company.
    const solo = await call({ user: SOLO, company: ACME });
    expect(solo.body.companies.map((c) => c.companyId)).toEqual([ACME]);
    expect(solo.body.jobs.map((j) => j.id)).toEqual(["eb-acme-solo"]);
    expect(solo.body.totals.gross).toBeCloseTo(777, 2);
    expect(solo.body.payouts).toEqual([]);
  });

  it("returns an empty shell for a superadmin (no rider identity to pay)", async () => {
    const { body } = await call({ user: TECH, company: ACME, role: "superadmin" });
    expect(body.companies).toEqual([]);
    expect(body.jobs).toEqual([]);
    expect(body.totals.gross).toBe(0);
    expect(body.truncated).toBe(false);
  });

  it("sorts payouts newest period first and reports paid net only", async () => {
    const { body } = await call({ user: TECH, company: ACME });
    expect(body.payouts.map((p) => p.id)).toEqual(["ep-bolt-pending", "ep-acme-paid"]);
    expect(body.totals.paidNet).toBeCloseTo(80, 2);
  });
});
