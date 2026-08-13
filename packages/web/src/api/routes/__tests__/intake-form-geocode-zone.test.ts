/**
 * Regression guard: a HAND-TYPED address on the public intake form used to
 * bypass service-zone enforcement entirely.
 *
 * The submit route only enforced zones when the browser sent lat/lng, which it
 * only does when the visitor picks a suggestion from the address autocomplete.
 * Type the address by hand (or paste it, or use a browser that blocks the
 * autocomplete request) and:
 *   1. checkServiceZone() was never called — an out-of-area lead landed as a
 *      "pending" booking, notified dispatch, and emailed the form recipient.
 *   2. bookings.lat/lng fell back to their column DEFAULT (43.6532, -79.3832,
 *      downtown Toronto), so every such job pinned on the same wrong spot on
 *      the dispatch map regardless of where the customer actually was.
 *
 * The route now geocodes a coordinate-less address server-side (same
 * forwardGeocode() the two other booking-create paths already use), enforces
 * against the result, and persists the resolved point. A geocoder that fails or can't resolve the address must
 * NOT lose the lead: it lands, flagged `zoneStatus: "unverified"` in fieldData
 * so the office knows the address was never checked.
 *
 * Harness: ephemeral in-memory libsql, DDL derived from drizzle, ids prefixed
 * "intakegeo-". The geocoder is mocked — no network.
 */
import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";
import { Hono } from "hono";
import { getTableConfig, type SQLiteColumn } from "drizzle-orm/sqlite-core";

process.env.DATABASE_URL = ":memory:";
process.env.DATABASE_AUTH_TOKEN = "";

// Mocked BEFORE public-forms is imported, so the route binds to the stub.
let geoResult: { lat: number; lng: number } | null = null;
let geoCalls: string[] = [];
mock.module("../../../services/geocode", () => ({
  forwardGeocode: async (address: string) => {
    geoCalls.push(address);
    return geoResult ? { ...geoResult, address, provider: "osm" as const } : null;
  },
}));

const { db } = await import("../../database/index");
const schema = await import("../../database/schema");
const { publicFormsRoutes } = await import("../public-forms");
const { hashApiKey } = await import("../../middleware/auth");
const { AppError } = await import("../../lib/errors");

const CO = "intakegeo-company"; // has an active zone -> enforcement on
const OPEN_CO = "intakegeo-open-company"; // no zones at all -> enforcement off
const SLUG = "get-a-quote";
const PUB_KEY = "nvcpub_intakegeotestkey00000000000";
const OPEN_KEY = "nvcpub_intakegeoopenkey00000000000";

const INSIDE = { lat: 49.895, lng: -97.138 }; // downtown Winnipeg
const OUTSIDE = { lat: 51.0447, lng: -114.0719 }; // Calgary
const TORONTO_DEFAULT = { lat: 43.6532, lng: -79.3832 };
const ZONE_POLY: [number, number][] = [
  [49.87, -97.2],
  [49.92, -97.2],
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

  for (const [co, key] of [[CO, PUB_KEY], [OPEN_CO, OPEN_KEY]] as const) {
    await sql.execute({
      sql: "INSERT OR IGNORE INTO api_keys (id, company_id, hashed_key, key_type, public_key) VALUES (?,?,?,?,?)",
      args: [`intakegeo-key-${co}`, co, await hashApiKey(key), "public", key],
    });
    await sql.execute({
      sql: "INSERT OR IGNORE INTO services (id, company_id, name, category, base_price, active) VALUES (?,?,?,?,?,?)",
      args: [`intakegeo-svc-${co}`, co, "Intake service", "hvac", 100, 1],
    });
    await sql.execute({
      sql: "INSERT OR IGNORE INTO intake_forms (id, company_id, slug, title, active, default_service_id) VALUES (?,?,?,?,?,?)",
      args: [`intakegeo-form-${co}`, co, SLUG, "Request Service", 1, `intakegeo-svc-${co}`],
    });
  }

  await sql.execute({
    sql: "INSERT OR IGNORE INTO service_zones (id, company_id, name, polygon, active) VALUES (?,?,?,?,?)",
    args: ["intakegeo-zone", CO, "Winnipeg", JSON.stringify(ZONE_POLY), 1],
  });
});

beforeEach(() => {
  geoCalls = [];
  geoResult = null;
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
      "X-Forwarded-For": `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
    },
    body: JSON.stringify({ name: "Geo Lead", email: `geo-${crypto.randomUUID().slice(0, 8)}@t.test`, ...body }),
  });
}

async function newestBooking(companyId: string) {
  const rows = await db.select().from(schema.bookings);
  return rows.filter((b) => b.companyId === companyId).at(-1);
}

describe("public intake — hand-typed address is geocoded, then zone-enforced", () => {
  it("REFUSES a hand-typed out-of-area address with 422 and writes nothing", async () => {
    geoResult = OUTSIDE;
    const before = (await db.select().from(schema.bookings)).length;
    const beforeSubs = (await db.select().from(schema.intakeSubmissions)).length;

    const res = await submit({ address: "500 Centre St S, Calgary AB" });

    expect(res.status).toBe(422);
    expect(geoCalls).toEqual(["500 Centre St S, Calgary AB"]);
    expect((await db.select().from(schema.bookings)).length).toBe(before);
    expect((await db.select().from(schema.intakeSubmissions)).length).toBe(beforeSubs);
  });

  it("accepts a hand-typed in-area address and persists the RESOLVED coordinates", async () => {
    geoResult = INSIDE;

    const res = await submit({ address: "1 Portage Ave, Winnipeg MB" });

    expect(res.status).toBe(201);
    const b = await newestBooking(CO);
    expect(b?.lat).toBeCloseTo(INSIDE.lat, 4);
    expect(b?.lng).toBeCloseTo(INSIDE.lng, 4);
    // The old behaviour: the column default pinned every intake lead here.
    expect(b?.lat).not.toBeCloseTo(TORONTO_DEFAULT.lat, 2);
  });

  it("keeps the lead when the geocoder can't resolve the address, flagged unverified", async () => {
    geoResult = null;

    const res = await submit({ address: "behind the blue house past the barn" });

    expect(res.status).toBe(201);
    const b = await newestBooking(CO);
    expect(JSON.parse(b?.fieldData || "{}").zoneStatus).toBe("unverified");
  });

  it("does not geocode when the browser already sent coordinates", async () => {
    geoResult = OUTSIDE; // would refuse if it were consulted
    const res = await submit({ address: "1 Portage Ave", ...INSIDE });
    expect(res.status).toBe(201);
    expect(geoCalls).toEqual([]);
  });

  it("resolves coordinates even for a tenant with no zones — the map pin must be real", async () => {
    // Enforcement is off for this tenant (no zones drawn), but the lat/lng
    // column default still put the job in downtown Toronto.
    geoResult = OUTSIDE;
    const res = await submit({ address: "500 Centre St S, Calgary AB" }, { company: OPEN_CO, key: OPEN_KEY });
    expect(res.status).toBe(201);
    expect(geoCalls).toEqual(["500 Centre St S, Calgary AB"]);
    const b = await newestBooking(OPEN_CO);
    expect(b?.lat).toBeCloseTo(OUTSIDE.lat, 4);
    expect(b?.lng).toBeCloseTo(OUTSIDE.lng, 4);
  });
});
