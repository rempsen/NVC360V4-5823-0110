/**
 * Regression tests for GET /api/bookings visibility of SOFT-DELETED jobs.
 *
 * Found live: the admin branch of this handler filtered on `deletedAt IS NULL`,
 * but the rider and customer branches did not. A work order an admin deleted
 * therefore stayed in the technician's job list forever, and — because the
 * driver app's Earnings screen aggregated over this same endpoint — it was also
 * padding their completed-jobs count and earned total. A deleted job showing up
 * in someone's pay history is a payroll dispute, not a cosmetic bug.
 *
 * These tests pin the predicate for all three roles, plus the count/total the
 * clients paginate on, so the filter can't be dropped from one branch again.
 *
 * Harness matches the sibling suites: ephemeral in-memory libsql, DDL derived
 * from drizzle, disjoint ids so it coexists with other files in Bun's shared
 * ":memory:" store.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import { getTableConfig, type SQLiteColumn } from "drizzle-orm/sqlite-core";

process.env.DATABASE_URL = ":memory:";
process.env.DATABASE_AUTH_TOKEN = "";

const { db } = await import("../../database/index");
const schema = await import("../../database/schema");
const { bookingsRoutes } = await import("../bookings");
const { AppError } = await import("../../lib/errors");

const CO = "sdel-co";
const RIDER_USER = "sdel-user-rider";
const CUST_USER = "sdel-user-cust";
const ADMIN_USER = "sdel-user-admin";
const RIDER = "sdel-rider";
const SVC = "sdel-svc";

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

let sql: any;

beforeAll(async () => {
  sql = (db as any).$client;
  await sql.execute(ddlFor(schema.companies));
  await sql.execute(ddlFor(schema.riders));
  await sql.execute(ddlFor(schema.bookings));
  await sql.execute(ddlFor(schema.services));
  await sql.execute(ddlFor(schema.user));

  await sql.execute({
    sql: "INSERT OR IGNORE INTO companies (id, name, status) VALUES (?,?,?)",
    args: [CO, "Soft Delete Co", "active"],
  });
  await sql.execute({
    sql: "INSERT OR IGNORE INTO riders (id, user_id, company_id) VALUES (?,?,?)",
    args: [RIDER, RIDER_USER, CO],
  });
  await sql.execute({
    sql: "INSERT OR IGNORE INTO services (id, company_id, name, category) VALUES (?,?,?,?)",
    args: [SVC, CO, "Furnace repair", "hvac"],
  });
  await sql.execute({
    sql: "INSERT OR IGNORE INTO user (id, name, email, role, company_id) VALUES (?,?,?,?,?)",
    args: [CUST_USER, "Pat Customer", "pat.sdel@t.test", "customer", CO],
  });

  const booking = (id: string, status: string, deletedAt: number | null) =>
    sql.execute({
      sql: `INSERT OR IGNORE INTO bookings
              (id, company_id, customer_id, service_id, rider_id, title, status,
               address, scheduled_at, finished_at, price, deleted_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        id, CO, CUST_USER, SVC, RIDER, "Furnace repair", status,
        "1 Test St", Date.now(), status === "completed" ? Date.now() : null, 250, deletedAt,
      ],
    });

  await booking("sdel-live-1", "completed", null);
  await booking("sdel-live-2", "assigned", null);
  await booking("sdel-gone-1", "completed", Date.now() - 3_600_000);
  await booking("sdel-gone-2", "assigned", Date.now() - 7_200_000);
});

async function list(user: string, role: string) {
  const res = await app.request("/bookings", {
    headers: { "X-Test-Company": CO, "X-Test-User": user, "X-Test-Role": role },
  });
  const body = (await res.json()) as {
    bookings: { id: string }[];
    total: number;
  };
  return { res, ids: body.bookings.map((b) => b.id).sort(), total: body.total };
}

describe("GET /api/bookings hides soft-deleted jobs from every role", () => {
  it("does not show a deleted job to the technician it was assigned to", async () => {
    const { res, ids, total } = await list(RIDER_USER, "rider");
    expect(res.status).toBe(200);
    expect(ids).toEqual(["sdel-live-1", "sdel-live-2"]);
    expect(ids).not.toContain("sdel-gone-1");
    // `total` is what the client paginates on — it must agree with the rows.
    expect(total).toBe(2);
  });

  it("does not show a deleted job to the customer who booked it", async () => {
    const { ids, total } = await list(CUST_USER, "customer");
    expect(ids).toEqual(["sdel-live-1", "sdel-live-2"]);
    expect(total).toBe(2);
  });

  it("still hides them from admins (the branch that was always correct)", async () => {
    const { ids, total } = await list(ADMIN_USER, "admin");
    expect(ids).toEqual(["sdel-live-1", "sdel-live-2"]);
    expect(total).toBe(2);
  });

  it("the deleted rows really are in the table — the filter is what hides them", async () => {
    // Without this, all three tests above would also pass if the seed had
    // silently failed to insert the deleted rows at all.
    const r = await sql.execute({
      sql: "SELECT COUNT(*) AS n FROM bookings WHERE company_id = ? AND deleted_at IS NOT NULL",
      args: [CO],
    });
    expect(Number((r.rows[0] as any).n)).toBe(2);
  });
});
