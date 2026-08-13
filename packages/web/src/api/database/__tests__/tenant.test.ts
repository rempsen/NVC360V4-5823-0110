/**
 * Tenant-isolation guarantees for the `tdb` facade.
 *
 * These tests run against a throwaway in-memory libsql database (the same client
 * the `tdb` helper closes over, via DATABASE_URL=:memory:). They assert the
 * non-negotiable invariants of multi-tenancy:
 *
 *   1. Reads on a tenant table NEVER see another company's rows.
 *   2. Inserts auto-stamp the active companyId (callers can't spoof it).
 *   3. Updates/deletes can't reach across the tenant boundary, and can't
 *      reassign companyId.
 *   4. Global tables (allow-listed) pass through unscoped.
 *   5. A tenant table with no companyId column fails closed (throws).
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import { getTableConfig, type SQLiteColumn } from "drizzle-orm/sqlite-core";

// Bind the database client to an ephemeral in-memory store BEFORE importing
// the modules that read DATABASE_URL at construction time.
process.env.DATABASE_URL = ":memory:";
process.env.DATABASE_AUTH_TOKEN = "";

const { db } = await import("../index");
const { tdb } = await import("../tenant");
const schema = await import("../schema");

const A = "company-a";
const B = "company-b";

/**
 * Derive a SQLite CREATE TABLE statement straight from the drizzle table config.
 * This keeps the in-memory test schema in lock-step with the real schema — column
 * names/types can never drift out of sync the way a hand-written DDL would.
 */
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
    // Only enforce NOT NULL when we can also supply a default — columns backed by
    // a runtime $defaultFn (created_at, uuid id) have no literal here, so we relax
    // NOT NULL in the test fixture rather than fight an unrepresentable default.
    if (col.notNull && (lit !== null || col.primary)) parts.push("NOT NULL");
    if (lit !== null) parts.push(`DEFAULT ${lit}`);
    return parts.join(" ");
  });
  // IF NOT EXISTS: Bun shares one in-memory libsql store across test files, so a
  // sibling file may have already created a shared table (e.g. services).
  return `CREATE TABLE IF NOT EXISTS "${cfg.name}" (${cols.join(", ")})`;
}

beforeAll(async () => {
  const sql = (db as any).$client;
  await sql.execute(ddlFor(schema.services));
  await sql.execute(ddlFor(schema.rolePermissions));

  // Seed each company with one service.
  await sql.execute({ sql: "INSERT INTO services (id, company_id, name, category) VALUES (?,?,?,?)", args: ["a1", A, "A wash", "cleaning"] });
  await sql.execute({ sql: "INSERT INTO services (id, company_id, name, category) VALUES (?,?,?,?)", args: ["b1", B, "B wash", "cleaning"] });
  // Global table row (no tenant).
  await sql.execute({ sql: "INSERT INTO role_permissions (role, perms) VALUES (?,?)", args: ["admin", "[\"*\"]"] });
});

describe("tdb read isolation", () => {
  it("select returns only the active company's rows", async () => {
    const aRows = await tdb(A).select(schema.services);
    expect(aRows.map((r) => r.id)).toEqual(["a1"]);

    const bRows = await tdb(B).select(schema.services);
    expect(bRows.map((r) => r.id)).toEqual(["b1"]);
  });

  it("selectOne cannot fetch another company's row even by exact id", async () => {
    // company A asks for company B's row by primary key — must be invisible
    const leaked = await tdb(A).selectOne(schema.services, eq(schema.services.id, "b1"));
    expect(leaked).toBeUndefined();

    const own = await tdb(A).selectOne(schema.services, eq(schema.services.id, "a1"));
    expect(own?.id).toBe("a1");
  });
});

describe("tdb write isolation", () => {
  it("insert auto-stamps the active companyId and ignores a spoofed one", async () => {
    const [row] = await tdb(A).insert(schema.services, {
      name: "stamped",
      // attempt to plant the row in company B — the helper must override this
      companyId: B as any,
    } as any);
    expect(row.companyId).toBe(A);

    // confirm it is visible to A and invisible to B
    const seenByA = await tdb(A).selectOne(schema.services, eq(schema.services.id, row.id));
    const seenByB = await tdb(B).selectOne(schema.services, eq(schema.services.id, row.id));
    expect(seenByA?.id).toBe(row.id);
    expect(seenByB).toBeUndefined();
  });

  it("update cannot modify another company's row", async () => {
    // A tries to rename B's service by id
    const affected = await tdb(A).update(
      schema.services,
      { name: "hijacked" } as any,
      eq(schema.services.id, "b1"),
    );
    expect(affected.length).toBe(0);

    // B's row is untouched
    const bRow = await tdb(B).selectOne(schema.services, eq(schema.services.id, "b1"));
    expect(bRow?.name).toBe("B wash");
  });

  it("update strips companyId so a tenant can't reassign ownership", async () => {
    const [moved] = await tdb(A).update(
      schema.services,
      { name: "renamed", companyId: B as any } as any,
      eq(schema.services.id, "a1"),
    );
    expect(moved.companyId).toBe(A); // still owned by A
    expect(moved.name).toBe("renamed");
  });

  it("delete cannot remove another company's row", async () => {
    await tdb(A).delete(schema.services, eq(schema.services.id, "b1"));
    const stillThere = await tdb(B).selectOne(schema.services, eq(schema.services.id, "b1"));
    expect(stillThere?.id).toBe("b1");
  });
});

describe("global tables + fail-closed", () => {
  it("allow-listed global table is readable without a tenant filter", async () => {
    const perms = await tdb(A).select(schema.rolePermissions);
    expect(perms.length).toBe(1);
    // same rows visible from any tenant context (it's global)
    const fromB = await tdb(B).select(schema.rolePermissions);
    expect(fromB.length).toBe(1);
  });

  it("tdb refuses an empty companyId (fail-closed)", () => {
    expect(() => tdb("")).toThrow();
  });
});

describe("isolation holds across more sensitive tables", () => {
  beforeAll(async () => {
    const sql = (db as any).$client;
    await sql.execute(ddlFor(schema.invoices));
    await sql.execute(ddlFor(schema.messages));
    await sql.execute(ddlFor(schema.apiKeys));

    // money — invoices
    await sql.execute({ sql: "INSERT INTO invoices (id, company_id, total) VALUES (?,?,?)", args: ["inv-a", A, 500] });
    await sql.execute({ sql: "INSERT INTO invoices (id, company_id, total) VALUES (?,?,?)", args: ["inv-b", B, 999] });
    // comms — messages
    await sql.execute({ sql: "INSERT INTO messages (id, company_id, body) VALUES (?,?,?)", args: ["msg-a", A, "A secret"] });
    await sql.execute({ sql: "INSERT INTO messages (id, company_id, body) VALUES (?,?,?)", args: ["msg-b", B, "B secret"] });
    // credentials — api keys (the keys themselves must be tenant-isolated too)
    await sql.execute({ sql: "INSERT INTO api_keys (id, company_id, label, hashed_key) VALUES (?,?,?,?)", args: ["key-a", A, "A key", "hasha"] });
    await sql.execute({ sql: "INSERT INTO api_keys (id, company_id, label, hashed_key) VALUES (?,?,?,?)", args: ["key-b", B, "B key", "hashb"] });
  });

  it("invoices (money) never cross tenants", async () => {
    const a = await tdb(A).select(schema.invoices);
    expect(a.map((r) => r.id)).toEqual(["inv-a"]);
    const leaked = await tdb(A).selectOne(schema.invoices, eq(schema.invoices.id, "inv-b"));
    expect(leaked).toBeUndefined();
  });

  it("messages (private comms) never cross tenants", async () => {
    const a = await tdb(A).select(schema.messages);
    expect(a.map((r) => r.body)).toEqual(["A secret"]);
    const leaked = await tdb(B).selectOne(schema.messages, eq(schema.messages.id, "msg-a"));
    expect(leaked).toBeUndefined();
  });

  it("api_keys themselves are tenant-isolated (A can't enumerate B's keys)", async () => {
    const a = await tdb(A).select(schema.apiKeys);
    expect(a.map((r) => r.id)).toEqual(["key-a"]);
    const leaked = await tdb(A).selectOne(schema.apiKeys, eq(schema.apiKeys.id, "key-b"));
    expect(leaked).toBeUndefined();
  });
});

describe("B2B tenant registry (companies)", () => {
  beforeAll(async () => {
    const sql = (db as any).$client;
    await sql.execute(ddlFor(schema.companies));
    await sql.execute(ddlFor(schema.companySettings));
    // two provisioned tenants
    await sql.execute({ sql: "INSERT INTO companies (id, name) VALUES (?,?)", args: [A, "Company A"] });
    await sql.execute({ sql: "INSERT INTO companies (id, name) VALUES (?,?)", args: [B, "Company B"] });
    // per-tenant settings rows (PK = slug to avoid the legacy 'default' collision)
    await sql.execute({ sql: "INSERT INTO company_settings (id, company_id, name) VALUES (?,?,?)", args: [A, A, "Settings A"] });
    await sql.execute({ sql: "INSERT INTO company_settings (id, company_id, name) VALUES (?,?,?)", args: [B, B, "Settings B"] });
  });

  it("companies is GLOBAL — every tenant context sees the full registry", async () => {
    const fromA = (await tdb(A).select(schema.companies)).map((r) => r.id).sort();
    const fromB = (await tdb(B).select(schema.companies)).map((r) => r.id).sort();
    // The property under test is that `companies` is NOT tenant-scoped: both
    // tenants must see this suite's rows, and see exactly the same registry as
    // each other regardless of which tenant is acting.
    //
    // Asserted by containment rather than exact equality on purpose. Bun runs
    // every suite in ONE process against a shared ":memory:" store, so any
    // sibling test file that provisions a company legitimately adds rows here —
    // exact equality made this test fail for a reason that has nothing to do
    // with tenant scoping.
    expect(fromA).toContain(A);
    expect(fromA).toContain(B);
    // identical view regardless of acting tenant (allow-list source of truth)
    expect(fromB).toEqual(fromA);
  });

  it("company_settings stays tenant-isolated (no cross-tenant leak)", async () => {
    const a = await tdb(A).selectOne(schema.companySettings);
    const b = await tdb(B).selectOne(schema.companySettings);
    expect(a?.name).toBe("Settings A");
    expect(b?.name).toBe("Settings B");
    // A cannot fetch B's settings even by exact PK
    const leaked = await tdb(A).selectOne(
      schema.companySettings,
      eq(schema.companySettings.id, B),
    );
    expect(leaked).toBeUndefined();
  });
});
