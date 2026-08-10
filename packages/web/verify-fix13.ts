/**
 * verify-fix13 — integrations.ts + superadmin.ts request-body validation.
 *
 * Headline defect this locks down: POST /api/superadmin/brand-scout fetched any
 * URL the caller supplied and echoed parsed content back, so
 * { website: "http://127.0.0.1:4200/api/health" } returned 200 with a colour
 * scraped from that internal response — a working SSRF with an output channel.
 * Cloud instance metadata (169.254.169.254) was accepted too.
 *
 * The brand-patch assertions write to the acme-hvac DEMO tenant only, and its
 * settings row is snapshotted through drizzle before anything is sent and
 * restored at the end. Nothing here calls a route that sends real email/SMS,
 * and no tenant is ever created (there is no delete-company route).
 *
 * Run: cd packages/web && set -a && source ../../.env && set +a && bun verify-fix13.ts
 */
import { db } from "./src/api/database";
import * as schema from "./src/api/database/schema";
import { eq } from "drizzle-orm";

const BASE = process.env.VERIFY_BASE ?? "http://localhost:4200";
const TARGET = "acme-hvac";

let pass = 0;
const fails: string[] = [];
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fails.push(`${label}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL ${label} ${detail}`); }
}

const tok = ((await (await fetch(`${BASE}/api/auth/sign-in/email`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "dan@nvc360.com", password: "NVC423!!" }),
})).json()) as any).token;
if (!tok) { console.error("could not sign in"); process.exit(1); }
const H = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };

const req = async (m: string, p: string, b?: unknown) => {
  const r = await fetch(`${BASE}/api${p}`, { method: m, headers: H, body: b === undefined ? undefined : JSON.stringify(b) });
  let j: any; try { j = await r.json(); } catch {}
  return { s: r.status, j };
};
const rejects = (r: any, field?: string) =>
  r.s === 400 && (!field || JSON.stringify(r.j ?? {}).toLowerCase().includes(field.toLowerCase()));

const [snap] = await db.select().from(schema.companySettings).where(eq(schema.companySettings.companyId, TARGET));
if (!snap) { console.error(`no company_settings row for ${TARGET}`); process.exit(1); }

console.log("\n── superadmin: brand-scout SSRF ──");
{
  check("loopback http://127.0.0.1:4200 -> 400", rejects(await req("POST", "/superadmin/brand-scout", { website: "http://127.0.0.1:4200/api/health" }), "public host"));
  check("localhost by name -> 400", rejects(await req("POST", "/superadmin/brand-scout", { website: "http://localhost:4200/" })));
  check("cloud metadata 169.254.169.254 -> 400", rejects(await req("POST", "/superadmin/brand-scout", { website: "http://169.254.169.254/latest/meta-data/" })));
  check("RFC1918 10.0.0.5 -> 400", rejects(await req("POST", "/superadmin/brand-scout", { website: "http://10.0.0.5/" })));
  check("RFC1918 192.168.1.1 -> 400", rejects(await req("POST", "/superadmin/brand-scout", { website: "http://192.168.1.1/" })));
  check("javascript: -> 400", rejects(await req("POST", "/superadmin/brand-scout", { website: "javascript:alert(1)" })));
  check("file:// -> 400", rejects(await req("POST", "/superadmin/brand-scout", { website: "file:///etc/passwd" })));
  check("missing website -> 400", rejects(await req("POST", "/superadmin/brand-scout", {}), "website"));
  // A bare domain is what admins actually type into "Grab Brand Assets". It has
  // to survive validation (the host below doesn't resolve, so no page is
  // scraped and no AI call is made — anything other than 400 proves the
  // preprocess step added the scheme and the URL passed the guard).
  const bare = await req("POST", "/superadmin/brand-scout", { website: "no-such-host-zz-verify.example" });
  check("bare domain passes validation (not 400)", bare.s !== 400, `${bare.s}`);
}

console.log("\n── superadmin: brand patch ──");
{
  check("bogus tenant -> 404", (await req("PATCH", "/superadmin/companies/zz-nope/brand", { brand: { primaryColor: "#ffffff" } })).s === 404);
  check("logoUrl javascript: -> 400", rejects(await req("PATCH", `/superadmin/companies/${TARGET}/brand`, { brand: { logoUrl: "javascript:alert(1)" } }), "logo"));
  check("primaryColor 'chartreuse-ish' -> 400", rejects(await req("PATCH", `/superadmin/companies/${TARGET}/brand`, { brand: { primaryColor: "chartreuse-ish" } }), "colour"));
  check("email 'not-an-email' -> 400", rejects(await req("PATCH", `/superadmin/companies/${TARGET}/brand`, { brand: { email: "not-an-email" } }), "email"));
  check("jobNoun 20k -> 400", rejects(await req("PATCH", `/superadmin/companies/${TARGET}/brand`, { brand: { jobNoun: "J".repeat(20000) } }), "job noun"));
  check("brand: 'hi' -> 400", rejects(await req("PATCH", `/superadmin/companies/${TARGET}/brand`, { brand: "hi" })));

  const [mid] = await db.select().from(schema.companySettings).where(eq(schema.companySettings.companyId, TARGET));
  check("demo tenant untouched by rejected patches", mid.logo === snap.logo && mid.brandColor === snap.brandColor && mid.email === snap.email && mid.jobNoun === snap.jobNoun);

  // A real reviewed proposal — brand-scout emits explicit nulls for anything it
  // couldn't read, and the admin submits the object as-is. That must still work.
  const real = await req("PATCH", `/superadmin/companies/${TARGET}/brand`, {
    brand: {
      primaryColor: "#123456", accentColor: null, logoUrl: null, logoSourceUrl: null,
      workerNoun: "Technician", workerNounPlural: "Technicians",
      customerNoun: null, customerNounPlural: null, jobNoun: "Job", jobNounPlural: "Jobs",
      tagline: "ZZ verify tagline", hours: null, address: null,
      email: "ops@acme.test", phone: null, website: null, services: null, socials: null,
    },
  });
  check("real proposal with nulls -> 200", real.s === 200, JSON.stringify(real.j)?.slice(0, 160));
  const [applied] = await db.select().from(schema.companySettings).where(eq(schema.companySettings.companyId, TARGET));
  check("valid values actually applied", applied.brandColor === "#123456" && applied.tagline === "ZZ verify tagline");
}

console.log("\n── superadmin: company provisioning (rejection paths only) ──");
{
  const base = { name: "Acme HVAC", adminEmail: "zz@example.com", adminPassword: "pw12345678" };
  check("adminEmail 'garbage' -> 400 (was masked by the slug 409)", rejects(await req("POST", "/superadmin/companies", { ...base, adminEmail: "garbage" }), "admin email"));
  check("adminPassword 'x' -> 400 (no minimum before)", rejects(await req("POST", "/superadmin/companies", { ...base, adminPassword: "x" }), "8 characters"));
  check("missing admin creds -> 400 naming both fields", rejects(await req("POST", "/superadmin/companies", { name: "Acme HVAC" }), "adminpassword"));
  check("plan {a:1} -> 400", rejects(await req("POST", "/superadmin/companies", { ...base, plan: { a: 1 } }), "plan"));
  check("plan 'unlimited' -> 400", rejects(await req("POST", "/superadmin/companies", { ...base, plan: "unlimited" })));
  check("no name -> 400", rejects(await req("POST", "/superadmin/companies", {}), "company name"));
  check("contactEmail garbage -> 400", rejects(await req("POST", "/superadmin/companies", { ...base, contactEmail: "nope" })));
  check("managerPassword too short -> 400", rejects(await req("POST", "/superadmin/companies", { ...base, managerEmail: "zzm@example.com", managerPassword: "abc" })));
  // valid payload for an EXISTING slug must still reach the 409, proving
  // validation didn't swallow a legitimate request
  check("valid payload + existing slug -> 409", (await req("POST", "/superadmin/companies", base)).s === 409);
}

console.log("\n── integrations ──");
{
  check("app-credentials clientId {} -> 400", rejects(await req("PUT", "/integrations/app-credentials/google_drive", { clientId: { a: 1 } }), "client id"));
  check("app-credentials clientId '' -> 400", rejects(await req("PUT", "/integrations/app-credentials/google_drive", { clientId: "" })));
  check("app-credentials enabled 'yes' -> 400", rejects(await req("PUT", "/integrations/app-credentials/google_drive", { clientId: "abc.apps.googleusercontent.com", enabled: "yes" })));
  check("app-credentials unknown provider -> 400", (await req("PUT", "/integrations/app-credentials/not_a_provider", { clientId: "x" })).s === 400);
  const creds = await req("GET", "/integrations/app-credentials");
  check("no credential written by any rejected call", Object.keys(creds.j?.credentials ?? {}).length === 0, JSON.stringify(creds.j)?.slice(0, 160));

  check("disconnect bogus id -> 404 (was 200 {})", (await req("POST", "/integrations/zz-nope/disconnect", {})).s === 404);
  check("sync bogus id -> 404", (await req("POST", "/integrations/zz-nope/sync", {})).s === 404);

  check("drive/export missing dataset -> 400", rejects(await req("POST", "/integrations/drive/export", {}), "dataset"));
  check("drive/export dataset '../../etc/passwd' -> 400", rejects(await req("POST", "/integrations/drive/export", { dataset: "../../etc/passwd" })));
  check("drive/export format 'exe' -> 400", rejects(await req("POST", "/integrations/drive/export", { dataset: "work-orders", format: "exe" }), "format"));

  check("drive/settings folderName {} -> 400", rejects(await req("PUT", "/integrations/drive/settings", { folderName: { a: 1 } }), "foldername"));
  check("drive/settings folderName 5k -> 400", rejects(await req("PUT", "/integrations/drive/settings", { folderName: "F".repeat(5000) })));
  check("drive/settings subfolderByMonth 'yes' -> 400 (silently ignored before)", rejects(await req("PUT", "/integrations/drive/settings", { subfolderByMonth: "yes" }), "month"));
  check("drive/settings empty body -> 400", rejects(await req("PUT", "/integrations/drive/settings", {})));
  // exactly what the Drive settings dialog submits, including a cleared name
  const real = await req("PUT", "/integrations/drive/settings", { folderName: "NVC360 Backups", subfolderByDataset: true, subfolderByMonth: true });
  check("real dialog payload -> 200", real.s === 200 && real.j?.folderName === "NVC360 Backups", `${real.s}`);
  const cleared = await req("PUT", "/integrations/drive/settings", { folderName: "", subfolderByDataset: true, subfolderByMonth: true });
  check("cleared folder name falls back to the default", cleared.s === 200 && cleared.j?.folderName === "NVC360 Backups", `${cleared.s}`);
}

console.log("\n── restore ──");
await db.update(schema.companySettings).set({
  logo: snap.logo, brandColor: snap.brandColor, accentColor: snap.accentColor, email: snap.email,
  website: snap.website, phone: snap.phone, address: snap.address, tagline: snap.tagline, hours: snap.hours,
  workerNoun: snap.workerNoun, workerNounPlural: snap.workerNounPlural,
  customerNoun: snap.customerNoun, customerNounPlural: snap.customerNounPlural,
  jobNoun: snap.jobNoun, jobNounPlural: snap.jobNounPlural,
  services: snap.services, socials: snap.socials, updatedAt: snap.updatedAt,
}).where(eq(schema.companySettings.companyId, TARGET));
const [back] = await db.select().from(schema.companySettings).where(eq(schema.companySettings.companyId, TARGET));
check(`${TARGET} settings restored to the snapshot`, back.brandColor === snap.brandColor && back.tagline === snap.tagline && back.logo === snap.logo && back.email === snap.email);

console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) { console.log("FAILURES:"); for (const f of fails) console.log(" -", f); process.exit(1); }
