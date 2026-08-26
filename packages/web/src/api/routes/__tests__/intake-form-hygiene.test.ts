/**
 * The public intake form is the only unauthenticated write path into a tenant's
 * client roster, so three things have to hold:
 *
 *   1. A REFUSED submission must write nothing at all. The zone check used to
 *      run after find-or-create-customer and after the photo upload, so an
 *      out-of-area submission still left a real `user` row + membership on the
 *      tenant's client list (and an orphan object in storage) before returning
 *      422 to the visitor.
 *   2. A submitted email address must look like an email. It is written to
 *      `user.email` (the tenant's client record) and used as the `Reply-To` of
 *      the notification email, so garbage there poisons both.
 *   3. An oversized photo must be reported, not silently dropped. The upload was
 *      guarded by `size <= 15MB` with no else branch: the visitor got the normal
 *      success screen and the tenant got a lead with no photo.
 *
 * Harness mirrors intake-form-service-zone.test.ts: ephemeral in-memory libsql,
 * DDL derived from drizzle, ids prefixed "intakehyg-" (Bun shares one
 * ":memory:" store across test files in one process). No network — every case
 * supplies coordinates, and there are no provider credentials under `bun test`.
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

const CO = "intakehyg-company";
const SLUG = "get-a-quote";
const PUB_KEY = "nvcpub_intakehygtestkey00000000000";

const INSIDE = { lat: 49.895, lng: -97.138 };
const OUTSIDE = { lat: 43.6532, lng: -79.3832 };
const ZONE_POLY: [number, number][] = [
  [49.87, -97.20],
  [49.92, -97.20],
  [49.92, -97.08],
  [49.87, -97.08],
];

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
    ["intakehyg-key", CO, await hashApiKey(PUB_KEY), "public", PUB_KEY],
  );
  await sql.query(
    "INSERT INTO services (id, company_id, name, category, base_price, active) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
    ["intakehyg-svc", CO, "Intake service", "hvac", 100, true],
  );
  await sql.query(
    "INSERT INTO intake_forms (id, company_id, slug, title, active, default_service_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
    ["intakehyg-form", CO, SLUG, "Request Service", true, "intakehyg-svc"],
  );
  await sql.query(
    "INSERT INTO service_zones (id, company_id, name, polygon, active) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    ["intakehyg-zone", CO, "Winnipeg", JSON.stringify(ZONE_POLY), true],
  );
});

function submit(body: Record<string, unknown>) {
  return app.request(`/public/forms/${CO}/${SLUG}/submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Public-Key": PUB_KEY,
      "X-Forwarded-For": `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
    },
    body: JSON.stringify(body),
  });
}

function submitForm(fields: Array<[string, string | Blob]>) {
  const fd = new FormData();
  for (const [k, v] of fields) fd.append(k, v as any);
  return app.request(`/public/forms/${CO}/${SLUG}/submit`, {
    method: "POST",
    headers: {
      "X-Public-Key": PUB_KEY,
      "X-Forwarded-For": `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
    },
    body: fd,
  });
}

const usersFor = async (email: string) =>
  (await db.select().from(schema.user)).filter((u) => u.email === email);

describe("public intake — a refused submission writes nothing", () => {
  it("out-of-area submit creates no user row and no membership", async () => {
    const email = `outside-${crypto.randomUUID().slice(0, 8)}@t.test`;
    const beforeUsers = (await db.select().from(schema.user)).length;
    const beforeMems = (await db.select().from(schema.memberships)).length;

    const res = await submit({ name: "Out Of Area", email, address: "1 Yonge St", ...OUTSIDE });
    expect(res.status).toBe(422);

    expect((await usersFor(email)).length).toBe(0);
    expect((await db.select().from(schema.user)).length).toBe(beforeUsers);
    expect((await db.select().from(schema.memberships)).length).toBe(beforeMems);
  });

  it("an in-area submit still creates the client record", async () => {
    const email = `inside-${crypto.randomUUID().slice(0, 8)}@t.test`;
    const res = await submit({ name: "In Area", email, address: "1 Portage Ave", ...INSIDE });
    expect(res.status).toBe(201);
    expect((await usersFor(email)).length).toBe(1);
  });
});

describe("public intake — email format", () => {
  it("rejects a malformed email with 400 instead of storing it", async () => {
    const res = await submit({ name: "Bad Email", email: "notanemail", address: "1 Portage Ave", ...INSIDE });
    expect(res.status).toBe(400);
    expect(String(((await res.json()) as any).message).toLowerCase()).toContain("email");
    expect((await usersFor("notanemail")).length).toBe(0);
  });

  it("rejects an email with a header-injection newline", async () => {
    // Goes straight into Reply-To.
    const res = await submit({
      name: "Injector",
      email: "a@b.test\nBcc: victim@x.test",
      address: "1 Portage Ave",
      ...INSIDE,
    });
    expect(res.status).toBe(400);
  });

  it("still accepts a submission with no email at all (phone-only lead)", async () => {
    const res = await submit({ name: "No Email", phone: "204-555-0100", address: "1 Portage Ave", ...INSIDE });
    expect(res.status).toBe(201);
  });

  it("accepts a normal address, case-insensitively", async () => {
    const email = `MiXeD-${crypto.randomUUID().slice(0, 8)}@T.TEST`;
    const res = await submit({ name: "Mixed Case", email, address: "1 Portage Ave", ...INSIDE });
    expect(res.status).toBe(201);
    expect((await usersFor(email.toLowerCase())).length).toBe(1);
  });
});

describe("public intake — oversized photo", () => {
  it("reports a too-large photo with 413 instead of silently dropping it", async () => {
    const big = new Blob([new Uint8Array(15 * 1024 * 1024 + 1024)], { type: "image/jpeg" });
    const email = `bigphoto-${crypto.randomUUID().slice(0, 8)}@t.test`;
    const res = await submitForm([
      ["name", "Big Photo"],
      ["email", email],
      ["address", "1 Portage Ave"],
      ["lat", String(INSIDE.lat)],
      ["lng", String(INSIDE.lng)],
      ["photo", new File([big], "huge.jpg", { type: "image/jpeg" })],
    ]);
    expect(res.status).toBe(413);
    expect(String(((await res.json()) as any).message)).toMatch(/15 ?MB/i);
    // and nothing was written for it
    expect((await usersFor(email)).length).toBe(0);
  });
});
