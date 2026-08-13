/**
 * API-level tests for POST /api/messages/:bookingId/mark-read-tech — the FIELD
 * side's read ack on a job thread.
 *
 * Why this endpoint exists at all, and why these assertions are the ones that
 * matter:
 *
 *  - `messages.read` means "the OFFICE has read this". It drives the dispatcher
 *    inbox's unread counts. `messages.readByTech` is the technician's own,
 *    independent ack. Two audiences, two flags.
 *  - If opening a job on the phone also set `read`, a technician would silently
 *    blank the dispatcher's unread list — the office would stop seeing customer
 *    messages it still owes a reply to. The "office inbox unchanged" test below
 *    is the entire reason the column was added, so it must never be relaxed.
 *  - If the tech had no ack of their own, every job-thread message would sit on
 *    the driver app's red badge forever. So the ack must actually clear the
 *    count reported by GET /api/me/notifications — asserted end-to-end here
 *    rather than by re-reading the row, because the badge is the user-visible
 *    contract.
 *  - A tech may only ack their OWN work order. Acking someone else's would hide
 *    a message from the tech who actually needs to see it, so a booking that
 *    isn't theirs is 404 (not 403 — a 403 would confirm the id exists).
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
const { messagesRoutes } = await import("../messages");
const { meRoutes } = await import("../me");

// Disjoint ids, prefixed so they cannot collide with sibling suites.
const CO = "mrt-co";
const MINE = "mrt-user-mine"; // the tech whose job it is
const OTHER = "mrt-user-other"; // another tech at the same company
const BOSS = "mrt-user-admin";
const R_MINE = "mrt-rider-mine";
const R_OTHER = "mrt-rider-other";
const JOB = "mrt-job-mine";
const JOB_OTHER = "mrt-job-other";

const app = new Hono().use("*", async (c, next) => {
  const companyId = c.req.header("X-Test-Company") || "";
  const uid = c.req.header("X-Test-User");
  const role = c.req.header("X-Test-Role") || "rider";
  c.set("companyId", companyId);
  c.set("user", uid ? { id: uid, role, email: `${uid}@t.test`, name: uid } : null);
  return next();
});
app.route("/messages", messagesRoutes);
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

/** Read one message row back — used only to prove which flag moved. */
async function flags(id: string): Promise<{ read: number; readByTech: number }> {
  const r = await sql.execute({
    sql: "SELECT read, read_by_tech FROM messages WHERE id = ?",
    args: [id],
  });
  const row = r.rows[0];
  return { read: Number(row.read), readByTech: Number(row.read_by_tech) };
}

/** The dispatcher inbox's unread count for the job thread. */
async function officeUnread(bookingId: string): Promise<number> {
  const res = await app.request("/messages/inbox", {
    headers: { "X-Test-Company": CO, "X-Test-User": BOSS, "X-Test-Role": "admin" },
  });
  const body = (await res.json()) as {
    threads: { bookingId: string | null; unread: number }[];
  };
  return body.threads.find((t) => t.bookingId === bookingId)?.unread ?? -1;
}

/** The driver app's badge count for this tech at this company. */
async function badge(userId: string): Promise<number> {
  const res = await app.request("/me/notifications", {
    headers: { "X-Test-Company": CO, "X-Test-User": userId, "X-Test-Role": "rider" },
  });
  const body = (await res.json()) as { active: { total: number } };
  return body.active.total;
}

function ack(bookingId: string, opts: { user?: string; role?: string } = {}) {
  const headers: Record<string, string> = { "X-Test-Company": CO };
  if (opts.user) headers["X-Test-User"] = opts.user;
  headers["X-Test-Role"] = opts.role ?? "rider";
  return app.request(`/messages/${bookingId}/mark-read-tech`, { method: "POST", headers });
}

beforeAll(async () => {
  sql = (db as any).$client;
  await sql.execute(ddlFor(schema.companies));
  await sql.execute(ddlFor(schema.memberships));
  await sql.execute(ddlFor(schema.riders));
  await sql.execute(ddlFor(schema.bookings));
  await sql.execute(ddlFor(schema.messages));
  await sql.execute(ddlFor(schema.user));

  await sql.execute({
    sql: "INSERT OR IGNORE INTO companies (id, name, status) VALUES (?,?,?)",
    args: [CO, "Mark Read Tech Co", "active"],
  });

  const member = (id: string, user: string) =>
    sql.execute({
      sql: "INSERT OR IGNORE INTO memberships (id, user_id, company_id, role, status, staff_type) VALUES (?,?,?,?,?,?)",
      args: [id, user, CO, "rider", "active", "tech"],
    });
  await member("mrt-m-mine", MINE);
  await member("mrt-m-other", OTHER);

  const rider = (id: string, user: string) =>
    sql.execute({
      sql: "INSERT OR IGNORE INTO riders (id, user_id, company_id) VALUES (?,?,?)",
      args: [id, user, CO],
    });
  await rider(R_MINE, MINE);
  await rider(R_OTHER, OTHER);

  const booking = (id: string, riderId: string) =>
    sql.execute({
      sql: "INSERT OR IGNORE INTO bookings (id, company_id, customer_id, service_id, rider_id, title, status, assign_status, address, scheduled_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      args: [id, CO, "mrt-cust", "mrt-svc", riderId, "Boiler service", "in_progress", "accepted", "9 Elm St", Date.now()],
    });
  await booking(JOB, R_MINE);
  await booking(JOB_OTHER, R_OTHER);

  const msg = (id: string, riderId: string, bookingId: string, senderRole: string) =>
    sql.execute({
      sql: "INSERT OR IGNORE INTO messages (id, company_id, rider_id, booking_id, sender_role, sender_name, body, read, read_by_tech) VALUES (?,?,?,?,?,?,?,0,0)",
      args: [id, CO, riderId, bookingId, senderRole, senderRole, "hello"],
    });
  // The tech's own job thread: dispatcher + customer + one of the tech's own.
  await msg("mrt-m-dispatch", R_MINE, JOB, "dispatch");
  await msg("mrt-m-client", R_MINE, JOB, "client");
  await msg("mrt-m-tech", R_MINE, JOB, "tech");
  // Another tech's job thread — must survive any ack attempt by MINE.
  await msg("mrt-m-otherjob", R_OTHER, JOB_OTHER, "dispatch");
});

describe("POST /messages/:bookingId/mark-read-tech — access", () => {
  it("rejects an unauthenticated caller", async () => {
    const res = await ack(JOB);
    expect(res.status).toBe(401);
  });

  it("rejects an office user — this flag means 'the FIELD has seen it'", async () => {
    const res = await ack(JOB, { user: BOSS, role: "admin" });
    expect(res.status).toBe(403);
    expect((await flags("mrt-m-dispatch")).readByTech).toBe(0);
  });

  it("404s on an unknown work order without confirming it doesn't exist", async () => {
    const res = await ack("mrt-no-such-job", { user: MINE });
    expect(res.status).toBe(404);
  });

  it("404s on another tech's work order, and leaves their thread unacked", async () => {
    // 404 rather than 403 so this can't be used to enumerate booking ids, and
    // the other tech must still be told about their own message.
    const res = await ack(JOB_OTHER, { user: MINE });
    expect(res.status).toBe(404);
    expect((await flags("mrt-m-otherjob")).readByTech).toBe(0);
    expect(await badge(OTHER)).toBe(1);
  });
});

describe("POST /messages/:bookingId/mark-read-tech — what it changes", () => {
  it("acks inbound messages, clears the tech's badge, and does NOT touch the office inbox", async () => {
    // Before: the tech is told about 2 inbound messages (dispatcher + customer)
    // and the office still owes the customer message a look.
    expect(await badge(MINE)).toBe(2);
    expect(await officeUnread(JOB)).toBe(1);

    const res = await ack(JOB, { user: MINE });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // The field ack landed on both inbound senders...
    expect(await flags("mrt-m-dispatch")).toEqual({ read: 0, readByTech: 1 });
    expect(await flags("mrt-m-client")).toEqual({ read: 0, readByTech: 1 });
    // ...and the badge the tech was shown is now clear.
    expect(await badge(MINE)).toBe(0);

    // THE POINT OF THE WHOLE COLUMN: the dispatcher's unread count is
    // untouched. A tech opening a job must never blank the office's inbox.
    expect(await officeUnread(JOB)).toBe(1);
  });

  it("is idempotent — acking again is a no-op, not an error", async () => {
    const res = await ack(JOB, { user: MINE });
    expect(res.status).toBe(200);
    expect(await badge(MINE)).toBe(0);
    expect(await officeUnread(JOB)).toBe(1);
  });
});
