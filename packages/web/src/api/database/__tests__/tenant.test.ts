/**
 * Tenant-isolation guarantees for the `tdb` facade.
 *
 * These tests run against the shared local Postgres (see
 * ../database/__tests__/setup.ts) that the `tdb` helper closes over. They
 * assert the non-negotiable invariants of multi-tenancy:
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
import { ensureSchema } from "./setup";

await ensureSchema();

const { db } = await import("../index");
const { tdb } = await import("../tenant");
const schema = await import("../schema");

const A = "company-a";
const B = "company-b";

beforeAll(async () => {
  const sql = (db as any).$client;

  // Seed each company with one service.
  await sql.query("INSERT INTO services (id, company_id, name, category) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", ["a1", A, "A wash", "cleaning"]);
  await sql.query("INSERT INTO services (id, company_id, name, category) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", ["b1", B, "B wash", "cleaning"]);
  // Global table row (no tenant).
  await sql.query("INSERT INTO role_permissions (role, perms) VALUES ($1,$2) ON CONFLICT DO NOTHING", ["admin", "[\"*\"]"]);
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
      category: "cleaning", // required — not the field under test, just a valid row
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

    // invoices.bookingId/customerId are real FKs now (Postgres enforces them;
    // the old ad-hoc SQLite test DDL silently never did) — scaffold the
    // minimum valid user + booking row for both invoices to reference. Not
    // under test here, just satisfying constraints.
    await sql.query('INSERT INTO "user" (id, name, email) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', ["scaffold-user", "Scaffold Customer", "scaffold@example.com"]);
    await sql.query("INSERT INTO bookings (id, customer_id, service_id, scheduled_at, address, public_token) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", ["scaffold-booking", "scaffold-user", "a1", new Date(), "123 Test St", "scaffoldtoken1"]);

    // money — invoices
    await sql.query("INSERT INTO invoices (id, company_id, booking_id, customer_id, number, amount, total) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", ["inv-a", A, "scaffold-booking", "scaffold-user", "INV-A-1", 500, 500]);
    await sql.query("INSERT INTO invoices (id, company_id, booking_id, customer_id, number, amount, total) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", ["inv-b", B, "scaffold-booking", "scaffold-user", "INV-B-1", 999, 999]);
    // comms — messages
    await sql.query("INSERT INTO messages (id, company_id, sender_role, body) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", ["msg-a", A, "client", "A secret"]);
    await sql.query("INSERT INTO messages (id, company_id, sender_role, body) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", ["msg-b", B, "client", "B secret"]);
    // credentials — api keys (the keys themselves must be tenant-isolated too)
    await sql.query("INSERT INTO api_keys (id, company_id, label, hashed_key) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", ["key-a", A, "A key", "hasha"]);
    await sql.query("INSERT INTO api_keys (id, company_id, label, hashed_key) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", ["key-b", B, "B key", "hashb"]);
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
    // two provisioned tenants
    await sql.query("INSERT INTO companies (id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [A, "Company A"]);
    await sql.query("INSERT INTO companies (id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [B, "Company B"]);
    // per-tenant settings rows (PK = slug to avoid the legacy 'default' collision)
    await sql.query("INSERT INTO company_settings (id, company_id, name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [A, A, "Settings A"]);
    await sql.query("INSERT INTO company_settings (id, company_id, name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [B, B, "Settings B"]);
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
