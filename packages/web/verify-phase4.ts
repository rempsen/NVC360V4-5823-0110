/**
 * Phase 4 verification — unified inbox.
 *
 * Exercises the real running server on :4200 (tsc is not trustworthy in this
 * repo). Creates throwaway bookings with NO rider assigned so nothing sends a
 * real SMS, then deletes every row it made.
 *
 * Run from packages/web:
 *   bun --env-file=../../.env verify-phase4.ts
 */
import { createClient } from "@libsql/client";

const BASE = "http://localhost:4200";
const EMAIL = "dan@nvc360.com";
const PASSWORD = "NVC423!!";
const COMPANY = "default";
const CUSTOMER = "6G8OQVJnUNnG388iGQs6Lw5sO5Q8nEQT";
const SERVICE = "52f2fc46-310a-45a5-9c0b-91c2941437cf";

const db = createClient({
  url: process.env.DATABASE_URL!,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 400));
  }
}

const rid = () => crypto.randomUUID();
const tok = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

async function makeBooking(companyId: string, title: string) {
  const id = rid();
  const token = tok();
  await db.execute({
    sql: `insert into bookings
      (id, customer_id, service_id, rider_id, status, address, title, public_token, company_id, created_at, scheduled_at)
      values (?, ?, ?, NULL, 'pending', ?, ?, ?, ?, ?, ?)`,
    args: [id, CUSTOMER, SERVICE, "1 Verify St", title, token, companyId, Date.now(), Date.now()],
  });
  return { id, token };
}

async function cleanup(bookingIds: string[]) {
  for (const b of bookingIds) {
    await db.execute({ sql: "delete from messages where booking_id = ?", args: [b] });
    await db.execute({ sql: "delete from notifications where booking_id = ?", args: [b] });
    await db.execute({ sql: "delete from job_events where booking_id = ?", args: [b] });
    await db.execute({ sql: "delete from bookings where id = ?", args: [b] });
  }
}

const created: string[] = [];

try {
  // ── auth ────────────────────────────────────────────────────────────────
  const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const setCookie = signIn.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  check("sign-in returns 200 + session cookie", signIn.status === 200 && cookie.length > 0, {
    status: signIn.status,
  });
  if (!cookie) throw new Error("no session cookie — aborting");
  const auth = { cookie } as Record<string, string>;

  // ── 1. unauthenticated access is rejected ───────────────────────────────
  const anon = await fetch(`${BASE}/api/messages/inbox`);
  check("GET /api/messages/inbox unauthenticated → 401", anon.status === 401, { status: anon.status });

  // ── 2. baseline inbox shape ─────────────────────────────────────────────
  const r0 = await fetch(`${BASE}/api/messages/inbox`, { headers: auth });
  const j0: any = await r0.json();
  check("GET /api/messages/inbox → 200", r0.status === 200, { status: r0.status });
  check("response has threads[] (route not shadowed by /:bookingId)", Array.isArray(j0.threads), j0);
  check(
    "response has counts {all,client,tech,broadcast,unread}",
    j0.counts &&
      ["all", "client", "tech", "broadcast", "unread"].every((k) => typeof j0.counts[k] === "number"),
    j0.counts,
  );
  const kinds = new Set((j0.threads ?? []).map((t: any) => t.kind));
  check(
    "thread kinds are only client|tech|broadcast",
    [...kinds].every((k) => ["client", "tech", "broadcast"].includes(k as string)),
    [...kinds],
  );
  check(
    "counts.all equals threads.length",
    j0.counts?.all === j0.threads?.length,
    { all: j0.counts?.all, len: j0.threads?.length },
  );
  const baselineUnread = j0.counts?.unread ?? 0;

  // ── 3. homeowner message from the public /t/ page ───────────────────────
  const bk = await makeBooking(COMPANY, "Phase4 Verify Job");
  created.push(bk.id);

  const post = await fetch(`${BASE}/api/track/${bk.token}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "Phase4 verify: is the tech still coming?", senderName: "Verify Homeowner" }),
  });
  check("POST /api/track/:token/messages → 201", post.status === 201, { status: post.status });

  const r1 = await fetch(`${BASE}/api/messages/inbox`, { headers: auth });
  const j1: any = await r1.json();
  const th = (j1.threads ?? []).find((t: any) => t.key === `client:${bk.id}`);
  check("public-page message surfaces as a client thread in the inbox", !!th, {
    keys: (j1.threads ?? []).slice(0, 3).map((t: any) => t.key),
  });
  check("thread kind is client", th?.kind === "client", th?.kind);
  check("thread carries bookingId", th?.bookingId === bk.id, th?.bookingId);
  check("thread lastMessage is the homeowner's text", th?.lastMessage?.includes("is the tech still coming"), th?.lastMessage);
  check("thread lastSenderRole is client", th?.lastSenderRole === "client", th?.lastSenderRole);
  check("thread unread === 1", th?.unread === 1, th?.unread);
  check("counts.unread incremented by 1", j1.counts?.unread === baselineUnread + 1, {
    before: baselineUnread,
    after: j1.counts?.unread,
  });
  check("thread exposes jobTitle for the deep link", th?.jobTitle === "Phase4 Verify Job", th?.jobTitle);
  check("unread thread sorts to the top", j1.threads?.[0]?.unread > 0, j1.threads?.[0]?.key);

  // ── 4. office notification created for admins of THIS tenant ────────────
  const notif = await db.execute({
    sql: `select n.id, n.user_id, u.role, u.company_id
            from notifications n join user u on u.id = n.user_id
           where n.booking_id = ?`,
    args: [bk.id],
  });
  check("office notification row(s) created for the homeowner reply", notif.rows.length > 0, notif.rows.length);
  check(
    "every notified user is an admin/superadmin in the same company",
    notif.rows.every((r: any) => ["admin", "superadmin"].includes(r.role) && r.company_id === COMPANY),
    notif.rows.map((r: any) => [r.role, r.company_id]),
  );

  // ── 5. reading the inbox does NOT mark anything read ────────────────────
  await fetch(`${BASE}/api/messages/inbox`, { headers: auth });
  await fetch(`${BASE}/api/messages/inbox`, { headers: auth });
  const stillUnread = await db.execute({
    sql: "select read from messages where booking_id = ? and sender_role = 'client'",
    args: [bk.id],
  });
  check(
    "polling GET /inbox leaves messages unread (fetch ≠ mark-read)",
    stillUnread.rows.every((r: any) => !r.read),
    stillUnread.rows,
  );

  // reading the job thread itself must also not mark it read
  await fetch(`${BASE}/api/messages/${bk.id}`, { headers: auth });
  const afterThreadGet = await db.execute({
    sql: "select read from messages where booking_id = ? and sender_role = 'client'",
    args: [bk.id],
  });
  check(
    "GET /api/messages/:bookingId leaves messages unread",
    afterThreadGet.rows.every((r: any) => !r.read),
    afterThreadGet.rows,
  );

  // ── 6. explicit mark-read clears it ─────────────────────────────────────
  const mr = await fetch(`${BASE}/api/messages/${bk.id}/mark-read`, { method: "POST", headers: auth });
  check("POST /api/messages/:bookingId/mark-read → 200", mr.status === 200, { status: mr.status });

  const r2 = await fetch(`${BASE}/api/messages/inbox`, { headers: auth });
  const j2: any = await r2.json();
  const th2 = (j2.threads ?? []).find((t: any) => t.key === `client:${bk.id}`);
  check("thread still listed after mark-read", !!th2);
  check("thread unread === 0 after mark-read", th2?.unread === 0, th2?.unread);
  check("counts.unread back to baseline", j2.counts?.unread === baselineUnread, {
    baseline: baselineUnread,
    now: j2.counts?.unread,
  });

  // ── 7. office reply lands in the same thread ────────────────────────────
  const reply = await fetch(`${BASE}/api/messages/${bk.id}`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ body: "Phase4 verify: yes, on the way." }),
  });
  check("POST /api/messages/:bookingId (office reply) → 200/201", [200, 201].includes(reply.status), {
    status: reply.status,
  });
  const r3 = await fetch(`${BASE}/api/messages/inbox`, { headers: auth });
  const j3: any = await r3.json();
  const th3 = (j3.threads ?? []).find((t: any) => t.key === `client:${bk.id}`);
  check("inbox reflects the office reply as lastMessage", th3?.lastMessage?.includes("on the way"), th3?.lastMessage);
  check("office reply does not create unread for the office", th3?.unread === 0, th3?.unread);
  check("messageCount is 2", th3?.messageCount === 2, th3?.messageCount);

  // homeowner can read the office reply back on the public page
  const pub = await fetch(`${BASE}/api/track/${bk.token}/messages`);
  const pubJson: any = await pub.json();
  check(
    "homeowner sees both messages on /t/:token",
    pub.status === 200 && (pubJson.messages ?? []).length === 2,
    { status: pub.status, n: (pubJson.messages ?? []).length },
  );

  // ── 8. tenant isolation ─────────────────────────────────────────────────
  const otherCompany = `verify-tenant-${tok()}`;
  await db.execute({
    sql: "insert into companies (id, name, created_at) values (?, ?, ?)",
    args: [otherCompany, "Phase4 Verify Tenant", Date.now()],
  }).catch(() => {});
  const other = await makeBooking(otherCompany, "Other Tenant Job");
  created.push(other.id);
  await fetch(`${BASE}/api/track/${other.token}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "Phase4 verify: other tenant message", senderName: "Other" }),
  });
  const r4 = await fetch(`${BASE}/api/messages/inbox`, { headers: auth });
  const j4: any = await r4.json();
  check(
    "other tenant's thread is NOT visible in this tenant's inbox",
    !(j4.threads ?? []).some((t: any) => t.bookingId === other.id),
    (j4.threads ?? []).map((t: any) => t.bookingId).filter(Boolean).slice(0, 5),
  );
  const crossNotif = await db.execute({
    sql: `select u.company_id from notifications n join user u on u.id = n.user_id where n.booking_id = ?`,
    args: [other.id],
  });
  check(
    "no cross-tenant notifications leaked to default admins",
    crossNotif.rows.every((r: any) => r.company_id === otherCompany),
    crossNotif.rows.map((r: any) => r.company_id),
  );
  await db.execute({ sql: "delete from companies where id = ?", args: [otherCompany] }).catch(() => {});

  // ── 9. SSE stream ───────────────────────────────────────────────────────
  const ctrl = new AbortController();
  const sse = await fetch(`${BASE}/api/messages/inbox/stream`, { headers: auth, signal: ctrl.signal });
  check("GET /api/messages/inbox/stream → 200", sse.status === 200, { status: sse.status });
  check(
    "stream content-type is text/event-stream",
    (sse.headers.get("content-type") ?? "").includes("text/event-stream"),
    sse.headers.get("content-type"),
  );
  ctrl.abort();

  const sseAnon = await fetch(`${BASE}/api/messages/inbox/stream`).catch(() => null);
  check("stream unauthenticated → 401", sseAnon?.status === 401, { status: sseAnon?.status });

  // ── 10. admin SPA route is served ───────────────────────────────────────
  const page = await fetch(`${BASE}/admin/inbox`, { headers: auth });
  check("/admin/inbox serves the SPA shell (200 html)", page.status === 200, { status: page.status });
} finally {
  await cleanup(created);
  console.log(`\ncleaned up ${created.length} throwaway booking(s)`);
  console.log(`\nPhase 4: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
