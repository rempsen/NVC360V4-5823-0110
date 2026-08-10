/**
 * Fix 10 verification — request-body validation on the NOTIFICATION CONFIG
 * routes (/api/notif-config): rule matrix, email designer, channel/sender
 * settings, webhooks, sending domains.
 *
 * Every probe below is a request the API ACCEPTED (or 500'd on) before this
 * pass, reproduced live on :4200:
 *
 *  - PATCH /rules/:id { email: "yes" } -> 200, a string written into a boolean
 *    column; { enabled: {} } was accepted too.
 *  - PATCH /rules/:id { emailSubject: 50,000 chars } -> 200.
 *  - PATCH /rules/<bogus id> -> 200 with an empty body, so the UI reported a
 *    successful toggle that changed nothing. Now 404.
 *  - POST /rules/bulk { event: "made.up", value: "yes" } -> 200 ok:true, a
 *    silent no-op against an event that doesn't exist.
 *  - POST /preview { template: {} } -> bare 500.
 *  - POST /email/test { to: "not an email" } -> 200 and a REAL provider call
 *    that bounced against the tenant's own verified sending domain.
 *  - POST /email/templates with a 20,000-character name -> 201.
 *  - PATCH /channels { emailFromAddress: "totally not an email" } -> 200.
 *    That is the tenant's sending identity: every notification email from the
 *    company then fails at the provider. quietStart "99:99" and
 *    emailEnabled: "no" went in the same way.
 *  - POST /webhooks with no url -> bare 500 (NOT NULL).
 *  - POST /webhooks { url: "javascript:alert(1)" } -> 201: stored XSS the
 *    moment any UI renders it as a link.
 *  - POST /webhooks { url: "http://localhost:4200/api/health" } -> 201, and
 *    POST /webhooks/:id/test then fetched it — our own test-ping used as an
 *    SSRF probe of the host network from inside the container.
 *
 * NOTE: this script never calls POST /test/:event — fireEvent() on a real
 * booking sends a real SMS/email to a real customer.
 *
 * Run: bun verify-fix10.ts   (server must be up on :4200)
 */
const BASE = process.env.BASE || "http://localhost:4200";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
};

const tokRes = await fetch(`${BASE}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "dan@nvc360.com", password: "NVC423!!" }),
});
const TOK = ((await tokRes.json()) as any).token as string;
if (!TOK) throw new Error("sign-in failed");
const H = { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" };

const req = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${BASE}/api/notif-config${path}`, {
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
  check(`${label} → 400`, r.status === 400, `status=${r.status}`);
  if (field)
    check(`${label} names "${field}"`, !!r.json?.fields?.[field], JSON.stringify(r.json?.fields ?? r.json));
};
const status = (label: string, r: { status: number; json: any }, want: number) =>
  check(`${label} → ${want}`, r.status === want, `status=${r.status} ${JSON.stringify(r.json)?.slice(0, 90)}`);

/* ---- snapshot the tenant's real config so we can put it back ------------- */
const chanBefore = (await req("GET", "/channels")).json.channels;
const rules = (await req("GET", "/rules")).json.rules as any[];
const rule = rules[0];
const restore = async () => {
  await req("PATCH", "/channels", {
    emailFromName: chanBefore.emailFromName,
    emailFromAddress: chanBefore.emailFromAddress,
    emailReplyTo: chanBefore.emailReplyTo,
    quietStart: chanBefore.quietStart,
    quietEnd: chanBefore.quietEnd,
    emailEnabled: chanBefore.emailEnabled,
  });
  await req("PATCH", `/rules/${rule.id}`, {
    email: rule.email,
    emailSubject: rule.emailSubject ?? "",
    enabled: rule.enabled,
  });
};

console.log("\n=== /rules/:id ===");
rejects('{ email: "yes" }', await req("PATCH", `/rules/${rule.id}`, { email: "yes" }), "email");
rejects("{ enabled: {} }", await req("PATCH", `/rules/${rule.id}`, { enabled: {} }), "enabled");
rejects("emailSubject 50,000 chars", await req("PATCH", `/rules/${rule.id}`, { emailSubject: "S".repeat(50_000) }), "emailSubject");
rejects("empty patch", await req("PATCH", `/rules/${rule.id}`, {}), "_");
rejects("mass assignment (companyId)", await req("PATCH", `/rules/${rule.id}`, { companyId: "other-co" }), "_");
status("bogus rule id", await req("PATCH", "/rules/zz-not-a-rule", { email: true }), 404);
const untouched = ((await req("GET", "/rules")).json.rules as any[]).find((r) => r.id === rule.id);
check(
  "rejected patches wrote nothing",
  untouched.email === rule.email && untouched.emailSubject === rule.emailSubject,
  JSON.stringify({ email: untouched.email, subjLen: String(untouched.emailSubject).length }),
);
status("valid toggle still works", await req("PATCH", `/rules/${rule.id}`, { email: !rule.email }), 200);

console.log("\n=== /rules/bulk ===");
rejects('event "made.up"', await req("POST", "/rules/bulk", { event: "made.up", channel: "email", value: true }), "event");
rejects("bad channel", await req("POST", "/rules/bulk", { event: rule.event, channel: "pigeon", value: true }), "channel");
rejects('value "yes"', await req("POST", "/rules/bulk", { event: rule.event, channel: "email", value: "yes" }), "value");
status("valid bulk still works", await req("POST", "/rules/bulk", { event: rule.event, channel: "email", value: false }), 200);

console.log("\n=== /preview + /email/render ===");
rejects("template: {} (was a 500)", await req("POST", "/preview", { template: {} }), "template");
rejects("template 50,000 chars", await req("POST", "/preview", { template: "T".repeat(50_000) }), "template");
status("valid preview", await req("POST", "/preview", { template: "Hi {{firstName}}" }), 200);
rejects("design: not an array", await req("POST", "/email/render", { design: "nope" }), "design");
status("valid render", await req("POST", "/email/render", { design: [{ id: "a", type: "text", text: "hi" }] }), 200);

console.log("\n=== /email/test (real provider call — must never leave) ===");
rejects("to: not an email", await req("POST", "/email/test", { to: "not an email", design: [] }), "to");
rejects("to: missing", await req("POST", "/email/test", { design: [] }), "to");
rejects("subject 5,000 chars", await req("POST", "/email/test", { to: "ok@example.com", subject: "S".repeat(5_000), design: [] }), "subject");

console.log("\n=== /email/templates ===");
rejects("20,000-char name", await req("POST", "/email/templates", { name: "N".repeat(20_000) }), "name");
rejects("missing name", await req("POST", "/email/templates", { subject: "x" }), "name");
const tpl = await req("POST", "/email/templates", { name: "ZZ Fix10 Template", subject: "s", design: [] });
status("create template", tpl, 201);
const tplId = tpl.json?.template?.id as string | undefined;
if (tplId) {
  rejects("patch to a 20k subject", await req("PATCH", `/email/templates/${tplId}`, { subject: "S".repeat(20_000) }), "subject");
  rejects("empty patch", await req("PATCH", `/email/templates/${tplId}`, {}), "_");
  status("bogus template id", await req("PATCH", "/email/templates/zz-nope", { name: "x" }), 404);
  const builtin = ((await req("GET", "/email/templates")).json.templates as any[]).find((t) => t.isBuiltin);
  if (builtin) status("builtin template is read-only", await req("PATCH", `/email/templates/${builtin.id}`, { name: "hijacked" }), 400);
  status("valid patch", await req("PATCH", `/email/templates/${tplId}`, { name: "ZZ Fix10 Renamed" }), 200);
  status("delete template", await req("DELETE", `/email/templates/${tplId}`), 200);
}

console.log("\n=== /channels (the tenant's sending identity) ===");
rejects("emailFromAddress: garbage", await req("PATCH", "/channels", { emailFromAddress: "totally not an email" }), "emailFromAddress");
rejects("emailReplyTo: garbage", await req("PATCH", "/channels", { emailReplyTo: "reply at nvc360 dot com" }), "emailReplyTo");
rejects('quietStart: "99:99"', await req("PATCH", "/channels", { quietStart: "99:99", quietEnd: "nope" }), "quietStart");
rejects('emailEnabled: "no"', await req("PATCH", "/channels", { emailEnabled: "no" }), "emailEnabled");
rejects("emailBrandColor: cyan-ish", await req("PATCH", "/channels", { emailBrandColor: "sort of cyan" }), "emailBrandColor");
rejects("emailHeaderStyle: sparkles", await req("PATCH", "/channels", { emailHeaderStyle: "sparkles" }), "emailHeaderStyle");
rejects("emailFooter 20,000 chars", await req("PATCH", "/channels", { emailFooter: "F".repeat(20_000) }), "emailFooter");
rejects("mass assignment (companyId)", await req("PATCH", "/channels", { companyId: "other-co" }), "_");
rejects("empty patch", await req("PATCH", "/channels", {}), "_");
const chanNow = (await req("GET", "/channels")).json.channels;
check(
  "sending identity survived every rejected patch",
  chanNow.emailFromAddress === chanBefore.emailFromAddress &&
    chanNow.quietStart === chanBefore.quietStart &&
    chanNow.companyId === chanBefore.companyId,
  JSON.stringify({ from: chanNow.emailFromAddress, quiet: chanNow.quietStart }),
);
status("clearing the sender is still allowed", await req("PATCH", "/channels", { emailFromAddress: "" }), 200);
status("a real sender is still accepted", await req("PATCH", "/channels", { emailFromAddress: chanBefore.emailFromAddress || "contact@nvc360.com", quietStart: "21:00", quietEnd: "08:00" }), 200);

console.log("\n=== /webhooks ===");
rejects("no url (was a 500)", await req("POST", "/webhooks", { label: "zz" }), "url");
rejects("javascript: url (stored XSS)", await req("POST", "/webhooks", { label: "zz", url: "javascript:alert(1)" }), "url");
rejects("localhost url (SSRF)", await req("POST", "/webhooks", { label: "zz", url: "http://localhost:4200/api/health" }), "url");
rejects("127.0.0.1 url (SSRF)", await req("POST", "/webhooks", { label: "zz", url: "http://127.0.0.1:9200/" }), "url");
rejects("169.254 metadata url (SSRF)", await req("POST", "/webhooks", { label: "zz", url: "http://169.254.169.254/latest/meta-data/" }), "url");
rejects("RFC1918 url (SSRF)", await req("POST", "/webhooks", { label: "zz", url: "http://10.0.0.7/hook" }), "url");
rejects("file: url", await req("POST", "/webhooks", { label: "zz", url: "file:///etc/passwd" }), "url");
rejects("bare hostname", await req("POST", "/webhooks", { label: "zz", url: "not-a-url" }), "url");
rejects("5,000-char secret", await req("POST", "/webhooks", { label: "zz", url: "https://example.com/h", secret: "S".repeat(5_000) }), "secret");
const wh = await req("POST", "/webhooks", { label: "ZZ Fix10 Hook", url: "https://example.com/hooks/nvc360", events: "*" });
status("create a public https webhook", wh, 201);
const whId = wh.json?.webhook?.id as string | undefined;
if (whId) {
  rejects("patch to a localhost url", await req("PATCH", `/webhooks/${whId}`, { url: "http://localhost:4200/api/health" }), "url");
  rejects("empty patch", await req("PATCH", `/webhooks/${whId}`, {}), "_");
  status("bogus webhook id", await req("PATCH", "/webhooks/zz-nope", { label: "x" }), 404);
  const still = ((await req("GET", "/webhooks")).json.webhooks as any[]).find((w) => w.id === whId);
  check("rejected patch left the url alone", still?.url === "https://example.com/hooks/nvc360", still?.url);
  status("valid patch", await req("PATCH", `/webhooks/${whId}`, { active: false }), 200);
  status("delete webhook", await req("DELETE", `/webhooks/${whId}`), 200);
}

console.log("\n=== /email-domains ===");
rejects("missing domain", await req("POST", "/email-domains", {}), "domain");
rejects("5,000-char domain", await req("POST", "/email-domains", { domain: "d".repeat(5_000) + ".com" }), "domain");
status("still rejects a non-domain", await req("POST", "/email-domains", { domain: "not a domain" }), 400);

console.log("\n=== /test/:event (body only — never fired) ===");
rejects("bookingId: 12345 (number)", await req("POST", "/test/created", { bookingId: 12345 }), "bookingId");
status("unknown event", await req("POST", "/test/made.up", { bookingId: "x" }), 404);

console.log("\n=== restore the tenant's real config ===");
await restore();
const final = (await req("GET", "/channels")).json.channels;
check(
  "channels restored",
  final.emailFromAddress === chanBefore.emailFromAddress &&
    final.quietStart === chanBefore.quietStart &&
    final.emailEnabled === chanBefore.emailEnabled,
  JSON.stringify({ from: final.emailFromAddress, quiet: final.quietStart }),
);
const finalRule = ((await req("GET", "/rules")).json.rules as any[]).find((r) => r.id === rule.id);
check(
  "rule restored",
  finalRule.email === rule.email && finalRule.emailSubject === (rule.emailSubject ?? ""),
  JSON.stringify({ email: finalRule.email }),
);
const leftoverTpl = ((await req("GET", "/email/templates")).json.templates as any[]).filter((t) => String(t.name).startsWith("ZZ Fix10"));
const leftoverWh = ((await req("GET", "/webhooks")).json.webhooks as any[]).filter((w) => String(w.label).startsWith("ZZ Fix10"));
check("no fixtures left behind", leftoverTpl.length === 0 && leftoverWh.length === 0, `${leftoverTpl.length} templates, ${leftoverWh.length} webhooks`);

console.log(fail === 0 ? `\nALL PASS: ${pass} passed, 0 failed\n` : `\nFAILURES: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
