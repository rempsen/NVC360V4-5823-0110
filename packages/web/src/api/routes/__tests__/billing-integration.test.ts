/**
 * API-level integration tests for the money paths (invoices / payments / ledger).
 *
 * These hit the REAL `paymentsRoutes` Hono handlers end-to-end (routing, auth
 * gate, JSON envelopes, and the tenant-scoped `tx()` data layer) via
 * `app.request(...)`. We deliberately do NOT exercise Stripe network calls:
 * STRIPE is left unconfigured, so the money-mutating endpoints must fail-closed
 * with 503 — which is itself a behaviour we assert. Everything that reads from
 * our own DB (invoice/ledger lookups) is fully exercised, including the
 * cross-tenant isolation guarantee that a company can only ever see its own
 * invoices and ledger entries.
 *
 * Pattern mirrors the service-layer tests: ephemeral in-memory libsql, schema
 * derived from drizzle (so it can't drift from prod), CREATE TABLE IF NOT EXISTS
 * + INSERT OR IGNORE with disjoint ids so it coexists with sibling test files in
 * Bun's shared single-process ":memory:" store.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import { ensureSchema } from "../../database/__tests__/setup";

await ensureSchema();

const { db } = await import("../../database/index");
const { paymentsRoutes } = await import("../payments");
const { AppError } = await import("../../lib/errors");

// Disjoint tenant ids (prefixed so they don't collide with sibling suites).
const A = "payint-company-a";
const B = "payint-company-b";

// ---------------------------------------------------------------------------
// Test harness: mount the REAL routes under a minimal app whose auth shim sets
// exactly what the production authMiddleware sets (user + companyId), driven by
// request headers so each call can act as a chosen tenant/role.
// ---------------------------------------------------------------------------
const app = new Hono().use("*", async (c, next) => {
  const companyId = c.req.header("X-Test-Company") || "default";
  const uid = c.req.header("X-Test-User");
  const role = c.req.header("X-Test-Role") || "owner";
  c.set("companyId", companyId);
  c.set("user", uid ? { id: uid, role, email: `${uid}@t.test`, name: uid } : null);
  return next();
});
app.route("/payments", paymentsRoutes);
// Mirror production's onError: translate AppError -> its real status code, so
// the fail-closed 503 (and other typed errors) surface as the route intends
// rather than a generic Hono 500.
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.expose ? err.message : "error" } }, err.status as 400);
  }
  return c.json({ error: { code: "internal", message: "error" } }, 500);
});

beforeAll(async () => {
  const sql = (db as any).$client;
  const now = new Date();

  // Referenced users (bookings.customerId / riders.userId both FK -> user.id).
  for (const [id, co] of [["cust-a", A], ["cust-b", B], ["u-rider-a", A], ["u-rider-a2", A]] as const) {
    await sql.query(
      `INSERT INTO "user" (id, name, email, role, company_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [id, id, `${id}@t.test`, "customer", co],
    );
  }
  // Referenced services (bookings.serviceId FK -> services.id).
  await sql.query("INSERT INTO services (id, company_id, name, category) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", ["svc-a", A, "A service", "hvac"]);
  await sql.query("INSERT INTO services (id, company_id, name, category) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", ["svc-b", B, "B service", "hvac"]);

  // One booking + one PAID invoice per company. Company A's invoice has a
  // ledger charge entry; both companies' data live side by side so the
  // isolation assertions are meaningful (a leak would surface the other's row).
  await sql.query("INSERT INTO bookings (id, company_id, customer_id, service_id, title, status, address, price, scheduled_at, public_token) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING", ["bk-pa", A, "cust-a", "svc-a", "A job", "completed", "", 100, now, "paytok-bk-pa"]);
  await sql.query("INSERT INTO bookings (id, company_id, customer_id, service_id, title, status, address, price, scheduled_at, public_token) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING", ["bk-pb", B, "cust-b", "svc-b", "B job", "completed", "", 250, now, "paytok-bk-pb"]);

  // Company A also has a booking that has NOT been invoiced yet (the normal
  // state of every job before billing runs) and one assigned to a technician.
  await sql.query("INSERT INTO bookings (id, company_id, customer_id, service_id, title, status, address, price, scheduled_at, public_token) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING", ["bk-pa-noinv", A, "cust-a", "svc-a", "A uninvoiced job", "confirmed", "", 100, now, "paytok-bk-pa-noinv"]);
  await sql.query("INSERT INTO riders (id, user_id, company_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", ["rider-pa", "u-rider-a", A]);
  await sql.query("INSERT INTO riders (id, user_id, company_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", ["rider-pa2", "u-rider-a2", A]);
  await sql.query("INSERT INTO bookings (id, company_id, customer_id, service_id, title, status, address, price, rider_id, scheduled_at, public_token) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING", ["bk-pa-rider", A, "cust-a", "svc-a", "A assigned job", "completed", "", 100, "rider-pa", now, "paytok-bk-pa-rider"]);
  await sql.query("INSERT INTO invoices (id, company_id, booking_id, customer_id, number, amount, tax, total, status, currency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING", ["inv-pa-rider", A, "bk-pa-rider", "cust-a", "INV-A-002", 100, 0, 100, "unpaid", "cad"]);

  await sql.query("INSERT INTO invoices (id, company_id, booking_id, customer_id, number, amount, tax, total, status, currency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING", ["inv-pa", A, "bk-pa", "cust-a", "INV-A-001", 100, 0, 100, "paid", "cad"]);
  await sql.query("INSERT INTO invoices (id, company_id, booking_id, customer_id, number, amount, tax, total, status, currency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING", ["inv-pb", B, "bk-pb", "cust-b", "INV-B-001", 250, 0, 250, "unpaid", "cad"]);

  await sql.query("INSERT INTO payment_ledger (id, company_id, invoice_id, booking_id, kind, amount, currency, status, memo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING", ["led-pa", A, "inv-pa", "bk-pa", "charge", 100, "cad", "succeeded", "A paid"]);
  await sql.query("INSERT INTO payment_ledger (id, company_id, invoice_id, booking_id, kind, amount, currency, status, memo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING", ["led-pb", B, "inv-pb", "bk-pb", "charge", 250, "cad", "succeeded", "B paid"]);
});

/** Tiny helper: call the mounted app as a given tenant/user. */
function call(path: string, opts: { company?: string; user?: string; role?: string; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.company) headers["X-Test-Company"] = opts.company;
  if (opts.user) headers["X-Test-User"] = opts.user;
  if (opts.role) headers["X-Test-Role"] = opts.role;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  return app.request(path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

describe("payments API — auth gate", () => {
  it("rejects unauthenticated invoice reads with 401", async () => {
    const res = await call("/payments/invoice/bk-pa", { company: A }); // no user
    expect(res.status).toBe(401);
  });

  it("config endpoint is public and reports stripe disabled in tests", async () => {
    const res = await call("/payments/config");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { enabled: boolean };
    expect(json.enabled).toBe(false);
  });
});

describe("payments API — invoice reads are tenant-scoped", () => {
  it("owner reads their OWN company's invoice", async () => {
    const res = await call("/payments/invoice/bk-pa", { company: A, user: "u-a" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { invoice: { id: string; total: number } };
    expect(json.invoice.id).toBe("inv-pa");
    expect(json.invoice.total).toBe(100);
  });

  it("a company canNOT read another company's invoice (404, no leak)", async () => {
    // Company A asks for company B's booking invoice → tx() scopes to A → not found.
    const res = await call("/payments/invoice/bk-pb", { company: A, user: "u-a" });
    expect(res.status).toBe(404);
  });

  it("company B reads its own invoice fine (proving the row exists)", async () => {
    const res = await call("/payments/invoice/bk-pb", { company: B, user: "u-b" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { invoice: { id: string; total: number } };
    expect(json.invoice.id).toBe("inv-pb");
    expect(json.invoice.total).toBe(250);
  });

  it("a booking that exists but has no invoice yet is 200 with invoice: null (not 404)", async () => {
    // Regression: this used to 404, so the customer tracking page threw a query
    // error on every perfectly healthy job before its invoice existed.
    const res = await call("/payments/invoice/bk-pa-noinv", { company: A, user: "u-a" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { invoice: unknown };
    expect(json.invoice).toBeNull();
  });

  it("a booking id that does not exist at all is still 404", async () => {
    const res = await call("/payments/invoice/bk-nope", { company: A, user: "u-a" });
    expect(res.status).toBe(404);
  });
});

describe("payments API — invoice reads are ownership-scoped for non-admins", () => {
  it("a customer reads their OWN booking's invoice", async () => {
    const res = await call("/payments/invoice/bk-pa", { company: A, user: "cust-a", role: "customer" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { invoice: { id: string } };
    expect(json.invoice.id).toBe("inv-pa");
  });

  it("a customer canNOT read a CO-TENANT's invoice by guessing the booking id (404)", async () => {
    const res = await call("/payments/invoice/bk-pa", { company: A, user: "cust-other", role: "customer" });
    expect(res.status).toBe(404);
  });

  it("the assigned technician can read the invoice for their own job", async () => {
    const res = await call("/payments/invoice/bk-pa-rider", { company: A, user: "u-rider-a", role: "rider" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { invoice: { id: string } };
    expect(json.invoice.id).toBe("inv-pa-rider");
  });

  it("a technician who is NOT assigned to the job gets 404", async () => {
    const res = await call("/payments/invoice/bk-pa-rider", { company: A, user: "u-rider-a2", role: "rider" });
    expect(res.status).toBe(404);
  });

  it("a signed-in user with no rider profile gets 404 on a rider read", async () => {
    const res = await call("/payments/invoice/bk-pa-rider", { company: A, user: "u-ghost", role: "rider" });
    expect(res.status).toBe(404);
  });
});

describe("payments API — ledger reads are tenant-scoped", () => {
  it("owner sees only their own ledger entries", async () => {
    const res = await call("/payments/ledger/bk-pa", { company: A, user: "u-a" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { entries: { id: string }[] };
    expect(json.entries.map((e) => e.id)).toEqual(["led-pa"]);
  });

  it("cross-tenant ledger probe returns an EMPTY list, never another tenant's rows", async () => {
    // Company A queries company B's booking ledger → scoped to A → zero rows.
    const res = await call("/payments/ledger/bk-pb", { company: A, user: "u-a" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { entries: unknown[] };
    expect(json.entries).toEqual([]);
  });
});

describe("payments API — money mutations fail-closed without Stripe", () => {
  it("creating a payment intent returns 503 when payments are unconfigured", async () => {
    const res = await call("/payments/intent/bk-pa", { company: A, user: "u-a", method: "POST" });
    expect(res.status).toBe(503);
  });

  it("syncing returns 503 when payments are unconfigured", async () => {
    const res = await call("/payments/sync/bk-pa", { company: A, user: "u-a", method: "POST" });
    expect(res.status).toBe(503);
  });

  it("refund returns 503 when payments are unconfigured", async () => {
    const res = await call("/payments/refund/bk-pa", { company: A, user: "u-a", role: "owner", method: "POST", body: {} });
    expect(res.status).toBe(503);
  });
});
