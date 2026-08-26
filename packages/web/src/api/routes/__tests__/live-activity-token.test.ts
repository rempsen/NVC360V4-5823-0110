/**
 * iOS Live Activity push-token registration, end to end at the API layer.
 *
 * Why this file exists: the route used to read and write `bookings.customFields`
 * — a column that DOES NOT EXIST on the bookings table. Drizzle silently wrote
 * nothing, so every driver's Dynamic Island / lock-screen token was thrown away
 * and `pushLiveActivityJobUpdate` could never find one. The endpoint returned
 * `{ ok: true }` the whole time. The bug was invisible because the file was full
 * of pre-existing type errors nobody could read.
 *
 * The real store is `bookings.field_data`, a JSON *text* column shared with the
 * work-order template fields, so these tests also lock down that registering a
 * token cannot clobber the template data living next to it.
 *
 * Harness: ephemeral in-memory libsql, ids prefixed "lat-".
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { ensureSchema } from "../../database/__tests__/setup";

process.env.RESEND_API_KEY = "";
process.env.TWILIO_AUTH_TOKEN = "";

await ensureSchema();

const { db } = await import("../../database/index");
const { trackingRoutes } = await import("../tracking");
const { readLiveActivityTokens } = await import("../../../services/apns");

const CO = "lat-co";
const BOOKING = "lat-booking";
const RIDER_USER = "lat-rider-user";

const app = new Hono().use("*", async (c, next) => {
  c.set("companyId", c.req.header("X-Test-Company") || CO);
  const uid = c.req.header("X-Test-User") || RIDER_USER;
  c.set("user", { id: uid, role: c.req.header("X-Test-Role") || "rider", email: `${uid}@t.test`, name: uid });
  return next();
});
app.route("/track", trackingRoutes);

const sqlClient = () => (db as any).$client;

beforeAll(async () => {
  const s = sqlClient();
  await s.query(
    'INSERT INTO "user" (id, company_id, name, email, role, email_verified) VALUES ($1,$2,$3,$4,$5,false) ON CONFLICT DO NOTHING',
    ["lat-cust", CO, "Live Activity Customer", "lat-cust@t.test", "customer"],
  );
  await s.query(
    "INSERT INTO services (id, company_id, name, category, base_price) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    ["lat-svc", CO, "Live activity service", "hvac", 100],
  );
});

async function seedBooking(fieldData: string) {
  const s = sqlClient();
  await s.query("DELETE FROM bookings WHERE id = $1", [BOOKING]);
  await s.query(
    `INSERT INTO bookings (id, company_id, customer_id, service_id, address, status, field_data, scheduled_at, public_token)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [BOOKING, CO, "lat-cust", "lat-svc", "1 Test St", "enroute", fieldData, new Date(), `${BOOKING}-tok`],
  );
}

async function readFieldData(): Promise<string> {
  const r = await sqlClient().query(
    "SELECT field_data FROM bookings WHERE id = $1",
    [BOOKING],
  );
  return String(r.rows[0].field_data);
}

function register(type: "start" | "update", token: string) {
  return app.request(`/track/${BOOKING}/live-activity-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, type }),
  });
}

beforeEach(async () => {
  await seedBooking("{}");
});

describe("POST /track/:bookingId/live-activity-token", () => {
  it("persists an update token to field_data (the column that actually exists)", async () => {
    const res = await register("update", "tok-update-1");
    expect(res.status).toBe(200);
    expect(JSON.parse(await readFieldData()).__la_push_update_token).toBe("tok-update-1");
  });

  it("persists a start token under its own key", async () => {
    await register("start", "tok-start-1");
    expect(JSON.parse(await readFieldData()).__la_push_start_token).toBe("tok-start-1");
  });

  it("keeps both tokens when start and update are registered in turn", async () => {
    await register("start", "tok-start-2");
    await register("update", "tok-update-2");
    const fd = JSON.parse(await readFieldData());
    expect(fd.__la_push_start_token).toBe("tok-start-2");
    expect(fd.__la_push_update_token).toBe("tok-update-2");
  });

  it("never clobbers the work-order template data sharing field_data", async () => {
    await seedBooking(JSON.stringify({ _customFields: [{ key: "gate_code", value: "1234" }] }));
    await register("update", "tok-update-3");
    const fd = JSON.parse(await readFieldData());
    expect(fd._customFields).toEqual([{ key: "gate_code", value: "1234" }]);
    expect(fd.__la_push_update_token).toBe("tok-update-3");
  });

  it("survives a corrupt field_data blob instead of 500ing", async () => {
    await seedBooking("not json at all");
    const res = await register("update", "tok-update-4");
    expect(res.status).toBe(200);
    expect(JSON.parse(await readFieldData()).__la_push_update_token).toBe("tok-update-4");
  });

  it("rejects a missing token", async () => {
    const res = await register("update", "");
    expect(res.status).toBe(400);
  });

  it("404s for an unknown booking", async () => {
    const res = await app.request("/track/lat-nope/live-activity-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "t", type: "update" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("readLiveActivityTokens", () => {
  it("reads the token a real registration wrote — the round trip the push path needs", async () => {
    await register("update", "tok-roundtrip");
    expect(readLiveActivityTokens(await readFieldData()).update).toBe("tok-roundtrip");
  });

  it("returns nothing for empty, corrupt or token-less field_data", () => {
    expect(readLiveActivityTokens(null).update).toBeUndefined();
    expect(readLiveActivityTokens("").update).toBeUndefined();
    expect(readLiveActivityTokens("{oops").update).toBeUndefined();
    expect(readLiveActivityTokens('{"_customFields":[]}').update).toBeUndefined();
  });
});
