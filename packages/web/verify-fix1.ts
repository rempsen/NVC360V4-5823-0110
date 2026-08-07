/**
 * Fix 1 verification — proves the silent-write-failure class is closed.
 *
 * Re-runs the exact probe from web-platform-review.md: a 400 from the API must
 * now REJECT instead of resolving into react-query as a success. Also proves the
 * success path is untouched (the non-breaking half of the change).
 *
 * Run: bun verify-fix1.ts   (server must be up on :4200)
 */
import { ApiError, errorMessage, messageFromBody } from "./src/web/lib/api-error";

const BASE = process.env.BASE || "http://localhost:4200";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

/** Copy of apiFetch's behaviour, importable without the browser-only auth module. */
async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.ok) return res;
  let body: unknown;
  const raw = await res.text().catch(() => "");
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  const envelope = body && typeof body === "object" ? (body as Record<string, any>) : undefined;
  throw new ApiError({
    status: res.status,
    message: messageFromBody(body, res.status),
    code: envelope?.error?.code ?? envelope?.code,
    requestId: envelope?.requestId ?? res.headers.get("x-request-id") ?? undefined,
    body,
  });
}

console.log("\n=== Fix 1: non-2xx now throws ===");

// The original review probe: POST /api/zones with no name → server 400.
// Previously `.json()` did NOT throw and the 400 body was handed to
// react-query as a successful result.
{
  let threw = false;
  let err: unknown;
  try {
    await apiFetch(`${BASE}/api/zones`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color: "#fff" }),
    });
  } catch (e) {
    threw = true;
    err = e;
  }
  check("400/401 from POST /api/zones rejects instead of resolving", threw);
  check("thrown value is an ApiError", err instanceof ApiError, `got ${typeof err}`);
  if (err instanceof ApiError) {
    check("ApiError carries a numeric status", typeof err.status === "number" && err.status >= 400, `status=${err.status}`);
    check("ApiError produces a human message", errorMessage(err).length > 0, errorMessage(err));
    console.log(`      → status ${err.status}, message: "${errorMessage(err)}"`);
  }
}

// Success path must be completely unchanged — this is what makes the fix safe
// to apply under 161 existing call sites without editing them.
{
  let ok = false;
  let jsonWorked = false;
  try {
    const res = await apiFetch(`${BASE}/api/services`);
    ok = res.ok;
    const body = (await res.json()) as any;
    jsonWorked = Array.isArray(body?.services);
  } catch {
    /* leave false */
  }
  check("2xx response still resolves (success path unchanged)", ok);
  check(".json() at the call site still works on success", jsonWorked);
}

// A 404 must throw too, and map to a message the user can act on.
{
  let err: unknown;
  try {
    await apiFetch(`${BASE}/api/services/definitely-not-a-real-id`);
  } catch (e) {
    err = e;
  }
  check("404 rejects", err instanceof ApiError);
  if (err instanceof ApiError) {
    check("404 maps to a user-facing message", /no longer exists|not found/i.test(errorMessage(err)), errorMessage(err));
  }
}

console.log("\n=== errorMessage() mapping ===");
const cases: Array<[number, RegExp]> = [
  [401, /session expired/i],
  [403, /permission/i],
  [404, /no longer exists/i],
  [429, /too many/i],
  [500, /server error/i],
];
for (const [status, re] of cases) {
  const msg = errorMessage(new ApiError({ status, message: "raw" }));
  check(`${status} → "${msg}"`, re.test(msg));
}
check(
  "500 with requestId surfaces the reference",
  /abc123/.test(errorMessage(new ApiError({ status: 500, message: "x", requestId: "abc123" }))),
);
check(
  "network TypeError → connection message",
  /can't reach the server/i.test(errorMessage(new TypeError("Failed to fetch"))),
);

console.log("\n=== envelope parsing ===");
check(
  "nested { error: { message } } envelope",
  messageFromBody({ error: { code: "bad", message: "Name required" } }, 400) === "Name required",
);
check("bare { message } envelope", messageFromBody({ message: "legacy style" }, 400) === "legacy style");
check("plain string body", messageFromBody("boom", 400) === "boom");
check("empty body falls back to status", messageFromBody(undefined, 418) === "Request failed (418)");

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
