/**
 * Input handling on the PUBLIC tracking surface — /api/track/:token.
 *
 * These routes are the only writable endpoints in the product with no session,
 * no CSRF token and no client we control: anyone holding the SMS link can POST
 * to them. Before this, the body was trusted completely.
 *
 * What that allowed, all reproduced live against the real server first:
 *
 *  - POST /:token/messages with no body field, `body: null`, or a malformed JSON
 *    payload → 500 (unguarded `await c.req.json()`, then a NOT NULL violation).
 *  - POST /:token/messages with `body: {a:1}` → the string "[object Object]"
 *    stored in the thread AND texted to the technician.
 *  - POST /:token/messages with `body: "   "` → an empty bubble + a real SMS.
 *  - POST /:token/messages with a 60 000-character body → stored verbatim and
 *    interpolated whole into an SMS (hundreds of paid segments, per request).
 *  - POST /:token/review with `rating: "abc"` → NaN reached the insert → 500,
 *    and on a rider with reviews the average could be poisoned.
 *  - POST /:token/review with `rating: 99` → silently clamped to a 5-star review
 *    the customer never gave.
 *  - POST /:token/review with a 60 000-character comment → stored verbatim.
 *
 * Harness: ephemeral in-memory libsql, ids prefixed "trk-". No notification
 * rules and no technician phone are seeded, so nothing is sent anywhere.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { getTableConfig, type SQLiteColumn } from "drizzle-orm/sqlite-core";

process.env.DATABASE_URL = ":memory:";
process.env.DATABASE_AUTH_TOKEN = "";
// The public write limiter (10/min per token by default) is deliberately tight;
// it is read once at module load, so raise it here or the suite trips its own
// budget. The real limit is proven live against the running server.
process.env.RL_TRACK_WRITE_LIMIT = "10000";

const { db } = await import("../../database/index");
const schema = await import("../../database/schema");
const { trackRoutes } = await import("../track");
const { AppError } = await import("../../lib/errors");

const CO = "trk-co";
const CUST = "trk-cust";
const SVC = "trk-svc";
const LIVE = "trk-live"; // enroute job
const DONE = "trk-done"; // completed job
const LIVE_TOKEN = "trk-token-live";
const DONE_TOKEN = "trk-token-done";

const app = new Hono();
app.route("/track", trackRoutes);
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
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

async function seedJob(id: string, token: string, status: string) {
  const s = sqlClient();
  await s.execute({ sql: "DELETE FROM bookings WHERE id = ?", args: [id] });
  await s.execute({
    sql: `INSERT INTO bookings
            (id, company_id, customer_id, service_id, title, status, assign_status,
             scheduled_at, address, rider_id, price, public_token, finished_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      id, CO, CUST, SVC, "Furnace repair", status, "unassigned",
      Date.now() - 3_600_000, "1 Test St", null, 250, token,
      status === "completed" ? Date.now() : null,
    ],
  });
}

/** Raw POST so malformed (non-JSON) bodies can be exercised too. */
function post(path: string, body: string) {
  return app.request(`/track/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}
const postJson = (path: string, body: unknown) => post(path, JSON.stringify(body));

async function messages(id: string) {
  const r = await sqlClient().execute({
    sql: "SELECT sender_name, body FROM messages WHERE booking_id = ?",
    args: [id],
  });
  return r.rows as any[];
}
async function reviews(id: string) {
  const r = await sqlClient().execute({
    sql: "SELECT rating, comment FROM reviews WHERE booking_id = ?",
    args: [id],
  });
  return r.rows as any[];
}

beforeAll(async () => {
  const s = sqlClient();
  for (const t of [
    schema.companySettings, schema.bookings, schema.services, schema.riders,
    schema.user, schema.messages, schema.reviews, schema.notifications,
    schema.notificationRules, schema.notificationDeliveries, schema.jobEvents,
    schema.trackingPings, schema.properties, schema.memberships,
  ]) {
    await s.execute(ddlFor(t));
  }
  await s.execute({
    sql: "INSERT OR IGNORE INTO user (id, company_id, name, email, role, email_verified) VALUES (?,?,?,?,?,0)",
    args: [CUST, CO, "Customer One", "trk-cust@t.test", "customer"],
  });
  await s.execute({
    sql: "INSERT OR IGNORE INTO services (id, company_id, name, category, base_price) VALUES (?,?,?,?,?)",
    args: [SVC, CO, "Furnace repair", "hvac", 250],
  });
});

beforeEach(async () => {
  const s = sqlClient();
  await s.execute({ sql: "DELETE FROM messages WHERE company_id = ?", args: [CO] });
  await s.execute({ sql: "DELETE FROM reviews WHERE company_id = ?", args: [CO] });
  await seedJob(LIVE, LIVE_TOKEN, "enroute");
  await seedJob(DONE, DONE_TOKEN, "completed");
});

describe("POST /api/track/:token/messages — hostile input", () => {
  it("rejects a malformed JSON body with 400, not a 500", async () => {
    const res = await post(`${LIVE_TOKEN}/messages`, "not json at all");
    expect(res.status).toBe(400);
    expect(await messages(LIVE)).toHaveLength(0);
  });

  it("rejects a missing or null message body with 400", async () => {
    expect((await postJson(`${LIVE_TOKEN}/messages`, { senderName: "Dan" })).status).toBe(400);
    expect((await postJson(`${LIVE_TOKEN}/messages`, { body: null })).status).toBe(400);
    expect(await messages(LIVE)).toHaveLength(0);
  });

  it("rejects a non-string body instead of storing \"[object Object]\"", async () => {
    const res = await postJson(`${LIVE_TOKEN}/messages`, { body: { a: 1 } });
    expect(res.status).toBe(400);
    const rows = await messages(LIVE);
    expect(rows).toHaveLength(0);
    expect(rows.some((r) => String(r.body).includes("object Object"))).toBe(false);
  });

  it("rejects a whitespace-only message", async () => {
    const res = await postJson(`${LIVE_TOKEN}/messages`, { body: "   \n  " });
    expect(res.status).toBe(400);
    expect(await messages(LIVE)).toHaveLength(0);
  });

  it("rejects a message over the 2000-character cap", async () => {
    const res = await postJson(`${LIVE_TOKEN}/messages`, { body: "B".repeat(2001) });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain("too long");
    expect(await messages(LIVE)).toHaveLength(0);
  });

  it("accepts a normal message, trimmed, and bounds the display name", async () => {
    const res = await postJson(`${LIVE_TOKEN}/messages`, {
      body: "  Gate code is 4821, dog is inside  ",
      senderName: "N".repeat(500),
    });
    expect(res.status).toBe(201);
    const rows = await messages(LIVE);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("Gate code is 4821, dog is inside");
    // an over-long name falls back to the default rather than being stored
    expect(rows[0].sender_name).toBe("Client");
  });

  it("keeps a sane sender name when one is given", async () => {
    const res = await postJson(`${LIVE_TOKEN}/messages`, { body: "On my way out", senderName: " Dan R " });
    expect(res.status).toBe(201);
    expect((await messages(LIVE))[0].sender_name).toBe("Dan R");
  });

  it("still 404s an unknown token before touching the body", async () => {
    const res = await postJson("no-such-token/messages", { body: "hello" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/track/:token/review — hostile input", () => {
  it("rejects a non-numeric rating with 400 instead of writing NaN", async () => {
    const res = await postJson(`${DONE_TOKEN}/review`, { rating: "abc" });
    expect(res.status).toBe(400);
    expect(await reviews(DONE)).toHaveLength(0);
  });

  it("rejects a malformed or absent body with 400", async () => {
    expect((await post(`${DONE_TOKEN}/review`, "nope")).status).toBe(400);
    expect((await postJson(`${DONE_TOKEN}/review`, {})).status).toBe(400);
    expect(await reviews(DONE)).toHaveLength(0);
  });

  it("rejects an out-of-range rating instead of clamping it to 5 stars", async () => {
    expect((await postJson(`${DONE_TOKEN}/review`, { rating: 99 })).status).toBe(400);
    expect((await postJson(`${DONE_TOKEN}/review`, { rating: 0 })).status).toBe(400);
    expect((await postJson(`${DONE_TOKEN}/review`, { rating: -3 })).status).toBe(400);
    expect((await postJson(`${DONE_TOKEN}/review`, { rating: 4.5 })).status).toBe(400);
    expect(await reviews(DONE)).toHaveLength(0);
  });

  it("rejects a comment over the 2000-character cap", async () => {
    const res = await postJson(`${DONE_TOKEN}/review`, { rating: 5, comment: "A".repeat(2001) });
    expect(res.status).toBe(400);
    expect(await reviews(DONE)).toHaveLength(0);
  });

  it("accepts a real 1-5 rating with a trimmed comment", async () => {
    const res = await postJson(`${DONE_TOKEN}/review`, { rating: 4, comment: "  Great work  " });
    expect(res.status).toBe(201);
    const rows = await reviews(DONE);
    expect(rows).toHaveLength(1);
    expect(rows[0].rating).toBe(4);
    expect(rows[0].comment).toBe("Great work");
  });

  it("stays idempotent — a second submit returns the first review, not a duplicate", async () => {
    expect((await postJson(`${DONE_TOKEN}/review`, { rating: 5 })).status).toBe(201);
    const res = await postJson(`${DONE_TOKEN}/review`, { rating: 1, comment: "changed my mind" });
    expect(res.status).toBe(200);
    const rows = await reviews(DONE);
    expect(rows).toHaveLength(1);
    expect(rows[0].rating).toBe(5);
  });

  it("still refuses to review a job that isn't complete", async () => {
    const res = await postJson(`${LIVE_TOKEN}/review`, { rating: 5 });
    expect(res.status).toBe(400);
    expect(await reviews(LIVE)).toHaveLength(0);
  });
});
