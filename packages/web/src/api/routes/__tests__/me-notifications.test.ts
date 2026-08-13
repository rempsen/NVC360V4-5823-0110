/**
 * API-level tests for GET /api/me/notifications — the counts behind every red
 * indicator in the driver app (app-icon badge, Jobs/Messages tab badges, and
 * the per-company badge in the company picker).
 *
 * What matters here and why each assertion exists:
 *
 *  - The endpoint is the ONE company-agnostic read in the app. A technician on
 *    two rosters must be told that their OTHER employer sent a work order,
 *    because every other endpoint is scoped to the company they picked for this
 *    shift and therefore structurally cannot see it.
 *  - It must still be impossible to learn anything about a company you are not
 *    a member of: counts are derived from the caller's own active memberships
 *    only, never from a parameter.
 *  - It must never report a number the tech cannot clear (a badge you can't
 *    clear trains people to ignore badges): declined/accepted work orders,
 *    completed/cancelled/deleted jobs, the tech's own sent messages, and
 *    suspended companies are all excluded.
 *
 * Harness matches the sibling suites: ephemeral in-memory libsql, DDL derived
 * from drizzle so it can't drift from prod, disjoint ids so it coexists with
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
const ACME = "notif-acme";
const BOLT = "notif-bolt";
const GONE = "notif-suspended";
const TECH = "notif-user-tech";
const SOLO = "notif-user-solo";
const OUTSIDER = "notif-user-outsider";

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

beforeAll(async () => {
  sql = (db as any).$client;
  await sql.execute(ddlFor(schema.companies));
  await sql.execute(ddlFor(schema.memberships));
  await sql.execute(ddlFor(schema.riders));
  await sql.execute(ddlFor(schema.bookings));
  await sql.execute(ddlFor(schema.messages));

  const co = (id: string, name: string, status: string) =>
    sql.execute({
      sql: "INSERT OR IGNORE INTO companies (id, name, status) VALUES (?,?,?)",
      args: [id, name, status],
    });
  await co(ACME, "Acme Facilities", "active");
  await co(BOLT, "Bolt Mechanical", "active");
  await co(GONE, "Zed Suspended Co", "suspended");

  const member = (id: string, user: string, company: string, status: string, staffType = "tech") =>
    sql.execute({
      sql: "INSERT OR IGNORE INTO memberships (id, user_id, company_id, role, status, staff_type) VALUES (?,?,?,?,?,?)",
      args: [id, user, company, "rider", status, staffType],
    });
  // The multi-company tech: active at Acme + Bolt, and at a suspended company.
  await member("m-tech-acme", TECH, ACME, "active");
  await member("m-tech-bolt", TECH, BOLT, "active", "driver");
  await member("m-tech-gone", TECH, GONE, "active");
  // A single-company tech, used to prove no cross-member leakage.
  await member("m-solo-acme", SOLO, ACME, "active");
  // An INVITED (not yet accepted) membership must not produce counts.
  await member("m-out-bolt", OUTSIDER, BOLT, "invited");

  const rider = (id: string, user: string, company: string) =>
    sql.execute({
      sql: "INSERT OR IGNORE INTO riders (id, user_id, company_id) VALUES (?,?,?)",
      args: [id, user, company],
    });
  await rider("r-tech-acme", TECH, ACME);
  await rider("r-tech-bolt", TECH, BOLT);
  await rider("r-tech-gone", TECH, GONE);
  await rider("r-solo-acme", SOLO, ACME);

  const booking = (
    id: string,
    company: string,
    riderId: string | null,
    status: string,
    assignStatus: string,
    deletedAt: number | null = null,
  ) =>
    sql.execute({
      sql: "INSERT OR IGNORE INTO bookings (id, company_id, customer_id, service_id, rider_id, title, status, assign_status, address, scheduled_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      args: [id, company, "cust-x", "svc-x", riderId, "Job", status, assignStatus, "1 Main St", Date.now(), deletedAt],
    });

  // ---- Acme: ONE genuine pending offer, plus every shape that must NOT count.
  await booking("nb-acme-offer", ACME, "r-tech-acme", "assigned", "offered");
  await booking("nb-acme-accepted", ACME, "r-tech-acme", "assigned", "accepted");
  await booking("nb-acme-declined", ACME, "r-tech-acme", "confirmed", "declined");
  await booking("nb-acme-done", ACME, "r-tech-acme", "completed", "offered");
  await booking("nb-acme-cancelled", ACME, "r-tech-acme", "cancelled", "offered");
  await booking("nb-acme-deleted", ACME, "r-tech-acme", "assigned", "offered", Date.now());
  // Offered to a DIFFERENT tech at the same company.
  await booking("nb-acme-other", ACME, "r-solo-acme", "assigned", "offered");
  // Offered but unassigned (sitting on the board, nobody's to accept).
  await booking("nb-acme-noone", ACME, null, "confirmed", "offered");

  // ---- Bolt: two pending offers for the same tech.
  await booking("nb-bolt-o1", BOLT, "r-tech-bolt", "assigned", "offered");
  await booking("nb-bolt-o2", BOLT, "r-tech-bolt", "assigned", "offered");

  // ---- Suspended company: a real offer that must stay invisible.
  await booking("nb-gone-o1", GONE, "r-tech-gone", "assigned", "offered");

  const msg = (
    id: string,
    company: string,
    riderId: string | null,
    senderRole: string,
    read: number,
    bookingId: string | null = null,
  ) =>
    sql.execute({
      sql: "INSERT OR IGNORE INTO messages (id, company_id, rider_id, booking_id, sender_role, sender_name, body, read) VALUES (?,?,?,?,?,?,?,?)",
      args: [id, company, riderId, bookingId, senderRole, "Dispatcher", "hello", read],
    });

  // ---- Acme messages: 2 unread from dispatch = the only ones that count.
  await msg("nm-acme-1", ACME, "r-tech-acme", "dispatch", 0);
  await msg("nm-acme-2", ACME, "r-tech-acme", "dispatch", 0);
  await msg("nm-acme-read", ACME, "r-tech-acme", "dispatch", 1);
  await msg("nm-acme-mine", ACME, "r-tech-acme", "tech", 0); // tech's own — never counts
  await msg("nm-acme-other", ACME, "r-solo-acme", "dispatch", 0); // another tech's thread
  // A job-thread message: intentionally excluded (see the note in me.ts — the
  // tech has no way to ack it, so counting it would stick the badge on).
  await msg("nm-acme-job", ACME, "r-tech-acme", "dispatch", 0, "nb-acme-accepted");

  // ---- Bolt: no unread messages, only the two work orders.
  await msg("nm-bolt-read", BOLT, "r-tech-bolt", "dispatch", 1);
});

function call(opts: { company?: string; user?: string; role?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.company) headers["X-Test-Company"] = opts.company;
  if (opts.user) headers["X-Test-User"] = opts.user;
  if (opts.role) headers["X-Test-Role"] = opts.role;
  return app.request("/me/notifications", { headers });
}

type Summary = {
  total: number;
  unreadMessages: number;
  pendingOffers: number;
  active: { companyId: string; unreadMessages: number; pendingOffers: number; total: number };
  companies: {
    companyId: string;
    company: string;
    staffType?: string | null;
    unreadMessages: number;
    pendingOffers: number;
    total: number;
  }[];
}

const get = async (opts: Parameters<typeof call>[0]) => (await call(opts)).json() as Promise<Summary>;
const at = (s: Summary, companyId: string) => s.companies.find((x) => x.companyId === companyId);

describe("GET /me/notifications — auth", () => {
  it("rejects an unauthenticated caller", async () => {
    const res = await call({ company: ACME });
    expect(res.status).toBe(401);
  });
});

describe("GET /me/notifications — per-company counts", () => {
  it("counts unread dispatch messages and pending work orders per company", async () => {
    const s = await get({ user: TECH, company: ACME });
    expect(at(s, ACME)).toMatchObject({
      company: "Acme Facilities",
      unreadMessages: 2,
      pendingOffers: 1,
      total: 3,
    });
    expect(at(s, BOLT)).toMatchObject({
      company: "Bolt Mechanical",
      unreadMessages: 0,
      pendingOffers: 2,
      total: 2,
    });
  });

  it("reports the company each count belongs to, so the app can badge the right one", async () => {
    const s = await get({ user: TECH, company: ACME });
    // This is the whole feature: the tech is on shift for Acme, and the payload
    // still names Bolt as having work waiting.
    const waiting = s.companies.filter((x) => x.companyId !== ACME && x.total > 0);
    expect(waiting.map((x) => x.company)).toEqual(["Bolt Mechanical"]);
  });

  it("totals across every company, which is what the app-icon badge shows", async () => {
    const s = await get({ user: TECH, company: ACME });
    expect(s.unreadMessages).toBe(2);
    expect(s.pendingOffers).toBe(3);
    expect(s.total).toBe(5);
  });

  it("splits out the active company for the Jobs and Messages tab badges", async () => {
    const s = await get({ user: TECH, company: ACME });
    expect(s.active).toMatchObject({ companyId: ACME, unreadMessages: 2, pendingOffers: 1, total: 3 });
  });

  it("follows the header when the tech switches company", async () => {
    const s = await get({ user: TECH, company: BOLT });
    expect(s.active).toMatchObject({ companyId: BOLT, unreadMessages: 0, pendingOffers: 2, total: 2 });
    // The cross-company total must NOT change just because they switched.
    expect(s.total).toBe(5);
  });

  it("returns zeroed active counts when no company has been picked yet", async () => {
    // The picker fetches this BEFORE a company is chosen — it must not 500 and
    // must still return the per-company rows it needs to draw its badges.
    const s = await get({ user: TECH });
    expect(s.active).toMatchObject({ companyId: "", total: 0 });
    expect(s.companies.length).toBe(2);
    expect(s.total).toBe(5);
  });

  it("sorts companies by name for a stable picker order", async () => {
    const s = await get({ user: TECH, company: ACME });
    expect(s.companies.map((x) => x.company)).toEqual(["Acme Facilities", "Bolt Mechanical"]);
  });

  it("carries staffType so the picker can label driver vs technician", async () => {
    const s = await get({ user: TECH, company: ACME });
    expect(at(s, BOLT)?.staffType).toBe("driver");
  });
});

describe("GET /me/notifications — never reports a badge the tech can't clear", () => {
  it("ignores accepted and declined work orders", async () => {
    const s = await get({ user: TECH, company: ACME });
    expect(at(s, ACME)?.pendingOffers).toBe(1); // not the accepted/declined ones
  });

  it("ignores completed, cancelled and soft-deleted jobs even when still 'offered'", async () => {
    // nb-acme-done / nb-acme-cancelled / nb-acme-deleted are all assign_status
    // 'offered'; a naive count would report 4 here.
    const s = await get({ user: TECH, company: ACME });
    expect(at(s, ACME)?.pendingOffers).toBe(1);
  });

  it("ignores messages the tech sent themselves", async () => {
    const s = await get({ user: TECH, company: ACME });
    expect(at(s, ACME)?.unreadMessages).toBe(2); // nm-acme-mine excluded
  });

  it("ignores already-read messages", async () => {
    const s = await get({ user: TECH, company: BOLT });
    expect(at(s, BOLT)?.unreadMessages).toBe(0);
  });

  it("excludes job-thread messages (no tech-side read ack exists yet)", async () => {
    // nm-acme-job is unread and from dispatch, but lives on a booking thread
    // whose only mark-read acks on behalf of the OFFICE. Counting it would put
    // a permanent red number on the app.
    const s = await get({ user: TECH, company: ACME });
    expect(at(s, ACME)?.unreadMessages).toBe(2);
  });

  it("never badges a suspended company", async () => {
    const s = await get({ user: TECH, company: ACME });
    expect(at(s, GONE)).toBeUndefined();
    expect(s.companies.map((x) => x.companyId)).not.toContain(GONE);
  });
});

describe("GET /me/notifications — isolation", () => {
  it("counts only the caller's own work, never a colleague's at the same company", async () => {
    // SOLO has one offered job (nb-acme-other) and one unread dispatch message
    // (nm-acme-other) — and must see exactly those, not TECH's.
    const s = await get({ user: SOLO, company: ACME });
    expect(s.companies.length).toBe(1);
    expect(at(s, ACME)).toMatchObject({ unreadMessages: 1, pendingOffers: 1, total: 2 });
  });

  it("reports nothing for a company whose invite hasn't been accepted", async () => {
    const s = await get({ user: OUTSIDER, company: BOLT });
    expect(s.companies).toEqual([]);
    expect(s.total).toBe(0);
  });

  it("ignores a spoofed X-Company-Id for a company the caller doesn't belong to", async () => {
    // Even asked to act as Bolt, a non-member gets no Bolt counts: the payload
    // is built from memberships, not from the header.
    const s = await get({ user: OUTSIDER, company: BOLT });
    expect(s.active.total).toBe(0);
    expect(s.companies).toEqual([]);
  });

  it("returns an empty summary for a user with no memberships at all", async () => {
    const s = await get({ user: "notif-nobody", company: ACME });
    expect(s).toMatchObject({ total: 0, unreadMessages: 0, pendingOffers: 0, companies: [] });
  });

  it("returns an empty summary for a superadmin (no field identity to badge)", async () => {
    const s = await get({ user: TECH, company: ACME, role: "superadmin" });
    expect(s.total).toBe(0);
    expect(s.companies).toEqual([]);
  });
});

describe("GET /me/notifications — a company with no rider identity", () => {
  it("reports zero rather than failing when the caller holds a non-field role there", async () => {
    // Office staff at one company, tech at another: no rider row means there is
    // nothing for the driver app to badge, and it must not error the whole call.
    await sql.execute({
      sql: "INSERT OR IGNORE INTO companies (id, name, status) VALUES (?,?,?)",
      args: ["notif-office", "Office Only Co", "active"],
    });
    await sql.execute({
      sql: "INSERT OR IGNORE INTO memberships (id, user_id, company_id, role, status, staff_type) VALUES (?,?,?,?,?,?)",
      args: ["m-tech-office", TECH, "notif-office", "admin", "active", ""],
    });
    const s = await get({ user: TECH, company: ACME });
    expect(at(s, "notif-office")).toMatchObject({ unreadMessages: 0, pendingOffers: 0, total: 0 });
    // and the real counts are unaffected
    expect(s.total).toBe(5);
  });
});
