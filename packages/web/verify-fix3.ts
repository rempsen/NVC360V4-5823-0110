/**
 * Fix 3 verification — re-runs the exact validation probes from
 * web-platform-review.md that previously succeeded when they should not have.
 *
 * Original findings being closed:
 *  - POST /api/services with name:"", basePrice:-99999, durationMins:-5 and a
 *    50,000-char description returned 201 Created and stored it verbatim.
 *  - PUT /api/zones/:id with a nonexistent id returned 500 instead of 404.
 *
 * Also asserts the authenticated 400 path that Fix 1's verifier could only test
 * unauthenticated, and cleans up anything it creates.
 *
 * Run: bun verify-fix3.ts   (server must be up on :4200)
 */
const BASE = process.env.BASE || "http://localhost:4200";
const EMAIL = "dan@nvc360.com";
const PASSWORD = "NVC423!!";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) pass++; else fail++;
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

const created: string[] = [];

console.log("\n=== The original review probe (was 201 Created) ===");
{
  const r = await req("POST", "/api/services", {
    name: "",
    category: "",
    basePrice: -99999,
    durationMins: -5,
    description: "x".repeat(50_000),
  });
  check("rejected with 400 (was 201)", r.status === 400, `status=${r.status}`);
  check("returns a field-level error map", !!r.json?.fields, JSON.stringify(r.json?.fields ?? {}).slice(0, 160));
  check("names the empty name", !!r.json?.fields?.name);
  check("names the negative price", !!r.json?.fields?.basePrice, r.json?.fields?.basePrice ?? "");
  check("names the negative duration", !!r.json?.fields?.durationMins, r.json?.fields?.durationMins ?? "");
  check("names the oversized description", !!r.json?.fields?.description);
  if (r.status === 201 && r.json?.service?.id) created.push(r.json.service.id);
}

console.log("\n=== Money / duration edge cases ===");
const badValues: Array<[string, any, string]> = [
  ["negative price", { name: "P", category: "c", basePrice: -1 }, "basePrice"],
  ["NaN price", { name: "P", category: "c", basePrice: Number.NaN }, "basePrice"],
  ["Infinity price", { name: "P", category: "c", basePrice: Number.POSITIVE_INFINITY }, "basePrice"],
  ["string price", { name: "P", category: "c", basePrice: "100" }, "basePrice"],
  ["absurd price", { name: "P", category: "c", basePrice: 99_999_999_999 }, "basePrice"],
  ["zero duration", { name: "P", category: "c", durationMins: 0 }, "durationMins"],
  ["fractional duration", { name: "P", category: "c", durationMins: 1.5 }, "durationMins"],
  ["whitespace-only name", { name: "   ", category: "c" }, "name"],
  ["missing category", { name: "P" }, "category"],
];
for (const [label, body, field] of badValues) {
  const r = await req("POST", "/api/services", body);
  check(`${label} → 400 on ${field}`, r.status === 400 && !!r.json?.fields?.[field], `status=${r.status} ${JSON.stringify(r.json?.fields ?? {})}`.slice(0, 120));
  if (r.status === 201 && r.json?.service?.id) created.push(r.json.service.id);
}

console.log("\n=== Valid input must still work (no false positives) ===");
let goodId = "";
{
  const r = await req("POST", "/api/services", {
    name: "FIXTURE_V3 Valid Service",
    category: "hvac",
    description: "A legitimate service",
    basePrice: 149.5,
    durationMins: 90,
  });
  check("valid service creates with 201", r.status === 201, `status=${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  goodId = r.json?.service?.id ?? "";
  if (goodId) created.push(goodId);
  check("basePrice stored exactly", r.json?.service?.basePrice === 149.5, String(r.json?.service?.basePrice));
  check("durationMins stored exactly", r.json?.service?.durationMins === 90, String(r.json?.service?.durationMins));
  check("price 0 is allowed (free service)", (await req("POST", "/api/services", { name: "FIXTURE_V3 Free", category: "c", basePrice: 0 })).status === 201);
}
{
  // capture the free one for cleanup
  const list = await req("GET", "/api/services");
  for (const s of list.json?.services ?? [])
    if (String(s.name).startsWith("FIXTURE_V3") && !created.includes(s.id)) created.push(s.id);
}

console.log("\n=== PATCH validation + mass assignment ===");
if (goodId) {
  const r = await req("PATCH", `/api/services/${goodId}`, { basePrice: -5 });
  check("PATCH rejects negative price", r.status === 400, `status=${r.status}`);

  const ok = await req("PATCH", `/api/services/${goodId}`, { basePrice: 200 });
  check("PATCH accepts a valid price", ok.status === 200 && ok.json?.service?.basePrice === 200, `status=${ok.status} price=${ok.json?.service?.basePrice}`);

  const inj = await req("PATCH", `/api/services/${goodId}`, {
    basePrice: 210,
    id: "hacked-id",
    companyId: "other-tenant",
    rating: 5,
    createdAt: 0,
  });
  check("PATCH ignores injected id/companyId/rating", inj.status === 200 && inj.json?.service?.id === goodId && inj.json?.service?.companyId !== "other-tenant", `id=${inj.json?.service?.id} company=${inj.json?.service?.companyId}`);

  const empty = await req("PATCH", `/api/services/${goodId}`, {});
  check("empty PATCH rejected instead of silent no-op", empty.status === 400, `status=${empty.status}`);

  const missing = await req("PATCH", "/api/services/definitely-not-real", { basePrice: 10 });
  check("PATCH on unknown id → 404", missing.status === 404, `status=${missing.status}`);
}

console.log("\n=== Malformed JSON body ===");
{
  const res = await fetch(`${BASE}/api/services`, { method: "POST", headers: H, body: "{not json" });
  check("malformed JSON → 400 (not 500)", res.status === 400, `status=${res.status}`);
}

console.log("\n=== zones: 404 instead of 500 (confirmed 500 in the review) ===");
{
  const r = await req("PUT", "/api/zones/00000000-0000-0000-0000-000000000000", { name: "Nope" });
  check("PUT unknown zone id → 404 (was 500)", r.status === 404, `status=${r.status}`);
  check("no 500 leaked", r.status !== 500);

  const d = await req("DELETE", "/api/zones/00000000-0000-0000-0000-000000000000");
  check("DELETE unknown zone id → 404 (was silent success)", d.status === 404, `status=${d.status}`);

  const bad = await req("POST", "/api/zones", { name: "Z", color: "not-a-color" });
  check("bad hex color rejected", bad.status === 400 && !!bad.json?.fields?.color, `status=${bad.status}`);

  const surge = await req("POST", "/api/zones", { name: "Z", surgeMultiplier: -3 });
  check("negative surge multiplier rejected", surge.status === 400 && !!surge.json?.fields?.surgeMultiplier, `status=${surge.status}`);

  const noName = await req("POST", "/api/zones", { color: "#ffffff" });
  check("zone without a name → 400", noName.status === 400, `status=${noName.status}`);
}

console.log("\n=== Error envelope shape (what the new client parses) ===");
{
  const r = await req("POST", "/api/services", { name: "" });
  const hasNested = typeof r.json?.error?.message === "string";
  const hasLegacy = typeof r.json?.message === "string";
  check("has nested { error: { code, message } }", hasNested, r.json?.error?.message ?? "");
  check("error.code is validation_failed", r.json?.error?.code === "validation_failed", r.json?.error?.code ?? "");
  check("also has legacy bare { message } for older clients", hasLegacy);
}

console.log("\n=== cleanup ===");
{
  let removed = 0;
  for (const id of new Set(created)) {
    const r = await req("DELETE", `/api/services/${id}`);
    if (r.status === 200) removed++;
  }
  console.log(`  soft-deleted ${removed} fixture service(s)`);
  const list = await req("GET", "/api/services");
  const left = (list.json?.services ?? []).filter((s: any) => String(s.name).startsWith("FIXTURE_V3"));
  check("no active fixture services left", left.length === 0, `${left.length} left`);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
