/**
 * Shifts and time off. This router had NO validation at all: it read
 * `await c.req.json()` and wrote whatever came back.
 *
 * - `new Date(b.date)` on anything unparseable stored an Invalid Date (NaN), which
 *   is a row the technician's calendar can never render or delete sensibly.
 * - `startMin` / `endMin` were taken raw: a string, a negative number, 9999, or an
 *   end before the start all stored happily and drew a broken bar.
 * - `riderId` was never resolved, so a stale id hit the foreign key as a bare 500,
 *   and an id belonging to another company was accepted.
 * - PUT and DELETE returned 200 for ids that don't exist — "saved!" for a no-op.
 * - The date picker sends a plain day ("2026-09-15") which `new Date()` reads as
 *   UTC midnight, i.e. the PREVIOUS day for every North American tenant. Time off
 *   booked for Tuesday was stored (and enforced) as Monday.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { getTableConfig, type SQLiteColumn } from "drizzle-orm/sqlite-core";

process.env.DATABASE_URL = ":memory:";
process.env.DATABASE_AUTH_TOKEN = "";

const { db } = await import("../../database/index");
const schema = await import("../../database/schema");
const { shiftsRoutes } = await import("../shifts");
const { AppError } = await import("../../lib/errors");

const CO = "sh-co";
const OTHER_CO = "sh-other-co";
const ADMIN = "sh-admin";
const RIDER = "sh-rider";
const OTHER_RIDER = "sh-rider-other";

const app = new Hono().use("*", async (c, next) => {
  c.set("companyId", CO);
  const role = c.req.header("X-Test-Role") || "admin";
  c.set("user", { id: ADMIN, role, email: "office@t.test", name: "Office" });
  return next();
});
app.route("/shifts", shiftsRoutes);
app.onError((err, c) => {
  if (err instanceof AppError)
    return c.json({ message: err.message, error: { code: err.code } }, err.status as 400);
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

function req(path: string, opts: { method?: string; json?: unknown; role?: string } = {}) {
  return app.request(path, {
    method: opts.method ?? "GET",
    headers: { "Content-Type": "application/json", "X-Test-Role": opts.role ?? "admin" },
    body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
  });
}

const post = (json: unknown, role?: string) => req("/shifts", { method: "POST", json, role });

async function rows() {
  const r = await sqlClient().execute("SELECT * FROM tech_shifts");
  return r.rows as any[];
}

beforeAll(async () => {
  const s = sqlClient();
  for (const t of [schema.techShifts, schema.riders, schema.user, schema.companySettings]) {
    await s.execute(ddlFor(t));
  }
  await s.execute({
    sql: "INSERT OR IGNORE INTO user (id, company_id, name, email, role, email_verified) VALUES (?,?,?,?,?,0)",
    args: ["sh-user", CO, "Mike", "mike@t.test", "rider"],
  });
  await s.execute({
    sql: "INSERT OR IGNORE INTO riders (id, company_id, user_id, status) VALUES (?,?,?,?)",
    args: [RIDER, CO, "sh-user", "available"],
  });
  await s.execute({
    sql: "INSERT OR IGNORE INTO riders (id, company_id, user_id, status) VALUES (?,?,?,?)",
    args: [OTHER_RIDER, OTHER_CO, "sh-user", "available"],
  });
  await s.execute({
    sql: "INSERT OR IGNORE INTO company_settings (company_id, timezone) VALUES (?,?)",
    args: [CO, "America/Winnipeg"],
  });
});

beforeEach(async () => {
  await sqlClient().execute("DELETE FROM tech_shifts");
});

describe("POST /shifts — what it refuses to store", () => {
  it("still requires a tech and a date", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ riderId: RIDER })).status).toBe(400);
  });

  it("refuses a date it cannot read instead of storing Invalid Date", async () => {
    const res = await post({ riderId: RIDER, date: "not a date" });
    expect(res.status).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  it("refuses an unknown technician instead of failing on the foreign key", async () => {
    const res = await post({ riderId: "sh-nope", date: "2026-09-15" });
    expect(res.status).toBe(404);
  });

  it("refuses a technician who works for another company", async () => {
    const res = await post({ riderId: OTHER_RIDER, date: "2026-09-15" });
    expect(res.status).toBe(404);
  });

  it("refuses a shift that ends before it starts", async () => {
    const res = await post({ riderId: RIDER, date: "2026-09-15", startMin: 1020, endMin: 540 });
    expect(res.status).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  it("refuses times outside a real day", async () => {
    expect((await post({ riderId: RIDER, date: "2026-09-15", startMin: -60, endMin: 600 })).status).toBe(400);
    expect((await post({ riderId: RIDER, date: "2026-09-15", startMin: 60, endMin: 5000 })).status).toBe(400);
    expect((await post({ riderId: RIDER, date: "2026-09-15", startMin: "nine" })).status).toBe(400);
  });

  it("refuses a kind that is neither a shift nor time off", async () => {
    expect((await post({ riderId: RIDER, date: "2026-09-15", kind: "holiday-ish" })).status).toBe(400);
  });

  it("is still office-only", async () => {
    expect((await post({ riderId: RIDER, date: "2026-09-15" }, "rider")).status).toBe(403);
  });
});

describe("POST /shifts — the day the office picked", () => {
  it("stores a picked day as that day on the company's clock, not UTC", async () => {
    const res = await post({ riderId: RIDER, kind: "timeoff", date: "2026-09-15" });
    expect(res.status).toBe(201);
    const [row] = await rows();
    // 2026-09-15 00:00 in Winnipeg (CDT, UTC-5) = 05:00Z. Stored as UTC midnight
    // it would have been Sept 14 locally — the wrong day off.
    expect(Number(row.date)).toBe(Date.UTC(2026, 8, 15, 5, 0, 0));
  });

  it("still accepts a timestamp from an older client", async () => {
    const ms = Date.UTC(2026, 8, 15, 18, 30, 0);
    const res = await post({ riderId: RIDER, date: ms });
    expect(res.status).toBe(201);
    const [row] = await rows();
    // Normalised to the start of that day on the company clock.
    expect(Number(row.date)).toBe(Date.UTC(2026, 8, 15, 5, 0, 0));
  });

  it("keeps the hours the office typed", async () => {
    await post({ riderId: RIDER, date: "2026-09-15", startMin: 420, endMin: 960, note: "Early start" });
    const [row] = await rows();
    expect(Number(row.start_min)).toBe(420);
    expect(Number(row.end_min)).toBe(960);
    expect(row.note).toBe("Early start");
  });
});

describe("PUT / DELETE /shifts/:id", () => {
  async function seed() {
    const res = await post({ riderId: RIDER, date: "2026-09-15" });
    return (await res.json()).shift.id as string;
  }

  it("says not found instead of pretending to save a row that isn't there", async () => {
    expect((await req("/shifts/sh-ghost", { method: "PUT", json: { startMin: 600 } })).status).toBe(404);
    expect((await req("/shifts/sh-ghost", { method: "DELETE" })).status).toBe(404);
  });

  it("validates an edit the same way as a create", async () => {
    const id = await seed();
    expect((await req(`/shifts/${id}`, { method: "PUT", json: { startMin: 900, endMin: 800 } })).status).toBe(400);
    expect((await req(`/shifts/${id}`, { method: "PUT", json: { date: "rubbish" } })).status).toBe(400);
    expect((await req(`/shifts/${id}`, { method: "PUT", json: { kind: "nope" } })).status).toBe(400);
  });

  it("saves a real edit", async () => {
    const id = await seed();
    const res = await req(`/shifts/${id}`, { method: "PUT", json: { kind: "timeoff", note: "Sick" } });
    expect(res.status).toBe(200);
    const [row] = await rows();
    expect(row.kind).toBe("timeoff");
    expect(row.note).toBe("Sick");
  });

  it("deletes a real row", async () => {
    const id = await seed();
    expect((await req(`/shifts/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(await rows()).toHaveLength(0);
  });

  it("is office-only", async () => {
    const id = await seed();
    expect((await req(`/shifts/${id}`, { method: "DELETE", role: "rider" })).status).toBe(403);
  });
});
