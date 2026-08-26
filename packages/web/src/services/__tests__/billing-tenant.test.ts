/**
 * Service-layer tenant-isolation guarantees for the billing service.
 *
 * The route layer was migrated to `tdb` first; these tests close the gap by
 * proving the SERVICE layer is now tenant-enforced too. They assert two
 * regressions are fixed:
 *
 *   1. resolveRegion() reads THIS tenant's company_settings row — not the
 *      legacy `id="default"` singleton, which returned MB/0-tax for every
 *      non-default company (a real tax-calculation bug).
 *   2. recomputeBooking()/accrueTechPay() refuse to read or mutate a booking
 *      that belongs to another company (fail-closed: returns null).
 *
 * Runs against an ephemeral in-memory libsql DB, schema derived from drizzle so
 * it can't drift from production.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import { ensureSchema } from "../../api/database/__tests__/setup";

await ensureSchema();

const { db } = await import("../../api/database/index");
const schema = await import("../../api/database/schema");
const { resolveRegion, recomputeBooking, accrueTechPay } = await import("../billing");

const A = "billtest-company-a";
const B = "billtest-company-b";

beforeAll(async () => {
  const sql = (db as any).$client;

  // FK targets: bookings.customer_id and riders.user_id both reference user.id.
  await sql.query("INSERT INTO \"user\" (id, name, email, email_verified, role, company_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", ["cust-a", "Customer A", "cust-a@t.test", true, "customer", A]);
  await sql.query("INSERT INTO \"user\" (id, name, email, email_verified, role, company_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", ["cust-b", "Customer B", "cust-b@t.test", true, "customer", B]);
  await sql.query("INSERT INTO \"user\" (id, name, email, email_verified, role, company_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", ["u-b", "Rider B", "u-b@t.test", true, "rider", B]);

  // Company A: legacy "default" singleton — region MB. Company B: its OWN row → ON (Ontario).
  await sql.query("INSERT INTO company_settings (id, company_id, default_region) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", ["default", A, "MB"]);
  await sql.query("INSERT INTO company_settings (id, company_id, default_region) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", ["b-settings", B, "ON"]);

  // A service per company (flat $100, no rate model).
  await sql.query("INSERT INTO services (id, company_id, name, category, base_price) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", ["svc-a", A, "A service", "hvac", 100]);
  await sql.query("INSERT INTO services (id, company_id, name, category, base_price) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", ["svc-b", B, "B service", "hvac", 100]);

  // A booking per company. No region on the booking, no parseable address region,
  // so resolveRegion() MUST fall through to the company default.
  await sql.query("INSERT INTO bookings (id, company_id, customer_id, service_id, title, status, address, price, on_site_minutes, scheduled_at, public_token) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING", ["bk-a", A, "cust-a", "svc-a", "A job", "completed", "", 100, 60, new Date(), "billtest-tok-a"]);
  await sql.query("INSERT INTO bookings (id, company_id, customer_id, service_id, title, status, address, price, on_site_minutes, scheduled_at, public_token) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING", ["bk-b", B, "cust-b", "svc-b", "B job", "completed", "", 100, 60, new Date(), "billtest-tok-b"]);

  // Rider for company B (to exercise accrueTechPay scoping).
  await sql.query("INSERT INTO riders (id, company_id, user_id, status, pay_rate_per_hour) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", ["rider-b", B, "u-b", "available", 40]);
  await sql.query("UPDATE bookings SET rider_id = $1 WHERE id = $2", ["rider-b", "bk-b"]);
});

describe("billing service tenant isolation", () => {
  it("resolveRegion reads the tenant's OWN settings, not the legacy default singleton", async () => {
    const [bkA] = await db.select().from(schema.bookings).where(eq(schema.bookings.id, "bk-a"));
    const [bkB] = await db.select().from(schema.bookings).where(eq(schema.bookings.id, "bk-b"));

    // Company A resolves to MB (its row). Company B must resolve to ON —
    // the OLD code read id="default" and would have wrongly returned MB here.
    expect(await resolveRegion(A, bkA)).toBe("MB");
    expect(await resolveRegion(B, bkB)).toBe("ON");
  });

  it("recomputeBooking refuses a booking from another company (fail-closed)", async () => {
    // Company A asking for company B's booking → not in tenant scope → null.
    expect(await recomputeBooking(A, "bk-b")).toBeNull();
    // The legitimate owner still gets a result.
    expect(await recomputeBooking(B, "bk-b", { persist: false })).not.toBeNull();
  });

  it("accrueTechPay refuses a booking from another company (fail-closed)", async () => {
    expect(await accrueTechPay(A, "bk-b")).toBeNull();
    const ownerResult = await accrueTechPay(B, "bk-b");
    expect(ownerResult).not.toBeNull();
    expect(ownerResult?.techPay).toBe(40); // 60 min @ $40/h = $40
  });
});
