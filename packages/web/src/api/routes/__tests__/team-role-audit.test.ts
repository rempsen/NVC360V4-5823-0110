/**
 * ROLE CHANGES MUST LEAVE A TRAIL.
 *
 * Promoting Joel Tetreault to superadmin through PATCH /api/team/:id worked —
 * and wrote NOTHING to audit_log. Every other consequential admin action in the
 * product (settings edits, cancel approvals, exports) is audited, but the single
 * most security-relevant one, "who granted whom admin/superadmin and when", was
 * invisible. That is the entry an incident review needs first.
 *
 * These tests drive the real teamRoutes handler and assert on the real
 * audit_log rows:
 *   - promotion writes one entry naming the actor, the target, and both roles
 *   - demotion writes one too
 *   - a no-op role (same value) and a name-only edit write NOTHING, so the log
 *     doesn't fill with noise that hides the real events
 *   - the entry is stamped with the acting tenant, not "default"
 *
 * Ephemeral in-memory libsql; ids prefixed "tra-".
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
const { teamRoutes } = await import("../team");

const CO = "tra-co";
const BOSS = "tra-boss";
const TARGET = "tra-target";

const app = new Hono().use("*", async (c, next) => {
  const companyId = c.req.header("X-Test-Company") || CO;
  const uid = c.req.header("X-Test-User") || BOSS;
  const role = c.req.header("X-Test-Role") || "superadmin";
  c.set("companyId", companyId);
  c.set("user", { id: uid, role, email: `${uid}@nvc360.com`, name: "Dana Boss" });
  return next();
});
app.route("/team", teamRoutes);

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

const sql = () => (db as any).$client;

async function seedTarget(role: string) {
  const s = sql();
  await s.execute({ sql: "DELETE FROM user WHERE id = ?", args: [TARGET] });
  await s.execute({ sql: "DELETE FROM memberships WHERE user_id = ?", args: [TARGET] });
  await s.execute({ sql: "DELETE FROM audit_log", args: [] });
  await s.execute({
    sql: "INSERT INTO user (id, name, email, email_verified, role, company_id) VALUES (?,?,?,?,?,?)",
    args: [TARGET, "Joel Tetreault", "joel@nvc360.com", 1, role, CO],
  });
  await s.execute({
    sql: "INSERT INTO memberships (id, user_id, company_id, role, status) VALUES (?,?,?,?,?)",
    args: [`m-${TARGET}`, TARGET, CO, role, "active"],
  });
}

async function auditRows() {
  const r = await sql().execute("SELECT * FROM audit_log ORDER BY created_at DESC");
  return r.rows as any[];
}

function patch(body: unknown, opts: { company?: string } = {}) {
  return app.request(`/team/${TARGET}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "X-Test-Company": opts.company ?? CO,
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const s = sql();
  await s.execute(ddlFor(schema.user));
  await s.execute(ddlFor(schema.memberships));
  await s.execute(ddlFor(schema.auditLog));
  await s.execute(ddlFor(schema.riders));
  await s.execute({
    sql: "INSERT OR IGNORE INTO user (id, name, email, email_verified, role, company_id) VALUES (?,?,?,?,?,?)",
    args: [BOSS, "Dana Boss", "boss@nvc360.com", 1, "superadmin", CO],
  });
  await s.execute({
    sql: "INSERT OR IGNORE INTO memberships (id, user_id, company_id, role, status) VALUES (?,?,?,?,?)",
    args: [`m-${BOSS}`, BOSS, CO, "superadmin", "active"],
  });
});

describe("role changes are audited", () => {
  beforeEach(async () => {
    await seedTarget("admin");
  });

  it("logs a promotion with actor, target and both roles", async () => {
    const res = await patch({ role: "superadmin" });
    expect(res.status).toBe(200);

    const rows = await auditRows();
    expect(rows.length).toBe(1);
    const e = rows[0];
    expect(e.action).toBe("role_change");
    expect(e.entity_type).toBe("user");
    expect(e.entity_id).toBe(TARGET);
    expect(e.actor_id).toBe(BOSS);
    expect(e.actor_name).toBe("Dana Boss");
    expect(String(e.summary)).toContain("Joel Tetreault");
    expect(String(e.summary)).toContain("admin");
    expect(String(e.summary)).toContain("superadmin");
    const meta = JSON.parse(String(e.meta || "{}"));
    expect(meta.from).toBe("admin");
    expect(meta.to).toBe("superadmin");
    expect(meta.email).toBe("joel@nvc360.com");
  });

  it("logs a demotion too", async () => {
    await seedTarget("superadmin");
    const res = await patch({ role: "dispatcher" });
    expect(res.status).toBe(200);
    const rows = await auditRows();
    expect(rows.length).toBe(1);
    const meta = JSON.parse(String(rows[0].meta || "{}"));
    expect(meta.from).toBe("superadmin");
    expect(meta.to).toBe("dispatcher");
  });

  it("writes nothing when the role is unchanged", async () => {
    const res = await patch({ role: "admin", name: "Joel Tetreault" });
    expect(res.status).toBe(200);
    expect((await auditRows()).length).toBe(0);
  });

  it("writes nothing for a name-only edit", async () => {
    const res = await patch({ name: "Joel T" });
    expect(res.status).toBe(200);
    expect((await auditRows()).length).toBe(0);
  });

  it("stamps the entry with the acting tenant", async () => {
    await patch({ role: "manager" });
    const rows = await auditRows();
    expect(rows[0].company_id).toBe(CO);
  });

  it("does not log when the change is rejected", async () => {
    // a non-superadmin may not touch an admin-tier account
    const res = await app.request(`/team/${TARGET}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "X-Test-Company": CO,
        "X-Test-User": "tra-mgr",
        "X-Test-Role": "manager",
      },
      body: JSON.stringify({ role: "rider" }),
    });
    expect(res.status).toBe(403);
    expect((await auditRows()).length).toBe(0);
  });
});
