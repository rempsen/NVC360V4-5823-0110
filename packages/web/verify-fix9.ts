/**
 * Fix 9 verification — request-body validation on the IDENTITY routes.
 *
 * These are the routes that mint and mutate login accounts: /api/team,
 * /api/riders, /api/invites, /api/api-keys. Every probe below is a request the
 * API ACCEPTED with a 200/201 before this pass, verified live on :4200:
 *
 *  - PATCH /api/team/:id { email: "totally not an email" } → 200. That is an
 *    ACCOUNT LOCKOUT: the user row no longer matches better-auth's account
 *    table, so that person can't sign in and can't reset their password.
 *  - PATCH /api/team/:id { managerId: "does-not-exist-id" } → 200. Dangling
 *    reference, and nothing stopped a manager id belonging to another tenant.
 *  - POST /api/team with a 20,000-character name → 201.
 *  - POST /api/team { role: "rider", payRatePerHour: -999 } → 201, negative
 *    hourly pay written to the rider profile that feeds payout gross pay.
 *  - PATCH /api/riders/:id { payRatePerHour: "lots" } → 200, storing the
 *    STRING "lots" in a real() column, so that technician's payout math is NaN.
 *  - PATCH /api/riders/:id { status: "on vacation" } → 200, a presence state
 *    the scheduler's availability filter and services/presence.ts don't know.
 *  - PATCH /api/riders/me { lat: 9999, lng: -9999 } → 200, plotting the
 *    technician off the edge of the world on the fleet map and live tracking.
 *  - POST /api/invites { email: "not an email" } → 201 and a real send attempt,
 *    i.e. a hard bounce against the tenant's own verified sending domain.
 *  - POST /api/invites/accept/:token accepted a 6-character password on a
 *    PUBLIC unauthenticated route while better-auth itself requires 8.
 *  - POST /api/api-keys { expiresInDays: "soon" } → Number("soon") is NaN, the
 *    `> 0` guard fails, and the key was minted with NO expiry at all.
 *
 * Two bare 500s are also asserted away: a duplicate email hit the unique index
 * (now 409), and PATCH /api/riders/:id with ONLY user-table fields (just the
 * name, or just the email) left drizzle with an empty SET clause and threw
 * "No values to set" — so an admin renaming a technician got a 500.
 *
 * Run: bun verify-fix9.ts   (server must be up on :4200)
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
    const named = !!r.json?.fields?.[field];
    check(`${label} names "${field}"`, named, JSON.stringify(r.json?.fields ?? r.json));
  }
};
const status = (label: string, r: { status: number; json: any }, want: number) =>
  check(`${label} → ${want}`, r.status === want, `status=${r.status} ${JSON.stringify(r.json)?.slice(0, 90)}`);

const employees = async () => ((await req("GET", "/api/team")).json?.employees ?? []) as any[];
const riders = async () => ((await req("GET", "/api/riders")).json?.riders ?? []) as any[];

const cleanup: Array<() => Promise<unknown>> = [];

console.log("\n=== /api/team — create ===");
rejects("20,000-char name", await req("POST", "/api/team", { name: "Z".repeat(20_000), email: "zzfix9a@example.com", password: "pw12345678", role: "manager" }), "name");
rejects("garbage email", await req("POST", "/api/team", { name: "ZZ Fix9", email: "not-an-email", password: "pw12345678", role: "manager" }), "email");
rejects("1-char password", await req("POST", "/api/team", { name: "ZZ Fix9", email: "zzfix9b@example.com", password: "x", role: "manager" }), "password");
rejects("negative pay rate", await req("POST", "/api/team", { name: "ZZ Fix9", email: "zzfix9c@example.com", password: "pw12345678", role: "rider", payRatePerHour: -999 }), "payRatePerHour");
rejects("skills as a string", await req("POST", "/api/team", { name: "ZZ Fix9", email: "zzfix9d@example.com", password: "pw12345678", role: "rider", skills: "notanarray" }), "skills");
rejects("invented role", await req("POST", "/api/team", { name: "ZZ Fix9", email: "zzfix9e@example.com", password: "pw12345678", role: "owner" }), "role");
status("cross-tenant/bogus manager", await req("POST", "/api/team", { name: "ZZ Fix9", email: "zzfix9f@example.com", password: "pw12345678", role: "manager", managerId: "nope-nope" }), 400);
// ...and the rejected request must NOT have left a real login account behind:
// the manager check used to run AFTER auth.api.signUpEmail().
check(
  "rejected create left no orphan account",
  !(await employees()).some((u) => u.email === "zzfix9f@example.com"),
);

console.log("\n=== /api/team — happy path still works ===");
const created = await req("POST", "/api/team", {
  name: "ZZ Fix9 Employee",
  email: "zzfix9ok@example.com",
  password: "pw12345678",
  role: "rider",
  staffType: "technician",
  skills: ["HVAC"],
  payRatePerHour: 42,
  phone: "+14165550111",
});
status("create employee", created, 201);
const empId = created.json?.user?.id as string | undefined;
if (empId) cleanup.push(() => req("DELETE", `/api/team/${empId}`));

console.log("\n=== /api/team — patch ===");
if (empId) {
  rejects("email → garbage (lockout)", await req("PATCH", `/api/team/${empId}`, { email: "totally not an email" }), "email");
  status("email → already in use", await req("PATCH", `/api/team/${empId}`, { email: EMAIL }), 409);
  status("managerId → bogus", await req("PATCH", `/api/team/${empId}`, { managerId: "does-not-exist-id" }), 400);
  status("managerId → self", await req("PATCH", `/api/team/${empId}`, { managerId: empId }), 400);
  rejects("name → 20,000 chars", await req("PATCH", `/api/team/${empId}`, { name: "Q".repeat(20_000) }), "name");
  rejects("staffType → wizard", await req("PATCH", `/api/team/${empId}`, { staffType: "wizard" }), "staffType");
  rejects("mass assignment (companyId only)", await req("PATCH", `/api/team/${empId}`, { companyId: "other-co" }), "_");
  rejects("empty patch", await req("PATCH", `/api/team/${empId}`, {}), "_");

  const after = (await employees()).find((u) => u.id === empId);
  check("nothing was written by the rejected patches", after?.email === "zzfix9ok@example.com" && after?.name === "ZZ Fix9 Employee" && after?.managerId == null, JSON.stringify({ email: after?.email, name: after?.name, managerId: after?.managerId }));
  status("valid patch", await req("PATCH", `/api/team/${empId}`, { name: "ZZ Fix9 Renamed", staffType: "driver" }), 200);
}

console.log("\n=== /api/riders ===");
const mk = await req("POST", "/api/riders", { name: "ZZ Fix9 Tech", email: "zzfix9tech@example.com", password: "pw12345678", skillClass: "HVAC", skills: ["HVAC"], payRatePerHour: 38 });
status("create technician", mk, 201);
const rid = mk.json?.rider?.id as string | undefined;
if (rid) {
  cleanup.push(() => req("DELETE", `/api/riders/${rid}`));
  rejects("pay rate → -500", await req("PATCH", `/api/riders/${rid}`, { payRatePerHour: -500 }), "payRatePerHour");
  rejects('pay rate → "lots" (NaN payouts)', await req("PATCH", `/api/riders/${rid}`, { payRatePerHour: "lots" }), "payRatePerHour");
  rejects('status → "on vacation"', await req("PATCH", `/api/riders/${rid}`, { status: "on vacation" }), "status");
  rejects("email → garbage", await req("PATCH", `/api/riders/${rid}`, { email: "nope nope nope" }), "email");
  rejects("notes → 60,000 chars", await req("PATCH", `/api/riders/${rid}`, { notes: "N".repeat(60_000) }), "notes");
  rejects("empty patch", await req("PATCH", `/api/riders/${rid}`, {}), "_");
  status("email → already in use", await req("PATCH", `/api/riders/${rid}`, { email: EMAIL }), 409);
  // These two used to be a bare 500 ("No values to set"): only user-table fields.
  status("rename only (was a 500)", await req("PATCH", `/api/riders/${rid}`, { name: "ZZ Fix9 Tech Renamed" }), 200);
  status("change email only (was a 500)", await req("PATCH", `/api/riders/${rid}`, { email: "zzfix9tech2@example.com" }), 200);
  status("unknown rider id", await req("PATCH", "/api/riders/00000000-0000-0000-0000-000000000000", { name: "x" }), 404);

  const r = (await riders()).find((x) => x.id === rid);
  check("stored values are sane", r?.payRatePerHour === 38 && r?.status === "available" && r?.email === "zzfix9tech2@example.com", JSON.stringify({ pay: r?.payRatePerHour, status: r?.status, email: r?.email }));
  status("valid patch", await req("PATCH", `/api/riders/${rid}`, { payRatePerHour: 45, status: "available", notes: "ok" }), 200);
}

console.log("\n=== /api/riders/me (mobile self-service) ===");
rejects("lat/lng → words", await req("PATCH", "/api/riders/me", { lat: "north", lng: "west" }), "lat");
rejects("lat 9999 / lng -9999", await req("PATCH", "/api/riders/me", { lat: 9999, lng: -9999 }), "lat");
rejects("status → free text", await req("PATCH", "/api/riders/me", { status: "vibing" }), "status");
status("heartbeat still works", await req("PATCH", "/api/riders/me", { heartbeat: true }), 200);
status("real coordinates still work", await req("PATCH", "/api/riders/me", { lat: 49.8951, lng: -97.1384 }), 200);

console.log("\n=== /api/invites ===");
rejects("invite to a non-email", await req("POST", "/api/invites", { email: "not an email" }), "email");
rejects("invite with a 20k name", await req("POST", "/api/invites", { email: "zzfix9inv@example.com", name: "Z".repeat(20_000) }), "name");
rejects("invite with no email", await req("POST", "/api/invites", {}), "email");
// PUBLIC route — the token is invalid on purpose; validation must fire first.
rejects("accept with a 6-char password", await req("POST", "/api/invites/accept/zz-not-a-real-token", { password: "abc123" }), "password");
rejects("accept with a 20k name", await req("POST", "/api/invites/accept/zz-not-a-real-token", { password: "pw12345678", name: "Q".repeat(20_000) }), "name");
status("valid accept body reaches the token check", await req("POST", "/api/invites/accept/zz-not-a-real-token", { password: "pw12345678", name: "ZZ" }), 404);

console.log("\n=== /api/api-keys ===");
rejects("no label", await req("POST", "/api/api-keys", {}), "label");
rejects("5,000-char label", await req("POST", "/api/api-keys", { label: "L".repeat(5_000), keyType: "public" }), "label");
rejects('expiresInDays: "soon" (was a no-expiry key)', await req("POST", "/api/api-keys", { label: "ZZ Fix9 Key", keyType: "public", expiresInDays: "soon" }), "expiresInDays");
const key = await req("POST", "/api/api-keys", { label: "ZZ Fix9 Key", keyType: "public", expiresInDays: 30 });
status("mint a public key", key, 201);
const keyId = (key.json?.key?.id ?? key.json?.id) as string | undefined;
if (keyId) {
  cleanup.push(() => req("DELETE", `/api/api-keys/${keyId}`));
  check("expiry was actually set", !!(key.json?.key?.expiresAt ?? key.json?.expiresAt), JSON.stringify(key.json?.key?.expiresAt ?? key.json?.expiresAt));
}

console.log("\n=== cleanup ===");
for (const fn of cleanup) {
  const r: any = await fn();
  check("fixture removed", r.status === 200 || r.status === 204, `status=${r.status}`);
}
const leftovers = [
  ...(await employees()).filter((u) => String(u.email).startsWith("zzfix9")),
  ...(await riders()).filter((u) => String(u.email ?? "").startsWith("zzfix9")),
];
check("no zzfix9 fixtures left behind", leftovers.length === 0, `${leftovers.length} left`);

console.log(
  fail === 0 ? `\nALL PASS: ${pass} passed, 0 failed\n` : `\nFAILURES: ${pass} passed, ${fail} failed\n`,
);
if (fail > 0) process.exit(1);
