/**
 * Regression guard: the tax a CUSTOMER is quoted before booking must equal the
 * tax they are later INVOICED.
 *
 * What was broken: the customer booking page (web/pages/customer/book.tsx)
 * computed its order summary as `basePrice * 0.13` — Ontario HST — for every
 * customer in every province. The invoice, meanwhile, is produced by
 * services/billing.ts, which resolves the real region from the service address.
 * Measured live against real data on a $140 service:
 *
 *   Calgary, Alberta   quoted $18.20  invoiced  $7.00   (-$11.20)
 *   Montreal, Quebec   quoted $18.20  invoiced $20.97   (+$2.77 — the customer
 *                                                        was billed MORE than
 *                                                        the total they agreed to)
 *   Toronto, Ontario   quoted $18.20  invoiced $18.20   (right by coincidence)
 *
 * The fix moved the quote onto the server: POST /pricing/tax-preview calls the
 * SAME resolveRegion() + lookupTax() + round2() the invoice path uses. These
 * tests hit the REAL pricing route via app.request() and assert its output is
 * penny-identical to recomputeBooking() — the real invoice math — across
 * regions, so the two can never silently drift apart again.
 *
 * Harness pattern mirrors the sibling suites: ephemeral in-memory libsql, DDL
 * derived from drizzle so it can't drift from production, CREATE TABLE IF NOT
 * EXISTS + INSERT OR IGNORE with disjoint ids (Bun shares one ":memory:" store
 * across test files in a single process).
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import { ensureSchema } from "../../database/__tests__/setup";

await ensureSchema();

const { db } = await import("../../database/index");
const { pricingRoutes } = await import("../pricing");
const { recomputeBooking } = await import("../../../services/billing");
const { AppError } = await import("../../lib/errors");

/** Disjoint tenant id so this file coexists with sibling suites. */
const C = "taxquote-company";
const PRICE = 140;

/** Address -> expected region, and the booking seeded at that address. */
const CASES = [
  { key: "on", address: "300 Bay St, Toronto, Ontario", region: "ON", fromAddress: true },
  { key: "ab", address: "100 Main St, Calgary, Alberta", region: "AB", fromAddress: true },
  { key: "qc", address: "200 Rue St, Montreal, Quebec", region: "QC", fromAddress: true },
  // No province/state anywhere in the string -> falls back to the company
  // default (seeded as SK below), and must be flagged as NOT from the address.
  { key: "unknown", address: "somewhere unlabelled 12345", region: "SK", fromAddress: false },
];

const app = new Hono().use("*", async (c, next) => {
  c.set("companyId", c.req.header("X-Test-Company") || "default");
  const uid = c.req.header("X-Test-User");
  c.set("user", uid ? { id: uid, role: "customer", email: `${uid}@t.test`, name: uid } : null);
  return next();
});
app.route("/pricing", pricingRoutes);
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.expose ? err.message : "error" } }, err.status as 400);
  }
  return c.json({ error: { code: "internal", message: "error" } }, 500);
});

beforeAll(async () => {
  const sql = (db as any).$client;

  // Company default is deliberately NOT Ontario, so an Ontario-hardcoded quote
  // can't pass by accident.
  await sql.query(
    "INSERT INTO company_settings (id, company_id, default_region) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
    ["taxquote-settings", C, "SK"],
  );
  await sql.query(
    "INSERT INTO services (id, company_id, name, category, base_price) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    ["svc-tq", C, "Tax quote service", "hvac", PRICE],
  );
  await sql.query(
    `INSERT INTO "user" (id, name, email, role, company_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    ["cust-tq", "Tax Quote Customer", "cust-tq@t.test", "customer", C],
  );

  // One booking per case, at the same price the customer was quoted, with no
  // explicit region — exactly what POST /api/bookings creates from the page.
  for (const c of CASES) {
    await sql.query(
      "INSERT INTO bookings (id, company_id, customer_id, service_id, title, status, address, price, scheduled_at, public_token) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING",
      [`bk-tq-${c.key}`, C, "cust-tq", "svc-tq", "Tax quote job", "pending", c.address, PRICE, new Date(), `taxtok-${c.key}`],
    );
  }
});

function preview(body: unknown, opts: { user?: string | null } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-Test-Company": C };
  const user = opts.user === undefined ? "u-tq" : opts.user;
  if (user) headers["X-Test-User"] = user;
  return app.request("/pricing/tax-preview", { method: "POST", headers, body: JSON.stringify(body) });
}

describe("POST /pricing/tax-preview — auth + validation", () => {
  it("rejects an unauthenticated caller (the quote reads tenant settings)", async () => {
    const res = await preview({ address: CASES[0]!.address, amount: PRICE }, { user: null });
    expect(res.status).toBe(401);
  });

  it("rejects a negative amount", async () => {
    const res = await preview({ address: CASES[0]!.address, amount: -1 });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("accepts a missing address and falls back to the company default", async () => {
    const res = await preview({ amount: PRICE });
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(j.region).toBe("SK");
    expect(j.fromAddress).toBe(false);
  });
});

describe("quoted tax == invoiced tax, per region", () => {
  for (const c of CASES) {
    it(`${c.address} resolves ${c.region} and matches the invoice to the penny`, async () => {
      const res = await preview({ address: c.address, amount: PRICE });
      expect(res.status).toBe(200);
      const quote = (await res.json()) as {
        region: string; taxRatePct: number; taxLabel: string;
        taxAmount: number; total: number; fromAddress: boolean;
      };

      // The real invoice path, on a real booking at that same address.
      const invoice = await recomputeBooking(C, `bk-tq-${c.key}`, { persist: false });
      expect(invoice).not.toBeNull();

      expect(quote.region).toBe(c.region);
      expect(quote.fromAddress).toBe(c.fromAddress);
      expect(quote.taxRatePct).toBe(invoice!.taxRatePct);
      expect(quote.taxLabel).toBe(invoice!.taxLabel);
      expect(quote.taxAmount).toBe(invoice!.taxAmount);
      expect(quote.total).toBe(invoice!.total);
    });
  }

  it("the regions actually differ — this test would be vacuous otherwise", async () => {
    const rates = await Promise.all(
      CASES.map(async (c) => ((await (await preview({ address: c.address, amount: PRICE })).json()) as any).taxRatePct),
    );
    expect(new Set(rates).size).toBeGreaterThan(2);
  });

  it("a hardcoded 13% would FAIL for Alberta and Quebec (the original bug)", async () => {
    const hardcoded = Math.round(PRICE * 0.13 * 100) / 100; // 18.20
    for (const key of ["ab", "qc"]) {
      const c = CASES.find((x) => x.key === key)!;
      const j = (await (await preview({ address: c.address, amount: PRICE })).json()) as any;
      expect(j.taxAmount).not.toBe(hardcoded);
    }
  });
});
