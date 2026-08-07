/**
 * Fix 8 verification — request-body validation across the high-risk routes.
 *
 * Every probe below is a request that the API ACCEPTED before this pass. They
 * are grouped by the damage each one caused:
 *
 *  - bookings:  free-text status, out-of-range review ratings, "next tuesday"
 *               as a schedule date, cross-tenant technician assignment, and
 *               mass assignment of id/companyId through PATCH.
 *  - payouts:   a negative platform fee, which makes net > gross — the platform
 *               paying a technician MORE than the customer paid.
 *  - payments:  a NaN refund amount, which slips past `Math.min(NaN, remaining)`
 *               and the `amount <= 0` guard and reaches the Stripe API.
 *  - catalog:   negative unit costs and mass assignment through PATCH.
 *  - pricing:   non-numeric quantities feeding computeSubtotal().
 *
 * Also asserts the happy paths still work, and cleans up every fixture.
 * Fixtures use riderId: null on purpose — fireEvent() on a booking with a rider
 * sends a REAL SMS.
 *
 * Run: bun verify-fix8.ts   (server must be up on :4200)
 */
const BASE = process.env.BASE || "http://localhost:4200";
const EMAIL = "dan@nvc360.com";
const PASSWORD = "NVC423!!";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
};

const tokRes = await fetch(`${BASE}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const TOK = ((await tokRes.json()) as any).token as string;
if (!TOK) throw new Error("sign-in failed");

const H = { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" };
const req = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
};

/** A 400 that names the offending field, not a generic 500. */
const rejects = (label: string, r: { status: number; json: any }, field?: string) => {
  check(`${label} → 400`, r.status === 400, `status=${r.status}`);
  if (field) {
    check(
      `${label} names \`${field}\``,
      !!r.json?.fields?.[field],
      JSON.stringify(r.json?.fields ?? {}).slice(0, 160),
    );
  }
};

const cleanup: Array<() => Promise<unknown>> = [];

/* ---------------------------------------------------------------- fixtures */
const svcList = await req("GET", "/api/services");
const serviceId = svcList.json?.services?.[0]?.id;
if (!serviceId) throw new Error("no service to build a fixture booking on");

const custList = await req("GET", "/api/admin/users");
const customerId =
  custList.json?.users?.find((u: any) => u.role === "customer")?.id ??
  custList.json?.users?.[0]?.id;

const mk = await req("POST", "/api/bookings/admin", {
  customerId,
  serviceId,
  riderId: null, // never a real rider: assignment fires a real SMS
  title: "ZZ Fixture verify-fix8",
  address: "1 Test St",
  scheduledAt: new Date(Date.now() + 86400_000).toISOString(),
});
const bookingId = mk.json?.booking?.id;
if (!bookingId) {
  console.error("fixture booking failed:", mk.status, JSON.stringify(mk.json).slice(0, 300));
  process.exit(1);
}
// There is no hard delete for bookings by design (they carry invoices and an
// audit trail), so the fixture is cancelled instead.
cleanup.push(() => req("POST", `/api/bookings/${bookingId}/cancel`));

console.log("\n=== bookings: values that used to be written straight to the row ===");
rejects("status: 'totally-made-up'", await req("POST", `/api/bookings/${bookingId}/status`, { status: "totally-made-up" }), "status");
rejects("rating: 500", await req("POST", `/api/bookings/${bookingId}/review`, { rating: 500 }), "rating");
rejects("rating: 2.5", await req("POST", `/api/bookings/${bookingId}/review`, { rating: 2.5 }), "rating");
rejects("scheduledAt: 'next tuesday'", await req("POST", `/api/bookings/${bookingId}/schedule`, { scheduledAt: "next tuesday" }), "scheduledAt");
rejects("priority: 'catastrophic'", await req("PATCH", `/api/bookings/${bookingId}`, { priority: "catastrophic" }), "priority");
rejects("notes: 200k chars", await req("PATCH", `/api/bookings/${bookingId}`, { notes: "x".repeat(200_000) }), "notes");

{
  const r = await req("POST", `/api/bookings/${bookingId}/assign`, { riderId: "rider-from-another-tenant" });
  check("cross-tenant riderId → 404, not assigned", r.status === 404, `status=${r.status}`);
  const after = await req("GET", `/api/bookings/${bookingId}`);
  check("booking still has no rider", !after.json?.booking?.riderId, String(after.json?.booking?.riderId));
}

{
  await req("PATCH", `/api/bookings/${bookingId}`, { title: "ZZ Fixture verify-fix8", companyId: "other-tenant", id: "hijacked" });
  const after = await req("GET", `/api/bookings/${bookingId}`);
  check("PATCH cannot rewrite id", after.json?.booking?.id === bookingId, String(after.json?.booking?.id));
  check("PATCH cannot rewrite companyId", after.json?.booking?.companyId !== "other-tenant", String(after.json?.booking?.companyId));
}

console.log("\n=== bookings: valid requests still work ===");
{
  const when = new Date(Date.now() + 2 * 86400_000).toISOString();
  const r = await req("POST", `/api/bookings/${bookingId}/schedule`, { scheduledAt: when });
  check("valid ISO schedule accepted", r.status === 200, `status=${r.status}`);
  const after = await req("GET", `/api/bookings/${bookingId}`);
  const stored = new Date(after.json?.booking?.scheduledAt ?? 0).getTime();
  check("stored date is not Invalid Date", !Number.isNaN(stored) && stored > Date.now(), String(after.json?.booking?.scheduledAt));
}
check("valid status accepted", (await req("POST", `/api/bookings/${bookingId}/status`, { status: "confirmed" })).status === 200);
check("valid rating accepted", [200, 201].includes((await req("POST", `/api/bookings/${bookingId}/review`, { rating: 5, comment: "ok" })).status));

console.log("\n=== payouts: the negative-fee hole (net > gross) ===");
rejects("feePct: -500", await req("POST", "/api/payouts/generate", { periodStart: "2026-01-01", periodEnd: "2026-01-31", feePct: -500 }), "feePct");
rejects("feePct: 5000", await req("POST", "/api/payouts/generate", { periodStart: "2026-01-01", periodEnd: "2026-01-31", feePct: 5000 }), "feePct");
rejects("periodStart: 'whenever'", await req("POST", "/api/payouts/generate", { periodStart: "whenever", periodEnd: "2026-01-31" }), "periodStart");
rejects("missing period", await req("POST", "/api/payouts/generate", {}), "periodStart");

console.log("\n=== payments: the NaN refund ===");
{
  const r = await req("POST", `/api/payments/refund/${bookingId}`, { amount: "abc" });
  check("non-numeric refund amount → 400", r.status === 400, `status=${r.status}`);
  const r2 = await req("POST", `/api/payments/refund/${bookingId}`, { amount: -50 });
  check("negative refund amount → 400", r2.status === 400, `status=${r2.status}`);
  const r3 = await req("POST", `/api/payments/refund/${bookingId}`, { reason: "x".repeat(5_000) });
  check("oversized Stripe metadata reason → 400", r3.status === 400, `status=${r3.status}`);
}

console.log("\n=== catalog: negative money + mass assignment ===");
rejects("unitCost: -100", await req("POST", "/api/catalog", { name: "ZZ Fixture item", unitCost: -100 }), "unitCost");
check("markupPct: 900 accepted (legitimate trade markup)", (await (async () => {
  const r = await req("POST", "/api/catalog", { name: "ZZ Fixture markup", markupPct: 900 });
  if (r.json?.item?.id) cleanup.push(() => req("DELETE", `/api/catalog/${r.json.item.id}`));
  return r;
})()).status === 201);
rejects("markupPct: -5", await req("POST", "/api/catalog", { name: "ZZ Fixture item", markupPct: -5 }), "markupPct");
rejects("name: ''", await req("POST", "/api/catalog", { name: "" }), "name");
{
  const mkItem = await req("POST", "/api/catalog", { name: "ZZ Fixture item", unitCost: 10, unitPrice: 25 });
  const itemId = mkItem.json?.item?.id;
  check("valid catalog item accepted", mkItem.status === 201 && !!itemId, `status=${mkItem.status}`);
  if (itemId) {
    cleanup.push(() => req("DELETE", `/api/catalog/${itemId}`));
    await req("PATCH", `/api/catalog/${itemId}`, { unitPrice: 30, companyId: "other-tenant" });
    const after = await req("GET", `/api/catalog/${itemId}`);
    check("PATCH applied the real change", after.json?.item?.unitPrice === 30, String(after.json?.item?.unitPrice));
    check("PATCH cannot rewrite companyId", after.json?.item?.companyId !== "other-tenant", String(after.json?.item?.companyId));
    rejects("PATCH unitCost: -1", await req("PATCH", `/api/catalog/${itemId}`, { unitCost: -1 }), "unitCost");
  }
}

console.log("\n=== pricing: quantities that used to reach computeSubtotal() ===");
rejects("actualMinutes: 'lots'", await req("POST", "/api/pricing/quote", { actualMinutes: "lots" }), "actualMinutes");
rejects("actualKm: -40", await req("POST", "/api/pricing/quote", { actualKm: -40 }), "actualKm");
check("valid quote still works", (await req("POST", "/api/pricing/quote", { actualMinutes: 60, actualKm: 10, region: "ON" })).status === 200);

console.log("\n=== error envelope shape ===");
{
  const r = await req("POST", `/api/bookings/${bookingId}/review`, { rating: 500 });
  check("code is validation_failed", r.json?.error?.code === "validation_failed", String(r.json?.error?.code));
  check("has a bare `message` for older clients", typeof r.json?.message === "string", String(r.json?.message));
  check("has a requestId", typeof r.json?.requestId === "string");
  check("malformed JSON body → 400", (await (async () => {
    const res = await fetch(`${BASE}/api/bookings/${bookingId}/status`, { method: "POST", headers: H, body: "{not json" });
    return res.status;
  })()) === 400);
}

console.log("\n=== cleanup ===");
for (const fn of cleanup) {
  try {
    await fn();
  } catch {}
}
const leftover = await req("GET", `/api/bookings/${bookingId}`);
check("fixture booking removed", leftover.status === 404 || leftover.json?.booking?.status === "cancelled", `status=${leftover.status}`);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
