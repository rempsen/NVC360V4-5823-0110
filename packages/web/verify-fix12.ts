/**
 * Fix 12 verification — request-body validation on the ADMIN USER routes
 * (/api/admin/users, /api/admin/me/change-password).
 *
 * Every probe below is a request the API accepted or 500'd on before this
 * pass, reproduced live on :4200 first:
 *
 *  - POST /users with a 20,000-character name -> 201.
 *  - POST /users { phone: {} } -> 201, an object written into a text column.
 *  - PATCH /users/:id { email: "garbage-not-an-email" } -> 200. That is the
 *    account's LOGIN identity, so the person could no longer sign in at all,
 *    and the email validation better-auth applies on create was bypassed.
 *  - PATCH /users/:id { email: "<somebody else's email>" } -> bare 500 on the
 *    unique index. Now a 409.
 *  - PATCH /users/:id { name: 123 } -> 200 with the name stored as "123.0".
 *  - PATCH /users/:id { notes: 500,000 chars } -> 200, and
 *    { addresses: 5,000 entries } -> 200: one request could inflate a single
 *    user row without limit.
 *  - POST /users/:id/reset-password { password: 100,000 chars } -> 200, which
 *    then ran the password hasher over 100 KB — a cheap way to burn CPU.
 *    { password: 12345678 } (a number) -> bare 500.
 *
 * Also asserts the two things that were ALREADY safe stay safe: a PATCH of
 * role or companyId must not change either (the field whitelist never copied
 * them, and the schema keeps it that way by stripping unknown keys).
 *
 * Run: bun verify-fix12.ts   (server must be up on :4200)
 */
const BASE = process.env.BASE || "http://localhost:4200";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
};

const ADMIN_EMAIL = "dan@nvc360.com";
const tokRes = await fetch(`${BASE}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: ADMIN_EMAIL, password: "NVC423!!" }),
});
const TOK = ((await tokRes.json()) as any).token as string;
if (!TOK) throw new Error("sign-in failed");
const H = { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" };

const req = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${BASE}/api/admin${path}`, {
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

const rejects = (label: string, r: { status: number; json: any }, field?: string) => {
  check(`${label} → 400`, r.status === 400, `status=${r.status} ${JSON.stringify(r.json)?.slice(0, 120)}`);
  if (field) {
    check(`   names "${field}"`, JSON.stringify(r.json ?? {}).includes(field), JSON.stringify(r.json)?.slice(0, 160));
  }
};
const status = (label: string, r: { status: number; json: any }, want: number) =>
  check(`${label} → ${want}`, r.status === want, `status=${r.status} ${JSON.stringify(r.json)?.slice(0, 120)}`);

const users = async () => ((await req("GET", "/users")).json?.users ?? []) as any[];

/* ========================================================================== */
console.log("\n=== POST /api/admin/users ===");
rejects("name: 20,000 chars", await req("POST", "/users", { name: "N".repeat(20_000), email: "zzfix12a@example.com", password: "pw12345678" }), "Name");
rejects("name: 123 (number)", await req("POST", "/users", { name: 123, email: "zzfix12a@example.com", password: "pw12345678" }), "Name");
rejects("no name", await req("POST", "/users", { email: "zzfix12a@example.com", password: "pw12345678" }), "Name");
rejects("phone: {}", await req("POST", "/users", { name: "ZZ Fix12", email: "zzfix12a@example.com", password: "pw12345678", phone: {} }), "hone");
rejects("phone: \"call me\"", await req("POST", "/users", { name: "ZZ Fix12", email: "zzfix12a@example.com", password: "pw12345678", phone: "call me" }), "hone");
rejects("email: \"not an email\"", await req("POST", "/users", { name: "ZZ Fix12", email: "not an email", password: "pw12345678" }), "mail");
rejects("password: 5 chars", await req("POST", "/users", { name: "ZZ Fix12", email: "zzfix12a@example.com", password: "abc12" }), "assword");
rejects("password: 100,000 chars", await req("POST", "/users", { name: "ZZ Fix12", email: "zzfix12a@example.com", password: "P".repeat(100_000) }), "assword");
rejects("role: \"owner\"", await req("POST", "/users", { name: "ZZ Fix12", email: "zzfix12a@example.com", password: "pw12345678", role: "owner" }), "role");
rejects("empty body", await req("POST", "/users", {}));

const leakedEarly = (await users()).filter((u) => String(u.email).startsWith("zzfix12"));
check("no account created by any rejected request", leakedEarly.length === 0, `found ${leakedEarly.length}`);

console.log("\n--- a valid create still works ---");
const made = await req("POST", "/users", {
  name: "ZZ Fix12 Probe",
  email: "zzfix12probe@example.com",
  password: "pw12345678",
  phone: "+1 416 555 0134",
  role: "customer",
});
status("create a valid client account", made, 201);
const uid = made.json?.user?.id as string;
if (!uid) throw new Error("could not create the probe user");
status("duplicate email", await req("POST", "/users", { name: "ZZ Fix12 Dupe", email: "zzfix12probe@example.com", password: "pw12345678" }), 409);

/* ========================================================================== */
console.log("\n=== PATCH /api/admin/users/:id ===");
rejects("email: \"garbage-not-an-email\" (locks the account out)", await req("PATCH", `/users/${uid}`, { email: "garbage-not-an-email" }), "mail");
status("email: another user's address (was a bare 500)", await req("PATCH", `/users/${uid}`, { email: ADMIN_EMAIL }), 409);
rejects("name: 123 (stored as \"123.0\")", await req("PATCH", `/users/${uid}`, { name: 123 }), "Name");
rejects("name: 20,000 chars", await req("PATCH", `/users/${uid}`, { name: "N".repeat(20_000) }), "Name");
rejects("notes: 500,000 chars", await req("PATCH", `/users/${uid}`, { notes: "x".repeat(500_000) }), "notes");
rejects("addresses: 5,000 entries", await req("PATCH", `/users/${uid}`, {
  addresses: Array.from({ length: 5_000 }, (_, i) => ({ label: `a${i}`, line1: "x".repeat(200) })),
}), "addresses");
rejects("addresses: \"123 Main St\" (not an array)", await req("PATCH", `/users/${uid}`, { addresses: "123 Main St" }), "addresses");
rejects("contacts: 5,000 entries", await req("PATCH", `/users/${uid}`, {
  contacts: Array.from({ length: 5_000 }, (_, i) => ({ name: `c${i}` })),
}), "contacts");
rejects("phone: {}", await req("PATCH", `/users/${uid}`, { phone: {} }), "hone");
rejects("empty patch {}", await req("PATCH", `/users/${uid}`, {}));

const beforeRow = (await users()).find((u) => u.id === uid);
check(
  "no rejected patch changed the row",
  beforeRow?.email === "zzfix12probe@example.com" && beforeRow?.name === "ZZ Fix12 Probe",
  JSON.stringify({ email: beforeRow?.email, name: String(beforeRow?.name).slice(0, 40), len: String(beforeRow?.name).length }),
);

console.log("\n--- privilege fields must stay unreachable ---");
status("patch role: \"superadmin\"", await req("PATCH", `/users/${uid}`, { role: "superadmin", name: "ZZ Fix12 Probe" }), 200);
status("patch companyId: another tenant", await req("PATCH", `/users/${uid}`, { companyId: "some-other-co", name: "ZZ Fix12 Probe" }), 200);
const afterPriv = (await users()).find((u) => u.id === uid);
check("role unchanged", afterPriv?.role === "customer", `role=${afterPriv?.role}`);
check("still visible in this tenant (companyId unchanged)", !!afterPriv, "row still listed under the caller's company");

console.log("\n--- a valid patch still works ---");
const okPatch = await req("PATCH", `/users/${uid}`, {
  name: "ZZ Fix12 Probe (renamed)",
  notes: "Called back Tuesday.",
  addresses: [{ label: "Site A", line1: "12 Bay St", city: "Toronto" }],
  contacts: [{ name: "Site manager", phone: "+1 416 555 0199" }],
});
status("valid CRM patch", okPatch, 200);
check("addresses round-tripped", Array.isArray(okPatch.json?.user?.addresses) && okPatch.json.user.addresses.length === 1, JSON.stringify(okPatch.json?.user?.addresses)?.slice(0, 120));
check("contacts round-tripped", Array.isArray(okPatch.json?.user?.contacts) && okPatch.json.user.contacts.length === 1, JSON.stringify(okPatch.json?.user?.contacts)?.slice(0, 120));
status("PATCH a bogus user id", await req("PATCH", "/users/zz-not-a-real-user", { name: "x" }), 404);

/* ========================================================================== */
console.log("\n=== POST /api/admin/users/:id/reset-password ===");
rejects("password: 100,000 chars (hasher DoS)", await req("POST", `/users/${uid}/reset-password`, { password: "P".repeat(100_000) }), "assword");
rejects("password: 12345678 (number, was a bare 500)", await req("POST", `/users/${uid}/reset-password`, { password: 12345678 }), "assword");
rejects("password: 5 chars", await req("POST", `/users/${uid}/reset-password`, { password: "abc12" }), "assword");
rejects("no password", await req("POST", `/users/${uid}/reset-password`, {}), "assword");
status("a valid reset still works", await req("POST", `/users/${uid}/reset-password`, { password: "newpw12345678" }), 200);
const reSignIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "zzfix12probe@example.com", password: "newpw12345678" }),
});
check("the reset password actually signs in", !!((await reSignIn.json()) as any)?.token, `status=${reSignIn.status}`);

/* ========================================================================== */
console.log("\n=== POST /api/admin/me/change-password ===");
// These must fail on the BODY, before we ever touch the caller's real
// credential — the admin account's own password is never changed here.
rejects("newPassword: 100,000 chars", await req("POST", "/me/change-password", { currentPassword: "NVC423!!", newPassword: "P".repeat(100_000) }), "assword");
rejects("newPassword: 99999999 (number)", await req("POST", "/me/change-password", { currentPassword: "NVC423!!", newPassword: 99999999 }), "assword");
rejects("newPassword: 5 chars", await req("POST", "/me/change-password", { currentPassword: "NVC423!!", newPassword: "abc12" }), "assword");
rejects("no currentPassword", await req("POST", "/me/change-password", { newPassword: "somethinglong123" }), "urrent");
rejects("empty body", await req("POST", "/me/change-password", {}));
const stillIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: ADMIN_EMAIL, password: "NVC423!!" }),
});
check("the caller's own password was left alone", !!((await stillIn.json()) as any)?.token, `status=${stillIn.status}`);

/* ========================================================================== */
console.log("\n=== cleanup ===");
status("delete the probe user", await req("DELETE", `/users/${uid}`), 200);
const leftover = (await users()).filter((u) => String(u.email).startsWith("zzfix12") || String(u.name).startsWith("ZZ Fix12"));
check("no user fixtures left behind", leftover.length === 0, `left: ${JSON.stringify(leftover.map((u) => u.email))}`);

console.log(fail === 0 ? `\nALL PASS: ${pass} passed, 0 failed\n` : `\nFAILURES: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
