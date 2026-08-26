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
 * Shared local Postgres (see ../../database/__tests__/setup.ts); ids prefixed
 * "tra-".
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { ensureSchema } from "../../database/__tests__/setup";

process.env.RESEND_API_KEY = "";
process.env.TWILIO_AUTH_TOKEN = "";

await ensureSchema();

const { db } = await import("../../database/index");
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

const sql = () => (db as any).$client;

async function seedTarget(role: string) {
  const s = sql();
  await s.query(`DELETE FROM "user" WHERE id = $1`, [TARGET]);
  await s.query("DELETE FROM memberships WHERE user_id = $1", [TARGET]);
  await s.query("DELETE FROM audit_log");
  await s.query(
    `INSERT INTO "user" (id, name, email, email_verified, role, company_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [TARGET, "Joel Tetreault", "joel@nvc360.com", true, role, CO],
  );
  await s.query(
    "INSERT INTO memberships (id, user_id, company_id, role, status) VALUES ($1,$2,$3,$4,$5)",
    [`m-${TARGET}`, TARGET, CO, role, "active"],
  );
}

async function auditRows() {
  const r = await sql().query("SELECT * FROM audit_log ORDER BY created_at DESC");
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
  await s.query(
    `INSERT INTO "user" (id, name, email, email_verified, role, company_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [BOSS, "Dana Boss", "boss@nvc360.com", true, "superadmin", CO],
  );
  await s.query(
    "INSERT INTO memberships (id, user_id, company_id, role, status) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [`m-${BOSS}`, BOSS, CO, "superadmin", "active"],
  );
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
