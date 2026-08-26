/**
 * The public intake submit endpoint is the only unauthenticated path that
 * creates a real client row, a real pending booking, and fires real customer
 * notifications (email/SMS, which cost money). Until now its only bot defence
 * was a per-IP rate limit of 30/min — which a single scripted submitter or a
 * spread of residential IPs walks straight through, and which does nothing at
 * all about the one-shot spam bots that crawl for public forms.
 *
 * Two cheap, no-friction guards (no CAPTCHA, no third-party script, nothing a
 * real visitor ever sees):
 *
 *   1. Honeypot — the form renders a hidden field a human can never fill. If it
 *      arrives with a value, the submission is a bot.
 *   2. Minimum fill time — the form stamps its render time and posts it back. A
 *      submission that arrives within a couple of seconds of the page rendering
 *      was not typed by a person.
 *
 * Both must fail CLOSED-BUT-QUIET: write nothing (no user, no membership, no
 * booking, no submission row, no notification) while returning the same success
 * response a real visitor gets, so a bot gets no signal to tune against.
 *
 * The timestamp is client-supplied and therefore spoofable — this is a spam
 * filter, not authentication. Which is also why a MISSING timestamp must still
 * be accepted: tenants embed this endpoint from their own sites and post plain
 * JSON to it, and silently eating their leads would be far worse than the spam.
 *
 * Harness mirrors intake-form-hygiene.test.ts: ephemeral in-memory libsql, DDL
 * derived from drizzle, ids prefixed "intakebot-" (Bun shares one ":memory:"
 * store across test files in one process).
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import { ensureSchema } from "../../database/__tests__/setup";

await ensureSchema();

const { db } = await import("../../database/index");
const schema = await import("../../database/schema");
const { publicFormsRoutes } = await import("../public-forms");
const { hashApiKey } = await import("../../middleware/auth");
const { AppError } = await import("../../lib/errors");
const { renderJson } = await import("../../lib/metrics");

const CO = "intakebot-company";
const SLUG = "bot-quote";
const PUB_KEY = "nvcpub_intakebottestkey000000000000";

const app = new Hono();
app.route("/public/forms", publicFormsRoutes);
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.expose ? err.message : "error" } }, err.status as 400);
  }
  return c.json({ error: { code: "internal", message: String((err as Error).message) } }, 500);
});

beforeAll(async () => {
  const sql = (db as any).$client;

  await sql.query(
    "INSERT INTO api_keys (id, company_id, hashed_key, key_type, public_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    ["intakebot-key", CO, await hashApiKey(PUB_KEY), "public", PUB_KEY],
  );
  await sql.query(
    "INSERT INTO services (id, company_id, name, category, base_price, active) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
    ["intakebot-svc", CO, "Intake service", "hvac", 100, true],
  );
  await sql.query(
    "INSERT INTO intake_forms (id, company_id, slug, title, active, default_service_id, success_message) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
    ["intakebot-form", CO, SLUG, "Request Service", true, "intakebot-svc", "Thanks! We'll be in touch."],
  );
});

function submit(body: Record<string, unknown>) {
  return app.request(`/public/forms/${CO}/${SLUG}/submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Public-Key": PUB_KEY,
      "X-Forwarded-For": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
    },
    body: JSON.stringify(body),
  });
}

const usersFor = async (email: string) =>
  (await db.select().from(schema.user)).filter((u) => u.email === email);

async function counts() {
  return {
    users: (await db.select().from(schema.user)).length,
    memberships: (await db.select().from(schema.memberships)).length,
    bookings: (await db.select().from(schema.bookings)).length,
    submissions: (await db.select().from(schema.intakeSubmissions)).length,
  };
}

describe("public intake — honeypot", () => {
  it("drops a submission with the honeypot filled, writing nothing, and still looks successful", async () => {
    const email = `bot-${crypto.randomUUID().slice(0, 8)}@spam.test`;
    const before = await counts();

    const res = await submit({
      name: "Spam Bot",
      email,
      address: "1 Portage Ave",
      _hp: "http://buy-cheap-pills.example",
    });

    // Looks exactly like the real thing from the outside.
    expect(res.status).toBe(201);
    expect((await res.json()) as any).toMatchObject({ ok: true });

    // ...but nothing at all was written.
    const after = await counts();
    expect(after).toEqual(before);
    expect((await usersFor(email)).length).toBe(0);
  });

  it("counts blocked bots in metrics so the tenant isn't blind to it", async () => {
    const key = "intake_bot_blocked";
    const read = () => Number((renderJson() as any).counters?.[key] ?? 0);
    const start = read();
    await submit({ name: "Bot Two", address: "1 Portage Ave", _hp: "x" });
    expect(read()).toBeGreaterThan(start);
  });

  it("an empty or whitespace-only honeypot is a real visitor, not a bot", async () => {
    const email = `human-${crypto.randomUUID().slice(0, 8)}@t.test`;
    const res = await submit({ name: "Real Human", email, address: "1 Portage Ave", _hp: "   " });
    expect(res.status).toBe(201);
    expect((await usersFor(email)).length).toBe(1);
  });
});

describe("public intake — minimum fill time", () => {
  it("drops a submission posted the instant the form rendered", async () => {
    const email = `instant-${crypto.randomUUID().slice(0, 8)}@spam.test`;
    const before = await counts();

    const res = await submit({
      name: "Instant Bot",
      email,
      address: "1 Portage Ave",
      _ts: Date.now(),
    });

    expect(res.status).toBe(201);
    const after = await counts();
    expect(after).toEqual(before);
    expect((await usersFor(email)).length).toBe(0);
  });

  it("accepts a submission from someone who actually spent time filling it in", async () => {
    const email = `typed-${crypto.randomUUID().slice(0, 8)}@t.test`;
    const res = await submit({
      name: "Typed It Out",
      email,
      address: "1 Portage Ave",
      _ts: Date.now() - 30_000,
    });
    expect(res.status).toBe(201);
    expect((await usersFor(email)).length).toBe(1);
  });

  it("accepts a submission with no timestamp at all (tenant posting JSON directly)", async () => {
    const email = `noTs-${crypto.randomUUID().slice(0, 8)}@t.test`;
    const res = await submit({ name: "Direct Integration", email, address: "1 Portage Ave" });
    expect(res.status).toBe(201);
    expect((await usersFor(email.toLowerCase())).length).toBe(1);
  });

  it("ignores a garbage or future timestamp rather than dropping the lead", async () => {
    const email = `weird-${crypto.randomUUID().slice(0, 8)}@t.test`;
    const res = await submit({ name: "Clock Skew", email, address: "1 Portage Ave", _ts: "not-a-number" });
    expect(res.status).toBe(201);
    expect((await usersFor(email)).length).toBe(1);
  });
});
