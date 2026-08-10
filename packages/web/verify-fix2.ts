/**
 * Fix 2 verification — proves GET /api/bookings no longer scales with row count.
 *
 * Inserts throwaway bookings in bulk, times the endpoint at increasing row
 * counts, then deletes them. The OLD per-row `enrich()` cost ~58.7 ms/booking
 * (measured 822 ms for 14), so 150 rows would have taken roughly 8.8 s. The
 * batched version should stay flat.
 *
 * SAFETY: every fixture row is created with `riderId: null` so nothing can
 * trigger dispatch/SMS, and titles are prefixed FIXTURE_N1_ for cleanup.
 *
 * Run: bun verify-fix2.ts   (server must be up on :4200)
 */
import { db } from "./src/api/database";
import * as schema from "./src/api/database/schema";
import { like, eq, and } from "drizzle-orm";

const BASE = process.env.BASE || "http://localhost:4200";
const EMAIL = "dan@nvc360.com";
const PASSWORD = "NVC423!!";

const COMPANY = "default";
const CUSTOMER = "6G8OQVJnUNnG388iGQs6Lw5sO5Q8nEQT";
const SERVICE = "52f2fc46-310a-45a5-9c0b-91c2941437cf";
const PREFIX = "FIXTURE_N1_";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? ` ${extra}` : ""}`);
};

async function token(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const j = (await res.json()) as any;
  if (!j.token) throw new Error("sign-in failed: " + JSON.stringify(j).slice(0, 200));
  return j.token;
}

async function cleanup() {
  await db
    .delete(schema.bookings)
    .where(and(eq(schema.bookings.companyId, COMPANY), like(schema.bookings.title, `${PREFIX}%`)));
}

async function seed(n: number) {
  const now = Date.now();
  const rows = Array.from({ length: n }, (_, i) => ({
    companyId: COMPANY,
    customerId: CUSTOMER,
    serviceId: SERVICE,
    riderId: null, // NEVER assign — an assigned booking can trigger dispatch/SMS
    title: `${PREFIX}${i}`,
    status: "confirmed",
    priority: "normal",
    address: `${i} Fixture Ave`,
    scheduledAt: new Date(now + 86_400_000), // NOT NULL
    createdAt: new Date(now - i * 1000),
  })) as any[];
  // chunked insert — Turso rejects very large single statements
  for (let i = 0; i < rows.length; i += 50) {
    await db.insert(schema.bookings).values(rows.slice(i, i + 50));
  }
}

async function timeIt(tok: string, url: string, runs = 3) {
  const times: number[] = [];
  let size = 0;
  let count = 0;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    const body = (await res.json()) as any;
    times.push(performance.now() - t0);
    size = JSON.stringify(body).length;
    count = body.bookings?.length ?? 0;
  }
  return { ms: Math.min(...times), size, count };
}

console.log("\n=== Fix 2: batched enrichment + opt-in pagination ===\n");
const tok = await token();

await cleanup();
const before = await timeIt(tok, `${BASE}/api/bookings`);
console.log(`  baseline (real data): ${before.count} bookings, ${before.ms.toFixed(0)} ms\n`);

const results: Array<{ n: number; ms: number; count: number; size: number }> = [];
let seeded = 0;
for (const target of [25, 75, 150]) {
  await seed(target - seeded);
  seeded = target;
  const r = await timeIt(tok, `${BASE}/api/bookings`);
  results.push({ n: r.count, ms: r.ms, count: r.count, size: r.size });
  console.log(`  ${String(r.count).padStart(3)} bookings → ${r.ms.toFixed(0).padStart(4)} ms, ${(r.size / 1024).toFixed(0)} KB`);
}

const first = results[0];
const last = results[results.length - 1];

console.log("\n--- scaling ---");
// Old code: ~58.7 ms per booking (822ms/14). Projected cost for the largest run.
const projectedOld = last.count * (822 / 14);
console.log(`  old per-row model would predict ~${(projectedOld / 1000).toFixed(1)}s for ${last.count} bookings`);
console.log(`  actual: ${(last.ms / 1000).toFixed(2)}s`);

check(
  `${last.count} bookings served well under the old model's projection`,
  last.ms < projectedOld / 3,
  `(${last.ms.toFixed(0)}ms vs ~${projectedOld.toFixed(0)}ms projected)`,
);

// The real signature of a fixed N+1: time is ~flat as rows grow. Allow generous
// headroom for payload serialization, which legitimately grows with row count.
const growth = last.ms / first.ms;
check(
  `response time is ~flat from ${first.count} → ${last.count} rows (${growth.toFixed(2)}x for ${(last.count / first.count).toFixed(1)}x data)`,
  growth < 2.0,
  `growth=${growth.toFixed(2)}x`,
);

console.log("\n--- contract & pagination ---");
{
  const res = await fetch(`${BASE}/api/bookings`, { headers: { Authorization: `Bearer ${tok}` } });
  const d = (await res.json()) as any;
  check("still returns { bookings: [...] } (back-compat)", Array.isArray(d.bookings));
  check("adds total", typeof d.total === "number", `total=${d.total}`);
  check("adds truncated flag", typeof d.truncated === "boolean");
  const b = d.bookings[0];
  check("row keeps service/rider/customer keys", b && "service" in b && "rider" in b && "customer" in b);
  const withSvc = d.bookings.find((x: any) => x.service);
  check("service is actually populated (not silently null)", !!withSvc, withSvc ? `e.g. "${withSvc.service.name}"` : "none populated!");
  const withCust = d.bookings.find((x: any) => x.customer);
  check("customer is populated with id/name/email", !!withCust?.customer?.email, withCust ? withCust.customer.email : "");
}
{
  const res = await fetch(`${BASE}/api/bookings?page=1&pageSize=10`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  const d = (await res.json()) as any;
  check("pageSize=10 returns exactly 10 rows", d.bookings.length === 10, `got ${d.bookings.length}`);
  check("reports pages", d.pages === Math.ceil(d.total / 10), `pages=${d.pages} total=${d.total}`);

  const p2 = await fetch(`${BASE}/api/bookings?page=2&pageSize=10`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  const d2 = (await p2.json()) as any;
  const overlap = d.bookings.filter((a: any) => d2.bookings.some((b: any) => b.id === a.id));
  check("page 2 does not overlap page 1", overlap.length === 0, `${overlap.length} overlapping`);
}
{
  // pageSize must be clamped so a caller can't request the whole table back
  const res = await fetch(`${BASE}/api/bookings?page=1&pageSize=99999`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  const d = (await res.json()) as any;
  check("pageSize is clamped to 200", d.pageSize <= 200, `pageSize=${d.pageSize}`);
}
{
  // ordering must still be newest-first (was an in-memory sort, now ORDER BY)
  const res = await fetch(`${BASE}/api/bookings?page=1&pageSize=50`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  const d = (await res.json()) as any;
  // createdAt serializes as an ISO string, so parse it rather than Number()-ing it
  const ts = d.bookings.map((b: any) => new Date(b.createdAt).getTime());
  const sorted = ts.every((v: number, i: number) => i === 0 || ts[i - 1] >= v);
  check("still sorted newest-first", sorted);
}

console.log("\n--- cleanup ---");
await cleanup();
{
  const left = await db
    .select()
    .from(schema.bookings)
    .where(and(eq(schema.bookings.companyId, COMPANY), like(schema.bookings.title, `${PREFIX}%`)));
  check("all fixture rows removed", left.length === 0, `${left.length} left`);
  const after = await timeIt(tok, `${BASE}/api/bookings`);
  check("row count back to baseline", after.count === before.count, `${after.count} vs ${before.count}`);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
