/**
 * Regression guard: service zones must be enforced on the CUSTOMER booking
 * path, not just the admin one.
 *
 * What was broken: POST /api/bookings (the customer "Confirm booking" button)
 * had no zone check at all. The admin work-order route had one inline. So a
 * tenant that had drawn and activated service zones still accepted a customer
 * booking for an address thousands of km outside every zone — status
 * "confirmed", invoice created, dispatch notification fired — and the office
 * only found out when someone looked at the job.
 *
 * Also guarded here: a create with NO coordinates must not be silently recorded
 * at the schema default (43.6532,-79.3832 — downtown Toronto), which is both a
 * fake location on the fleet map and a free pass through the zone check.
 *
 * Both paths now call checkServiceZone() from services/zones.ts.
 *
 * Harness: ephemeral in-memory libsql, DDL derived from drizzle, disjoint ids
 * (Bun shares one ":memory:" store across test files in one process). No
 * network: every case supplies coordinates, so forwardGeocode() is never hit.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import { ensureSchema } from "../../database/__tests__/setup";

await ensureSchema();

const { db } = await import("../../database/index");
const schema = await import("../../database/schema");
const { bookingsRoutes } = await import("../bookings");
const { checkServiceZone } = await import("../../../services/zones");
const { AppError } = await import("../../lib/errors");

const Z = "zonetest-company";
const CUST = "zonetest-customer";

// A small square around downtown Winnipeg — the only ACTIVE zone.
const INSIDE = { lat: 49.895, lng: -97.138 };
const OUTSIDE = { lat: 43.6532, lng: -79.3832 }; // Toronto = the old default
const ZONE_POLY: [number, number][] = [
  [49.87, -97.20],
  [49.92, -97.20],
  [49.92, -97.08],
  [49.87, -97.08],
];

const app = new Hono().use("*", async (c, next) => {
  c.set("companyId", c.req.header("X-Test-Company") || "default");
  const uid = c.req.header("X-Test-User");
  const role = c.req.header("X-Test-Role") || "customer";
  c.set("user", uid ? { id: uid, role, email: `${uid}@t.test`, name: uid } : null);
  return next();
});
app.route("/bookings", bookingsRoutes);
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.expose ? err.message : "error" } }, err.status as 400);
  }
  return c.json({ error: { code: "internal", message: String((err as Error).message) } }, 500);
});

beforeAll(async () => {
  const sql = (db as any).$client;

  await sql.query(
    "INSERT INTO company_settings (id, company_id, default_region) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
    ["zonetest-settings", Z, "MB"],
  );
  await sql.query(
    "INSERT INTO services (id, company_id, name, category, base_price) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    ["svc-z", Z, "Zone service", "hvac", 100],
  );
  await sql.query(
    `INSERT INTO "user" (id, name, email, email_verified, company_id, role) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [CUST, "Zone Customer", "zonecust@t.test", false, Z, "customer"],
  );
  // One ACTIVE zone, plus an INACTIVE one that must not grant access.
  await sql.query(
    "INSERT INTO service_zones (id, company_id, name, polygon, active) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    ["zone-active", Z, "Winnipeg", JSON.stringify(ZONE_POLY), true],
  );
  await sql.query(
    "INSERT INTO service_zones (id, company_id, name, polygon, active) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    ["zone-off", Z, "Toronto (off)", JSON.stringify([
      [43.60, -79.45], [43.75, -79.45], [43.75, -79.30], [43.60, -79.30],
    ]), false],
  );
});

function createAsCustomer(coords: { lat: number; lng: number } | null, address = "1 Test St") {
  return app.request("/bookings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Test-Company": Z,
      "X-Test-User": CUST,
      "X-Test-Role": "customer",
    },
    body: JSON.stringify({
      serviceId: "svc-z",
      scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
      address,
      ...coords,
    }),
  });
}

describe("checkServiceZone", () => {
  it("allows a point inside an active zone", async () => {
    expect(await checkServiceZone(Z, INSIDE.lat, INSIDE.lng)).toEqual({ ok: true, enforced: true });
  });

  it("refuses a point outside every active zone", async () => {
    expect(await checkServiceZone(Z, OUTSIDE.lat, OUTSIDE.lng)).toEqual({ ok: false, enforced: true });
  });

  it("an INACTIVE zone does not grant access", async () => {
    // OUTSIDE sits inside the deactivated Toronto zone — still refused.
    const r = await checkServiceZone(Z, 43.70, -79.40);
    expect(r.ok).toBe(false);
  });

  it("a tenant with no zones at all is unrestricted (not opted in)", async () => {
    const r = await checkServiceZone("zonetest-company-with-no-zones", OUTSIDE.lat, OUTSIDE.lng);
    expect(r).toEqual({ ok: true, enforced: false });
  });
});

describe("POST /bookings (customer) — zone enforcement", () => {
  it("accepts a booking inside the service area", async () => {
    const res = await createAsCustomer(INSIDE);
    expect(res.status).toBe(201);
    const j = (await res.json()) as any;
    // and it stores the REAL coordinates, not the Toronto default
    expect(j.booking.lat).toBeCloseTo(INSIDE.lat, 4);
    expect(j.booking.lng).toBeCloseTo(INSIDE.lng, 4);
  });

  it("REFUSES a booking outside the service area with 422", async () => {
    const res = await createAsCustomer(OUTSIDE);
    expect(res.status).toBe(422);
    const j = (await res.json()) as any;
    expect(String(j.message)).toContain("service area");
  });

  it("refusing means nothing was written — no booking, no invoice", async () => {
    const before = await db.select().from(schema.bookings);
    const beforeInv = await db.select().from(schema.invoices);
    await createAsCustomer({ lat: 51.0447, lng: -114.0719 }); // Calgary, far outside
    const after = await db.select().from(schema.bookings);
    const afterInv = await db.select().from(schema.invoices);
    expect(after.length).toBe(before.length);
    expect(afterInv.length).toBe(beforeInv.length);
  });
});
