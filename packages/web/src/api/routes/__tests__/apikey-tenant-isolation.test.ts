/**
 * Per-tenant API-KEY isolation.
 *
 * Requirement: every company gets its own unique API key, and that key can
 * ONLY ever touch its own company's data. The auth layer resolves an API key
 * to a single `companyId` (apiKeys.companyId) and hands it to `tdb(companyId)`,
 * which fail-closes every read/write to that tenant. These tests prove the
 * whole chain end-to-end:
 *
 *   1. issueDefaultTenantKey mints a unique, full-scope SECRET key per company.
 *   2. Two companies never collide on key prefix/hash.
 *   3. resolveApiKey maps a raw key back to EXACTLY its owning companyId.
 *   4. Driving tdb() with the resolved companyId can never read/write across
 *      the tenant boundary — even with the other tenant's exact record id.
 *
 * Same ephemeral in-memory libsql harness as the sibling suites; disjoint ids.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import { ensureSchema } from "../../database/__tests__/setup";

await ensureSchema();

const { db } = await import("../../database/index");
const schema = await import("../../database/schema");
const { tdb } = await import("../../database/tenant");
const { resolveApiKey } = await import("../../middleware/auth");
const { issueDefaultTenantKey, hasActiveSecretKey, ensureDefaultTenantKey } =
  await import("../../lib/tenant-keys");

const A = "akiso-company-a";
const B = "akiso-company-b";

/** Build a header-bearing context shim that resolveApiKey() understands. */
function ctxWithBearer(token: string) {
  return {
    req: {
      header: (k: string) =>
        k.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined,
    },
  };
}

let keyA: { raw: string };
let keyB: { raw: string };

beforeAll(async () => {
  const sql = (db as any).$client;

  // Seed one service per company so we have something to (not) leak.
  await sql.query(
    "INSERT INTO services (id, company_id, name, category) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    ["akiso-svc-a", A, "A service", "hvac"],
  );
  await sql.query(
    "INSERT INTO services (id, company_id, name, category) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    ["akiso-svc-b", B, "B service", "hvac"],
  );

  keyA = await issueDefaultTenantKey({ companyId: A, createdByName: "test" });
  keyB = await issueDefaultTenantKey({ companyId: B, createdByName: "test" });
});

describe("per-tenant key issuance", () => {
  it("each company gets a unique secret key (no prefix/raw collision)", () => {
    expect(keyA.raw).not.toBe(keyB.raw);
    expect(keyA.raw.startsWith("nvc_")).toBe(true);
    expect(keyB.raw.startsWith("nvc_")).toBe(true);
  });

  it("hasActiveSecretKey reports true once a company is provisioned", async () => {
    expect(await hasActiveSecretKey(A)).toBe(true);
    expect(await hasActiveSecretKey("akiso-never-provisioned")).toBe(false);
  });

  it("ensureDefaultTenantKey is idempotent — never mints a second key", async () => {
    const again = await ensureDefaultTenantKey({ companyId: A });
    expect(again.created).toBe(false);
    expect(again.raw).toBeUndefined(); // existing key is unrecoverable
  });
});

describe("key resolves to EXACTLY its owning tenant", () => {
  it("company A's key resolves to companyId A (and full scope)", async () => {
    const resolved = await resolveApiKey(ctxWithBearer(keyA.raw));
    expect(resolved?.companyId).toBe(A);
    expect(resolved?.scopes).toContain("*");
  });

  it("company B's key resolves to companyId B", async () => {
    const resolved = await resolveApiKey(ctxWithBearer(keyB.raw));
    expect(resolved?.companyId).toBe(B);
  });

  it("a garbage / unknown token resolves to null (no tenant)", async () => {
    const resolved = await resolveApiKey(ctxWithBearer("nvc_deadbeefdeadbeef"));
    expect(resolved).toBeNull();
  });
});

describe("a key can ONLY touch its own tenant's data", () => {
  it("company A's key cannot read company B's service, even by exact id", async () => {
    const resolved = await resolveApiKey(ctxWithBearer(keyA.raw));
    const t = tdb(resolved!.companyId);

    // list: only A's rows
    const rows = await t.select(schema.services);
    expect(rows.map((r) => r.id)).toContain("akiso-svc-a");
    expect(rows.map((r) => r.id)).not.toContain("akiso-svc-b");

    // exact-id probe for B's row → invisible
    const leaked = await t.selectOne(
      schema.services,
      eq(schema.services.id, "akiso-svc-b"),
    );
    expect(leaked).toBeUndefined();
  });

  it("company A's key cannot mutate company B's service", async () => {
    const resolved = await resolveApiKey(ctxWithBearer(keyA.raw));
    const t = tdb(resolved!.companyId);

    const affected = await t.update(
      schema.services,
      { name: "HIJACKED" } as any,
      eq(schema.services.id, "akiso-svc-b"),
    );
    expect(affected.length).toBe(0);

    // B's row is untouched, verified through B's own key path
    const bResolved = await resolveApiKey(ctxWithBearer(keyB.raw));
    const bRow = await tdb(bResolved!.companyId).selectOne(
      schema.services,
      eq(schema.services.id, "akiso-svc-b"),
    );
    expect(bRow?.name).toBe("B service");
  });

  it("a revoked key no longer resolves to any tenant", async () => {
    const oneOff = await issueDefaultTenantKey({ companyId: A });
    // revoke it directly
    await db
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(schema.apiKeys.prefix, oneOff.prefix));
    const resolved = await resolveApiKey(ctxWithBearer(oneOff.raw));
    expect(resolved).toBeNull();
  });
});
