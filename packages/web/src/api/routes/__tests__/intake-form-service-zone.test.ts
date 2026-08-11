/**
 * Regression guard: the PUBLIC intake form is the third booking-create path,
 * and it carried its own inline copy of the zone check.
 *
 * Two problems with a private copy:
 *   1. It drifts. The shared implementation was fixed (inPoly() mixed lat/lng
 *      frames, so every point tested outside every zone) — a private copy would
 *      have kept its own version of that decision.
 *   2. Its gate was `subLat && subLng`, i.e. truthiness. Latitude 0 and
 *      longitude 0 are real coordinates, so a submission on the equator or the
 *      prime meridian skipped zone enforcement entirely.
 *
 * Both intake paths now call checkServiceZone() from services/zones.ts and gate
 * on Number.isFinite.
 *
 * Harness: ephemeral in-memory libsql, DDL derived from drizzle, ids prefixed
 * "intakezone-" (Bun shares one ":memory:" store across test files in one
 * process). No network: every case supplies coordinates, so the geocoder is
 * never hit, and there are no provider credentials under `bun test`, so a
 * created lead cannot actually notify anyone.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import { getTableConfig, type SQLiteColumn } from "drizzle-orm/sqlite-core";

process.env.DATABASE_URL = ":memory:";
process.env.DATABASE_AUTH_TOKEN = "";

const { db } = await import("../../database/index");
const schema = await import("../../database/schema");
const { publicFormsRoutes } = await import("../public-forms");
const { hashApiKey } = await import("../../middleware/auth");
const { AppError } = await import("../../lib/errors");

const CO = "intakezone-company";
const EQ_CO = "intakezone-equator-company";
const SLUG = "get-a-quote";
const PUB_KEY = "nvcpub_intakezonetestkey0000000000";

// A small square around downtown Winnipeg — the only ACTIVE zone for CO.
const INSIDE = { lat: 49.895, lng: -97.138 };
const OUTSIDE = { lat: 43.6532, lng: -79.3832 };
const ZONE_POLY: [number, number][] = [
  [49.87, -97.20],
  [49.92, -97.20],
  [49.92, -97.08],
  [49.87, -97.08],
];

// A zone that does NOT contain (0,0): the old truthiness gate skipped the check
// for lat/lng 0, so this submission used to be accepted.
const EQ_ZONE_POLY: [number, number][] = [
  [1, 1],
  [2, 1],
  [2, 2],
  [1, 2],
];

const app = new Hono();
app.route("/public/forms", publicFormsRoutes);
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.expose ? err.message : "error" } }, err.status as 400);
  }
  return c.json({ error: { code: "internal", message: String((err as Error).message) } }, 500);
});

function ddlFor(table: any): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((col: SQLiteColumn) => {
    const parts = [`"${col.name}"`, col.getSQLType()];
    if (col.primary) parts.push("PRIMARY KEY");
    const dflt = (col as any).default;
    let lit: string | null = null;
    if (dflt !== undefined) {
      lit =
        typeof dflt === "string" ? `'${dflt.replace(/'/g, "''")}'`
        : typeof dflt === "boolean" ? (dflt ? "1" : "0")
        : typeof dflt === "number" ? String(dflt)
        : null;
    }
    if (col.notNull && (lit !== null || col.primary)) parts.push("NOT NULL");
    if (lit !== null) parts.push(`DEFAULT ${lit}`);
    return parts.join(" ");
  });
  return `CREATE TABLE IF NOT EXISTS "${cfg.name}" (${cols.join(", ")})`;
}

beforeAll(async () => {
  const sql = (db as any).$client;
  for (const t of [
    schema.companySettings, schema.bookings, schema.services, schema.invoices,
    schema.serviceZones, schema.user, schema.memberships, schema.apiKeys,
    schema.intakeForms, schema.intakeSubmissions, schema.jobEvents,
    schema.notificationRules, schema.notificationChannels,
    schema.notificationDeliveries, schema.notifications, schema.automationRules,
  ]) {
    await sql.execute(ddlFor(t));
  }

  await sql.execute({
    sql: "INSERT OR IGNORE INTO api_keys (id, company_id, hashed_key, key_type, public_key) VALUES (?,?,?,?,?)",
    args: ["intakezone-key", CO, await hashApiKey(PUB_KEY), "public", PUB_KEY],
  });
  await sql.execute({
    sql: "INSERT OR IGNORE INTO api_keys (id, company_id, hashed_key, key_type, public_key) VALUES (?,?,?,?,?)",
    args: ["intakezone-key-eq", EQ_CO, await hashApiKey(PUB_KEY + "eq"), "public", PUB_KEY + "eq"],
  });

  for (const [co, svc] of [[CO, "intakezone-svc"], [EQ_CO, "intakezone-svc-eq"]] as const) {
    await sql.execute({
      sql: "INSERT OR IGNORE INTO services (id, company_id, name, category, base_price, active) VALUES (?,?,?,?,?,?)",
      args: [svc, co, "Intake service", "hvac", 100, 1],
    });
    await sql.execute({
      sql: "INSERT OR IGNORE INTO intake_forms (id, company_id, slug, title, active, default_service_id) VALUES (?,?,?,?,?,?)",
      args: [`intakezone-form-${co}`, co, SLUG, "Request Service", 1, svc],
    });
  }

  await sql.execute({
    sql: "INSERT OR IGNORE INTO service_zones (id, company_id, name, polygon, active) VALUES (?,?,?,?,?)",
    args: ["intakezone-zone", CO, "Winnipeg", JSON.stringify(ZONE_POLY), 1],
  });
  await sql.execute({
    sql: "INSERT OR IGNORE INTO service_zones (id, company_id, name, polygon, active) VALUES (?,?,?,?,?)",
    args: ["intakezone-zone-eq", EQ_CO, "Off the equator", JSON.stringify(EQ_ZONE_POLY), 1],
  });
});

function submit(
  body: Record<string, unknown>,
  { company = CO, key = PUB_KEY }: { company?: string; key?: string } = {},
) {
  return app.request(`/public/forms/${company}/${SLUG}/submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Public-Key": key,
      "X-Forwarded-For": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
    },
    body: JSON.stringify({ name: "Zone Lead", email: `lead-${crypto.randomUUID().slice(0, 8)}@t.test`, ...body }),
  });
}

describe("POST /public/forms/:companyId/:slug/submit — zone enforcement", () => {
  it("accepts a submission inside the service area", async () => {
    const res = await submit({ address: "1 Portage Ave", ...INSIDE });
    expect(res.status).toBe(201);
  });

  it("REFUSES a submission outside every active zone with 422", async () => {
    const res = await submit({ address: "1 Yonge St", ...OUTSIDE });
    expect(res.status).toBe(422);
    expect(String(((await res.json()) as any).message)).toContain("service area");
  });

  it("a refusal writes nothing — no booking, no submission row", async () => {
    const before = await db.select().from(schema.bookings);
    const beforeSubs = await db.select().from(schema.intakeSubmissions);
    await submit({ address: "Calgary", lat: 51.0447, lng: -114.0719 });
    expect((await db.select().from(schema.bookings)).length).toBe(before.length);
    expect((await db.select().from(schema.intakeSubmissions)).length).toBe(beforeSubs.length);
  });

  it("lat/lng 0 is a real coordinate, not 'no coordinates' — it is enforced", async () => {
    // Old gate: `subLat && subLng` — 0 is falsy, so this skipped the check and
    // was accepted despite falling outside the tenant's only active zone.
    const res = await submit({ address: "Null Island", lat: 0, lng: 0 }, { company: EQ_CO, key: PUB_KEY + "eq" });
    expect(res.status).toBe(422);
  });

  it("still accepts a submission with no coordinates at all", async () => {
    // The form can't always geocode; enforcement needs a point, so a
    // coordinate-less lead must still land rather than being rejected.
    const res = await submit({ address: "Address only, no geocode" });
    expect(res.status).toBe(201);
  });
});
