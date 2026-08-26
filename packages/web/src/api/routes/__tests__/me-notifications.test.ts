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
 * Harness matches the sibling suites: shared local Postgres (see
 * ../../database/__tests__/setup.ts), full drizzle migration applied once per
 * process, disjoint ids so it coexists with other files.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import { ensureSchema } from "../../database/__tests__/setup";

await ensureSchema();

const { db } = await import("../../database/index");
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

let sql: any;

beforeAll(async () => {
  sql = (db as any).$client;

  const co = (id: string, name: string, status: string) =>
    sql.query("INSERT INTO companies (id, name, status) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [id, name, status]);
  await co(ACME, "Acme Facilities", "active");
  await co(BOLT, "Bolt Mechanical", "active");
  await co(GONE, "Zed Suspended Co", "suspended");

  // Users/service referenced by memberships/riders/bookings — Postgres
  // enforces the FK that libsql's derived DDL never had.
  for (const [id, name] of [
    [TECH, "Tech"],
    [SOLO, "Solo"],
    [OUTSIDER, "Outsider"],
    ["cust-x", "Cust X"],
  ] as const) {
    await sql.query(
      `INSERT INTO "user" (id, name, email, role, company_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [id, name, `${id}@t.test`, "customer", ACME],
    );
  }
  await sql.query(
    "INSERT INTO services (id, company_id, name, category) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    ["svc-x", ACME, "General", "general"],
  );

  const member = (id: string, user: string, company: string, status: string, staffType = "tech") =>
    sql.query(
      "INSERT INTO memberships (id, user_id, company_id, role, status, staff_type) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
      [id, user, company, "rider", status, staffType],
    );
  // The multi-company tech: active at Acme + Bolt, and at a suspended company.
  await member("m-tech-acme", TECH, ACME, "active");
  await member("m-tech-bolt", TECH, BOLT, "active", "driver");
  await member("m-tech-gone", TECH, GONE, "active");
  // A single-company tech, used to prove no cross-member leakage.
  await member("m-solo-acme", SOLO, ACME, "active");
  // An INVITED (not yet accepted) membership must not produce counts.
  await member("m-out-bolt", OUTSIDER, BOLT, "invited");

  const rider = (id: string, user: string, company: string) =>
    sql.query("INSERT INTO riders (id, user_id, company_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [id, user, company]);
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
    sql.query(
      "INSERT INTO bookings (id, company_id, customer_id, service_id, rider_id, title, status, assign_status, address, scheduled_at, deleted_at, public_token) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING",
      [id, company, "cust-x", "svc-x", riderId, "Job", status, assignStatus, "1 Main St", new Date(Date.now()), deletedAt === null ? null : new Date(deletedAt), `tok-${id}`],
    );

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
    readByTech = 0,
  ) =>
    sql.query(
      "INSERT INTO messages (id, company_id, rider_id, booking_id, sender_role, sender_name, body, read, read_by_tech) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",
      [id, company, riderId, bookingId, senderRole, "Dispatcher", "hello", !!read, !!readByTech],
    );

  // ---- Acme direct thread: 2 unread from dispatch.
  await msg("nm-acme-1", ACME, "r-tech-acme", "dispatch", 0);
  await msg("nm-acme-2", ACME, "r-tech-acme", "dispatch", 0);
  await msg("nm-acme-read", ACME, "r-tech-acme", "dispatch", 1);
  await msg("nm-acme-mine", ACME, "r-tech-acme", "tech", 0); // tech's own — never counts
  await msg("nm-acme-other", ACME, "r-solo-acme", "dispatch", 0); // another tech's thread

  // ---- Acme job threads, counted via read_by_tech (the FIELD's own ack).
  // On the tech's own live job: a dispatcher message and a customer message.
  // Both count — on a job thread the customer is talking to the tech.
  await msg("nm-acme-job", ACME, "r-tech-acme", "dispatch", 0, "nb-acme-accepted");
  await msg("nm-acme-job-client", ACME, "r-tech-acme", "client", 0, "nb-acme-accepted");
  // ...and every shape on a job thread that must NOT count:
  await msg("nm-acme-job-mine", ACME, "r-tech-acme", "tech", 0, "nb-acme-accepted"); // own send
  await msg("nm-acme-job-acked", ACME, "r-tech-acme", "dispatch", 0, "nb-acme-accepted", 1); // already acked
  await msg("nm-acme-job-done", ACME, "r-tech-acme", "dispatch", 0, "nb-acme-done"); // completed job
  await msg("nm-acme-job-cxl", ACME, "r-tech-acme", "dispatch", 0, "nb-acme-cancelled"); // cancelled
  await msg("nm-acme-job-del", ACME, "r-tech-acme", "dispatch", 0, "nb-acme-deleted"); // soft-deleted
  // On a job that belongs to a DIFFERENT tech at the same company: it counts
  // for SOLO (who can open it) and never for TECH (who cannot).
  await msg("nm-acme-job-other", ACME, "r-solo-acme", "dispatch", 0, "nb-acme-other");

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
  it("counts unread messages and pending work orders per company", async () => {
    const s = await get({ user: TECH, company: ACME });
    expect(at(s, ACME)).toMatchObject({
      company: "Acme Facilities",
      // 2 unread on the direct dispatch thread + 2 unacked on the live job
      // thread (one from dispatch, one from the customer).
      unreadMessages: 4,
      pendingOffers: 1,
      total: 5,
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
    expect(s.unreadMessages).toBe(4);
    expect(s.pendingOffers).toBe(3);
    expect(s.total).toBe(7);
  });

  it("splits out the active company for the Jobs and Messages tab badges", async () => {
    const s = await get({ user: TECH, company: ACME });
    expect(s.active).toMatchObject({ companyId: ACME, unreadMessages: 4, pendingOffers: 1, total: 5 });
  });

  it("follows the header when the tech switches company", async () => {
    const s = await get({ user: TECH, company: BOLT });
    expect(s.active).toMatchObject({ companyId: BOLT, unreadMessages: 0, pendingOffers: 2, total: 2 });
    // The cross-company total must NOT change just because they switched.
    expect(s.total).toBe(7);
  });

  it("returns zeroed active counts when no company has been picked yet", async () => {
    // The picker fetches this BEFORE a company is chosen — it must not 500 and
    // must still return the per-company rows it needs to draw its badges.
    const s = await get({ user: TECH });
    expect(s.active).toMatchObject({ companyId: "", total: 0 });
    expect(s.companies.length).toBe(2);
    expect(s.total).toBe(7);
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
    // nm-acme-mine (direct) and nm-acme-job-mine (job thread) are both the
    // tech's own outbound messages; a naive count would report 6 here.
    const s = await get({ user: TECH, company: ACME });
    expect(at(s, ACME)?.unreadMessages).toBe(4);
  });

  it("ignores already-read messages", async () => {
    const s = await get({ user: TECH, company: BOLT });
    expect(at(s, BOLT)?.unreadMessages).toBe(0);
  });

  it("counts job-thread messages the tech has not acked, from dispatch AND the customer", async () => {
    // These are counted off read_by_tech, the field's own flag, so the number
    // is one the tech can clear by opening the job (POST mark-read-tech) —
    // without touching the office's `read` and its inbox counts.
    const s = await get({ user: TECH, company: ACME });
    expect(at(s, ACME)?.unreadMessages).toBe(4); // 2 direct + nm-acme-job + nm-acme-job-client
  });

  it("ignores a job-thread message the tech has already acked", async () => {
    // nm-acme-job-acked is read_by_tech=1 but read=0: the office still owes it
    // a look, the tech does not.
    const s = await get({ user: TECH, company: ACME });
    expect(at(s, ACME)?.unreadMessages).toBe(4); // would be 5 if read_by_tech were ignored
  });

  it("ignores job-thread messages on completed, cancelled and deleted jobs", async () => {
    // nm-acme-job-done / -cxl / -del are all unacked messages from dispatch.
    // The tech can no longer reach those jobs, so the badge would never clear.
    const s = await get({ user: TECH, company: ACME });
    expect(at(s, ACME)?.unreadMessages).toBe(4); // would be 7 without the job-status filter
  });

  it("ignores job-thread messages on a job assigned to another tech", async () => {
    // nm-acme-job-other sits on nb-acme-other, a live job belonging to SOLO.
    // TECH cannot open it (and must not be told about it); SOLO can, and is.
    const tech = await get({ user: TECH, company: ACME });
    expect(at(tech, ACME)?.unreadMessages).toBe(4);
    const solo = await get({ user: SOLO, company: ACME });
    expect(at(solo, ACME)?.unreadMessages).toBe(2); // own direct + own job thread
  });

  it("never badges a suspended company", async () => {
    const s = await get({ user: TECH, company: ACME });
    expect(at(s, GONE)).toBeUndefined();
    expect(s.companies.map((x) => x.companyId)).not.toContain(GONE);
  });
});

describe("GET /me/notifications — isolation", () => {
  it("counts only the caller's own work, never a colleague's at the same company", async () => {
    // SOLO has one offered job (nb-acme-other), one unread dispatch message
    // (nm-acme-other) and one unacked message on that job (nm-acme-job-other)
    // — and must see exactly those, not TECH's.
    const s = await get({ user: SOLO, company: ACME });
    expect(s.companies.length).toBe(1);
    expect(at(s, ACME)).toMatchObject({ unreadMessages: 2, pendingOffers: 1, total: 3 });
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
    await sql.query("INSERT INTO companies (id, name, status) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", ["notif-office", "Office Only Co", "active"]);
    await sql.query(
      "INSERT INTO memberships (id, user_id, company_id, role, status, staff_type) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
      ["m-tech-office", TECH, "notif-office", "admin", "active", ""],
    );
    const s = await get({ user: TECH, company: ACME });
    expect(at(s, "notif-office")).toMatchObject({ unreadMessages: 0, pendingOffers: 0, total: 0 });
    // and the real counts are unaffected
    expect(s.total).toBe(7);
  });
});
