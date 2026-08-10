/**
 * verify-fix12 — tags.ts + custom-fields.ts request-body validation.
 *
 * Every assertion below maps to a hole that was REPRODUCED live on :4200
 * before the fix (see the comment blocks at the top of both route files).
 * The headline one: `options: "a,b,c"` on a select field stored a JSON string,
 * and the renderer's `JSON.parse(options).map(...)` threw
 * "o.map is not a function", putting the entire technician drawer behind the
 * error boundary for every admin.
 *
 * Run: cd packages/web && set -a && source ../../.env && set +a && bun verify-fix12.ts
 */
const BASE = process.env.VERIFY_BASE ?? "http://localhost:4200";

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
/** A 400 that names the offending field, not a bare 500 or a silent coercion. */
const rejects = (r: any, field?: string) =>
  r.s === 400 && (!field || JSON.stringify(r.j ?? {}).toLowerCase().includes(field.toLowerCase()));

const created: { tags: string[]; fields: string[] } = { tags: [], fields: [] };

console.log("\n── tags: create validation ──");
{
  const good = await req("POST", "/tags", { label: "ZZ verify tag", color: "#123456", scope: "client" });
  check("valid tag -> 201", good.s === 201 && good.j?.tag?.color === "#123456", `${good.s}`);
  if (good.j?.tag?.id) created.tags.push(good.j.tag.id);

  check("color javascript:alert(1) -> 400", rejects(await req("POST", "/tags", { label: "ZZ v", color: "javascript:alert(1)" }), "colour"));
  check("color <script> -> 400", rejects(await req("POST", "/tags", { label: "ZZ v", color: "<script>x</script>" })));
  check("color 'red' (not hex) -> 400", rejects(await req("POST", "/tags", { label: "ZZ v", color: "red" })));
  check("scope nonsense -> 400", rejects(await req("POST", "/tags", { label: "ZZ v", scope: "whatever-i-want" }), "scope"));
  check("label 20k -> 400", rejects(await req("POST", "/tags", { label: "Z".repeat(20000) }), "label"));
  check("label 123 (number) -> 400", rejects(await req("POST", "/tags", { label: 123 }), "label"));
  check("label '' -> 400", rejects(await req("POST", "/tags", { label: "" }), "label"));

  const mass = await req("POST", "/tags", { label: "ZZ verify mass", companyId: "other-tenant", id: "forced-id" });
  check("unknown keys stripped, not honoured", mass.s === 201 && mass.j?.tag?.id !== "forced-id" && mass.j?.tag?.companyId !== "other-tenant", JSON.stringify(mass.j)?.slice(0, 120));
  if (mass.j?.tag?.id) created.tags.push(mass.j.tag.id);
}

console.log("\n── tags: patch / delete honesty ──");
{
  check("PUT bogus id -> 404 (was 200 {})", (await req("PUT", "/tags/zz-nope", { label: "ZZ renamed" })).s === 404);
  check("PUT empty body -> 400 (was 500)", rejects(await req("PUT", `/tags/${created.tags[0]}`, {})));
  check("DELETE bogus id -> 404 (was 200 ok:true)", (await req("DELETE", "/tags/zz-does-not-exist")).s === 404);
  const patched = await req("PUT", `/tags/${created.tags[0]}`, { label: "ZZ verify renamed" });
  check("valid PUT still 200", patched.s === 200 && patched.j?.tag?.label === "ZZ verify renamed", `${patched.s}`);
}

console.log("\n── tags: entity links (silent data loss) ──");
{
  const ent = `/tags/entity/tech/zz-verify-entity`;
  // seed a real link so we can prove a bad payload doesn't wipe it
  const seed = await req("PUT", ent, { tagIds: [created.tags[0]] });
  check("seed link -> 200", seed.s === 200, `${seed.s}`);
  check("seed persisted", ((await req("GET", ent)).j?.tags ?? []).length === 1);

  check('tagIds "hi" -> 400 (was 200 after wiping links)', rejects(await req("PUT", ent, { tagIds: "hi" }), "tag"));
  check("tagIds [1,2] -> 400 (was 500)", rejects(await req("PUT", ent, { tagIds: [1, 2] })));
  check("tagIds 5000 entries -> 400 (was 500)", rejects(await req("PUT", ent, { tagIds: Array.from({ length: 5000 }, (_, i) => `t${i}`) })));
  check("tagIds with unknown id -> 400", rejects(await req("PUT", ent, { tagIds: ["11111111-1111-1111-1111-111111111111"] })));
  check("existing link SURVIVED every rejected payload", ((await req("GET", ent)).j?.tags ?? []).length === 1);

  const dup = await req("PUT", ent, { tagIds: [created.tags[0], created.tags[0]] });
  check("duplicate id de-duplicated", dup.s === 200 && ((await req("GET", ent)).j?.tags ?? []).length === 1);
  check("unknown record type -> 404", (await req("PUT", "/tags/entity/not-a-thing/zz", { tagIds: [] })).s === 404);
  await req("PUT", ent, { tagIds: [] });
}

console.log("\n── custom fields: the drawer-killer ──");
{
  const bad = await req("POST", "/custom-fields", { label: "ZZ verify select", type: "select", entity: "tech", options: "a,b,c" });
  check('options "a,b,c" (string) -> 400  [crashed the tech drawer]', rejects(bad, "options"), `${bad.s}`);
  check("options [1,2] -> 400", rejects(await req("POST", "/custom-fields", { label: "ZZ v", type: "select", entity: "tech", options: [1, 2] })));
  check("options 500 entries -> 400", rejects(await req("POST", "/custom-fields", { label: "ZZ v", type: "select", entity: "tech", options: Array.from({ length: 500 }, (_, i) => `o${i}`) })));

  const good = await req("POST", "/custom-fields", { label: "ZZ verify field", type: "select", entity: "tech", options: ["A", "B"] });
  check("valid select field -> 201 with array options", good.s === 201 && JSON.parse(good.j?.field?.options ?? "null")?.length === 2, `${good.s}`);
  if (good.j?.field?.id) created.fields.push(good.j.field.id);
  const fid = created.fields[0];

  check("type nonsense -> 400", rejects(await req("POST", "/custom-fields", { label: "ZZ v", type: "nuclear-launch", entity: "tech" }), "type"));
  check("entity nonsense -> 400", rejects(await req("POST", "/custom-fields", { label: "ZZ v", type: "text", entity: "whatever" })));
  check("label 20k -> 400", rejects(await req("POST", "/custom-fields", { label: "Z".repeat(20000), type: "text", entity: "tech" }), "label"));
  check("no label -> 400", rejects(await req("POST", "/custom-fields", { type: "text", entity: "tech" })));
  check("required 'yes' (string) -> 400", rejects(await req("POST", "/custom-fields", { label: "ZZ v", type: "text", entity: "tech", required: "yes" })));
  check("sortOrder 1e12 -> 400", rejects(await req("POST", "/custom-fields", { label: "ZZ v", type: "text", entity: "tech", sortOrder: 1e12 })));

  check("PUT bogus id -> 404 (was 200 {})", (await req("PUT", "/custom-fields/zz-nope", { label: "x" })).s === 404);
  check("PUT empty body -> 400", rejects(await req("PUT", `/custom-fields/${fid}`, {})));
  check('PUT options "a,b" -> 400', rejects(await req("PUT", `/custom-fields/${fid}`, { options: "a,b" })));
  const okPut = await req("PUT", `/custom-fields/${fid}`, { options: ["A", "B", "C"] });
  check("valid PUT options -> 200 array", okPut.s === 200 && JSON.parse(okPut.j?.field?.options ?? "null")?.length === 3);
  check("DELETE bogus id -> 404 (was 200 ok:true)", (await req("DELETE", "/custom-fields/zz-does-not-exist")).s === 404);
}

console.log("\n── custom fields: stored values ──");
{
  const fid = created.fields[0];
  const vp = `/custom-fields/values/tech/zz-verify-vals`;
  const good = await req("PUT", vp, { values: { [fid]: "A" } });
  check("valid values -> 200", good.s === 200, `${good.s}`);
  check("value read back", (await req("GET", vp)).j?.values?.[fid] === "A");
  check("values 'hi' (string) -> 400", rejects(await req("PUT", vp, { values: "hi" })));
  check("non-string answer -> 400", rejects(await req("PUT", vp, { values: { [fid]: { nested: true } } })));
  check("100k answer -> 400", rejects(await req("PUT", vp, { values: { [fid]: "X".repeat(100_000) } })));
  check("unknown fieldId -> 400 (no junk rows)", rejects(await req("PUT", vp, { values: { "11111111-1111-1111-1111-111111111111": "x" } })));
  check("stored value survived rejected writes", (await req("GET", vp)).j?.values?.[fid] === "A");
}

console.log("\n── cleanup ──");
for (const id of created.fields) console.log("  field", id, (await req("DELETE", `/custom-fields/${id}`)).s);
for (const id of created.tags) console.log("  tag", id, (await req("DELETE", `/tags/${id}`)).s);
const leftTags = ((await req("GET", "/tags")).j?.tags ?? []).filter((t: any) => String(t.label).startsWith("ZZ"));
const leftFields = ((await req("GET", "/custom-fields")).j?.fields ?? []).filter((f: any) => String(f.label).startsWith("ZZ"));
check("no ZZ fixtures left behind", leftTags.length === 0 && leftFields.length === 0, JSON.stringify({ leftTags, leftFields }).slice(0, 200));

console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) { console.log("FAILURES:"); for (const f of fails) console.log(" -", f); process.exit(1); }
