/**
 * Fix 11 verification — request-body validation on the OPTIONS/TIER CATALOG
 * (/api/option-catalog), the PUBLIC selections page (/api/selections/:token),
 * and MESSAGING (/api/messages).
 *
 * Every probe below is a request the API accepted, silently mangled, or 500'd
 * on before this pass, reproduced live on :4200 first:
 *
 *  OPTION CATALOG
 *   - POST /categories/:id/items { priceDelta: "1,200" } -> 201 with
 *     priceDelta 0. Number("1,200") is NaN and `|| 0` swallowed it, so the
 *     "Best" upgrade tier was published to the customer as FREE. Same for
 *     "lots" and "$1200". Worst class of bug in the file: it bills the wrong
 *     amount silently instead of erroring.
 *   - priceDelta 1e308 and unitCost "free" went in the same way.
 *   - 20,000-character category name -> 201; sortOrder 1e12 -> 200.
 *   - PATCH /categories/:id {} and { companyId: "..." } -> bare 500
 *     ("No values to set") because nothing survived the field filter.
 *   - PATCH item { image: "javascript:alert(1)" } -> 200, and that value is
 *     rendered in an <img src> on the PUBLIC customer options page.
 *   - DELETE /categories/<bogus> -> 200 ok:true, reporting a delete that
 *     never happened.
 *
 *  MESSAGING
 *   - POST /api/messages/direct returned 500 on EVERY call, including valid
 *     ones: publishMsg("inbox", co) referenced `co`, never declared in that
 *     handler. The throw happened AFTER the message row and the admin
 *     notifications were written, so the app retried and each retry duplicated
 *     the message and the notification (3 sends -> 3 messages, unread: 3).
 *   - { body: 123 } -> 500 on /direct and /dispatch/:techId (123?.trim).
 *   - A 100,000-character body was written straight in.
 *   - /broadcast { body: {} } -> 500; target as a bare string reached the
 *     dispatcher.
 *   - POST /:bookingId inserted the message BEFORE resolving the booking, so
 *     a bad or cross-tenant id left an orphaned message behind.
 *
 * SAFETY: this script never sends a valid /broadcast or a valid /:bookingId
 * message — both fan out real push notifications / a real customer SMS. The
 * one valid send is rider -> dispatch on a throwaway technician (the exact
 * regression guard for the `co` crash), and that technician is deleted at the
 * end.
 *
 * Run: bun verify-fix11.ts   (server must be up on :4200)
 */
const BASE = process.env.BASE || "http://localhost:4200";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
};

const signIn = async (email: string, password: string) => {
  const r = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return ((await r.json()) as any).token as string | undefined;
};

const ADM = await signIn("dan@nvc360.com", "NVC423!!");
if (!ADM) throw new Error("admin sign-in failed");
const AH = { Authorization: `Bearer ${ADM}`, "Content-Type": "application/json" };

const call = async (headers: any, path: string, method: string, body?: unknown) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
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

/** 400 with a named field, and never a 500. */
const rejects = (label: string, r: { status: number; json: any }, field?: string) => {
  check(`${label} → 400`, r.status === 400, `status=${r.status} ${JSON.stringify(r.json)?.slice(0, 120)}`);
  if (field) {
    const named = JSON.stringify(r.json ?? {}).includes(field);
    check(`   names "${field}"`, named, JSON.stringify(r.json)?.slice(0, 160));
  }
};
const status = (label: string, r: { status: number; json: any }, want: number) =>
  check(`${label} → ${want}`, r.status === want, `status=${r.status} ${JSON.stringify(r.json)?.slice(0, 120)}`);

const oc = (p: string, m: string, b?: unknown) => call(AH, `/api/option-catalog${p}`, m, b);
const msg = (h: any, p: string, m: string, b?: unknown) => call(h, `/api/messages${p}`, m, b);

/* ========================================================================== */
console.log("\n=== option-catalog: categories ===");

const madeCat = await oc("/categories", "POST", { name: "ZZ Fix11 Category", description: "probe", sortOrder: 900 });
status("create a valid category", madeCat, 201);
const catId = madeCat.json?.category?.id as string;
if (!catId) throw new Error("could not create the probe category");

rejects("missing name", await oc("/categories", "POST", {}), "Name");
rejects("name: 20,000 chars", await oc("/categories", "POST", { name: "N".repeat(20_000) }), "Name");
rejects("name: 123 (number)", await oc("/categories", "POST", { name: 123 }), "Name");
rejects("sortOrder: 1e12", await oc("/categories", "POST", { name: "ZZ Fix11 x", sortOrder: 1e12 }), "sortOrder");
rejects("sortOrder: \"first\"", await oc("/categories", "POST", { name: "ZZ Fix11 x", sortOrder: "first" }), "sortOrder");
rejects("description: 5,000 chars", await oc("/categories", "POST", { name: "ZZ Fix11 x", description: "d".repeat(5_000) }));

console.log("\n--- PATCH category (the bare-500 cases) ---");
rejects("empty patch {} (was a bare 500)", await oc(`/categories/${catId}`, "PATCH", {}));
rejects("{ companyId } only (was a bare 500 + tenant hop)", await oc(`/categories/${catId}`, "PATCH", { companyId: "some-other-co" }));
rejects("active: \"yes\"", await oc(`/categories/${catId}`, "PATCH", { active: "yes" }), "Active");
status("valid patch still works", await oc(`/categories/${catId}`, "PATCH", { name: "ZZ Fix11 Category (renamed)" }), 200);
status("PATCH a bogus category id", await oc("/categories/zz-not-a-real-id", "PATCH", { name: "x" }), 404);

console.log("\n=== option-catalog: items (money coercion) ===");
const goodItem = await oc(`/categories/${catId}/items`, "POST", {
  name: "ZZ Fix11 Best",
  tierLabel: "Best",
  priceDelta: 1200,
  unitCost: 400,
});
status("create a valid item", goodItem, 201);
const itemId = goodItem.json?.item?.id as string;
check("valid priceDelta stored intact", goodItem.json?.item?.priceDelta === 1200, `priceDelta=${goodItem.json?.item?.priceDelta}`);

for (const bad of ["1,200", "$1200", "lots", ""]) {
  const r = await oc(`/categories/${catId}/items`, "POST", { name: "ZZ Fix11 bad", priceDelta: bad });
  rejects(`priceDelta: ${JSON.stringify(bad)} (was 201 with priceDelta 0)`, r, "Price delta");
  check(
    `   nothing was created for ${JSON.stringify(bad)}`,
    r.json?.item === undefined,
    JSON.stringify(r.json)?.slice(0, 100),
  );
}
rejects("priceDelta: 1e308", await oc(`/categories/${catId}/items`, "POST", { name: "ZZ Fix11 bad", priceDelta: 1e308 }), "Price delta");
rejects("priceDelta: NaN-ish object", await oc(`/categories/${catId}/items`, "POST", { name: "ZZ Fix11 bad", priceDelta: {} }), "Price delta");
rejects("unitCost: \"free\"", await oc(`/categories/${catId}/items`, "POST", { name: "ZZ Fix11 bad", unitCost: "free" }), "Unit cost");
rejects("unitCost: -100 (cost can't be negative)", await oc(`/categories/${catId}/items`, "POST", { name: "ZZ Fix11 bad", unitCost: -100 }), "Unit cost");
rejects("missing item name", await oc(`/categories/${catId}/items`, "POST", { priceDelta: 10 }), "Name");
rejects("isDefault: \"true\" (string)", await oc(`/categories/${catId}/items`, "POST", { name: "ZZ Fix11 bad", isDefault: "true" }), "Default tier");

console.log("\n--- a downgrade credit is still legal ---");
const credit = await oc(`/categories/${catId}/items`, "POST", { name: "ZZ Fix11 Credit", priceDelta: -250 });
status("priceDelta: -250 accepted", credit, 201);
check("negative delta stored intact", credit.json?.item?.priceDelta === -250, `priceDelta=${credit.json?.item?.priceDelta}`);

console.log("\n--- image: stored XSS on the PUBLIC options page ---");
rejects("image: \"javascript:alert(1)\"", await oc(`/categories/${catId}/items/${itemId}`, "PATCH", { image: "javascript:alert(1)" }), "Image");
rejects("image: \"data:text/html;base64,...\"", await oc(`/categories/${catId}/items/${itemId}`, "PATCH", { image: "data:text/html;base64,PHNjcmlwdD4=" }), "Image");
status("a normal https image URL is fine", await oc(`/categories/${catId}/items/${itemId}`, "PATCH", { image: "https://example.com/tier.png" }), 200);
rejects("empty item patch {}", await oc(`/categories/${catId}/items/${itemId}`, "PATCH", {}));

console.log("\n--- DELETE must not lie ---");
status("DELETE a bogus item id (was 200 ok:true)", await oc(`/categories/${catId}/items/zz-not-real`, "DELETE"), 404);
status("DELETE a bogus category id (was 200 ok:true)", await oc("/categories/zz-not-real", "DELETE"), 404);

/* ========================================================================== */
console.log("\n=== public selections page (/api/selections/:token) ===");
// find a real booking with a public token, without mutating it
const bookings = (await call(AH, "/api/bookings", "GET")).json?.bookings as any[] | undefined;
const tokened = (bookings ?? []).find((b) => b.publicToken);
if (!tokened) {
  console.log("  (skipped — no booking with a publicToken in this tenant)");
} else {
  const PH = { "Content-Type": "application/json" };
  const sel = (b: unknown) => call(PH, `/api/selections/${tokened.publicToken}`, "POST", b);
  rejects("no selections array", await sel({ signatureName: "Test" }), "selections");
  rejects("selections: []", await sel({ selections: [], signatureName: "Test" }), "selections");
  rejects("selections: 60 entries (unbounded fan-out)", await sel({
    selections: Array.from({ length: 60 }, (_, i) => ({ categoryId: `c${i}`, itemId: `i${i}` })),
    signatureName: "Test",
  }), "selections");
  rejects("two selections for the SAME category (billed twice)", await sel({
    selections: [
      { categoryId: catId, itemId: itemId },
      { categoryId: catId, itemId: itemId },
    ],
    signatureName: "Test",
  }), "category");
  rejects("missing signatureName", await sel({ selections: [{ categoryId: catId, itemId }] }), "Signature");
  rejects("signatureName: 5,000 chars", await sel({ selections: [{ categoryId: catId, itemId }], signatureName: "S".repeat(5_000) }), "Signature");
  status("bad token still 404s", await call(PH, "/api/selections/zz-not-a-token", "POST", {
    selections: [{ categoryId: catId, itemId }],
    signatureName: "Test",
  }), 404);
}

/* ========================================================================== */
console.log("\n=== messages: the /direct 500-and-duplicate crash ===");
const RIDER_EMAIL = "zzfix11probe@example.com";
const RIDER_PW = "pw12345678";
const mkRider = await call(AH, "/api/riders", "POST", {
  name: "ZZ Fix11 Probe Tech",
  email: RIDER_EMAIL,
  password: RIDER_PW,
  skillClass: "HVAC",
});
status("create a throwaway technician", mkRider, 201);
const riderId = mkRider.json?.rider?.id as string;
const riderTok = await signIn(RIDER_EMAIL, RIDER_PW);
if (!riderId || !riderTok) throw new Error("could not set up the probe technician");
const RH = { Authorization: `Bearer ${riderTok}`, "Content-Type": "application/json" };

const before = (await msg(AH, `/dispatch/${riderId}`, "GET")).json?.messages?.length ?? 0;
const notifBefore = (await call(AH, "/api/notifications", "GET")).json?.notifications?.length ?? 0;

const sent = await msg(RH, "/direct", "POST", { body: "Fix11 regression guard — on my way" });
status("rider POST /direct with valid text (was 500 every time)", sent, 201);
check("the response carries the created message", !!sent.json?.message?.id, JSON.stringify(sent.json)?.slice(0, 120));

const after = (await msg(AH, `/dispatch/${riderId}`, "GET")).json?.messages?.length ?? 0;
check("exactly ONE message written (was duplicated per retry)", after === before + 1, `${before} → ${after}`);
const notifAfter = (await call(AH, "/api/notifications", "GET")).json?.notifications?.length ?? 0;
check("admin notification not duplicated", notifAfter === notifBefore + 1, `${notifBefore} → ${notifAfter}`);

console.log("\n--- /direct body validation ---");
const dCountBefore = (await msg(AH, `/dispatch/${riderId}`, "GET")).json?.messages?.length ?? 0;
rejects("body: 123 (was a 500)", await msg(RH, "/direct", "POST", { body: 123 }), "Message");
rejects("body: 100,000 chars", await msg(RH, "/direct", "POST", { body: "X".repeat(100_000) }), "Message");
rejects("body: \"   \" (whitespace only)", await msg(RH, "/direct", "POST", { body: "   " }), "Message");
rejects("no body at all", await msg(RH, "/direct", "POST", {}), "Message");
rejects("body: {}", await msg(RH, "/direct", "POST", { body: {} }), "Message");
const dCountAfter = (await msg(AH, `/dispatch/${riderId}`, "GET")).json?.messages?.length ?? 0;
check("no rejected message was written", dCountAfter === dCountBefore, `${dCountBefore} → ${dCountAfter}`);

console.log("\n--- /dispatch/:techId (rejections only — a valid send pushes) ---");
rejects("body: 123 (was a 500 that still pushed)", await msg(AH, `/dispatch/${riderId}`, "POST", { body: 123 }), "Message");
rejects("body: 100,000 chars", await msg(AH, `/dispatch/${riderId}`, "POST", { body: "X".repeat(100_000) }), "Message");
rejects("no body", await msg(AH, `/dispatch/${riderId}`, "POST", {}), "Message");
status("bogus techId", await msg(AH, "/dispatch/zz-not-real", "POST", { body: "hello" }), 404);

console.log("\n--- /broadcast (rejections only — a valid send fans out to every tech) ---");
rejects("target as a bare string", await msg(AH, "/broadcast", "POST", { body: "hi", target: "everyone-everywhere" }), "target");
rejects("target.type: \"everyone\"", await msg(AH, "/broadcast", "POST", { body: "hi", target: { type: "everyone" } }), "Target");
rejects("body: {} (was a 500)", await msg(AH, "/broadcast", "POST", { body: {}, target: { type: "all" } }), "Message");
rejects("no target", await msg(AH, "/broadcast", "POST", { body: "hi" }), "target");
rejects("body: 100,000 chars", await msg(AH, "/broadcast", "POST", { body: "X".repeat(100_000), target: { type: "all" } }), "Message");

console.log("\n--- POST /:bookingId must resolve the booking BEFORE inserting ---");
const bogusId = "zz-not-a-real-booking";
const orphanBefore = (await msg(AH, `/${bogusId}`, "GET")).json?.messages?.length ?? 0;
status("bogus bookingId", await msg(AH, `/${bogusId}`, "POST", { body: "orphan check" }), 404);
const orphanAfter = (await msg(AH, `/${bogusId}`, "GET")).json?.messages?.length ?? 0;
check("no orphan message written (was insert-then-lookup)", orphanAfter === orphanBefore, `${orphanBefore} → ${orphanAfter}`);
if (tokened) {
  rejects("valid bookingId but body: 123", await msg(AH, `/${tokened.id}`, "POST", { body: 123 }), "Message");
}

/* ========================================================================== */
console.log("\n=== cleanup ===");
status("delete the probe technician", await call(AH, `/api/riders/${riderId}`, "DELETE"), 200);
status("delete the probe category (cascades its items)", await oc(`/categories/${catId}`, "DELETE"), 200);
const leftover = ((await oc("/categories", "GET")).json?.categories as any[] ?? []).filter((x) =>
  String(x.name).startsWith("ZZ Fix11"),
);
check("no catalog fixtures left behind", leftover.length === 0, `left: ${JSON.stringify(leftover.map((x) => x.name))}`);
const leftoverRiders = ((await call(AH, "/api/riders", "GET")).json?.riders as any[] ?? []).filter((r) =>
  String(r.name).startsWith("ZZ Fix11"),
);
check("no technician fixtures left behind", leftoverRiders.length === 0, `left: ${leftoverRiders.length}`);

console.log(fail === 0 ? `\nALL PASS: ${pass} passed, 0 failed\n` : `\nFAILURES: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
