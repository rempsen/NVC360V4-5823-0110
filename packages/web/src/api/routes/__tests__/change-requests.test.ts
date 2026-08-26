/**
 * Customer-initiated appointment changes, end to end at the API layer.
 *
 * The two rules this file exists to lock down — both of them are money/trust
 * decisions, not UI details:
 *
 *  1. A CUSTOMER CAN NEVER CANCEL A JOB. POST /:id/cancel used to let the
 *     customer whose booking it was flip status to "cancelled" directly: a job
 *     vanished off the dispatch board with nobody at the company deciding it
 *     should and no reason recorded. Now a customer gets 409 and a pointer at
 *     /:id/cancel-request, and only an office approval actually cancels.
 *
 *  2. RESCHEDULE IS SELF-SERVE ONLY OUTSIDE THE TENANT'S CUTOFF. Inside the
 *     cutoff (default 12h) the day is likely already routed, so it becomes a
 *     pending request and the appointment does NOT move.
 *
 * Plus the things that bite in production: duplicate open requests, two
 * dispatchers approving at once, a tech already on the road, tenant isolation on
 * the office queue, and the notification rules for the new events actually
 * existing (a tenant provisioned before this feature would otherwise notify
 * nobody).
 *
 * Harness: ephemeral in-memory libsql, ids prefixed "chg-". Rules for the three
 * new events are seeded DISABLED for the fixture companies, so fireEvent
 * resolves zero recipients and nothing is ever sent from a test.
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { ensureSchema } from "../../database/__tests__/setup";

// belt and braces: no provider keys => no real email/SMS even if a rule slipped through
process.env.RESEND_API_KEY = "";
process.env.TWILIO_AUTH_TOKEN = "";

await ensureSchema();

const { db } = await import("../../database/index");
const schema = await import("../../database/schema");
const { bookingsRoutes } = await import("../bookings");
const { changeRequestsRoutes } = await import("../change-requests");
const { ensureEventRules } = await import("../../../services/dispatch");
const { AppError } = await import("../../lib/errors");
const { eq, and } = await import("drizzle-orm");

const CO = "chg-co";
const CO2 = "chg-co2";
const CO3 = "chg-co3-fresh"; // no notification rules at all — for the backfill test
const CUST = "chg-cust";
const CUST_OTHER = "chg-cust-other";
const ADMIN = "chg-admin";
const ADMIN2 = "chg-admin2";
const TECH_USER = "chg-tech-user";
const RIDER = "chg-rider";
const SVC = "chg-svc";

const HOUR = 3_600_000;
const NEW_EVENTS = ["change_requested", "change_declined", "rescheduled"] as const;

const app = new Hono().use("*", async (c, next) => {
  c.set("companyId", c.req.header("X-Test-Company") || CO);
  const uid = c.req.header("X-Test-User");
  const role = c.req.header("X-Test-Role") || "customer";
  c.set("user", uid ? { id: uid, role, email: `${uid}@example.test`, name: uid } : null);
  return next();
});
app.route("/bookings", bookingsRoutes);
app.route("/change-requests", changeRequestsRoutes);
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.expose ? err.message : "error" } }, err.status as 400);
  }
  return c.json({ error: { code: "internal", message: String((err as Error).message) } }, 500);
});

const sqlClient = () => (db as any).$client;

async function setPolicy(
  companyId: string,
  p: { reschedule?: boolean; cancel?: boolean; cutoffHours?: number },
) {
  const s = sqlClient();
  await s.query("DELETE FROM company_settings WHERE company_id = $1", [companyId]);
  await s.query(
    `INSERT INTO company_settings
            (id, company_id, allow_customer_reschedule, allow_customer_cancel_request, customer_change_cutoff_hours)
          VALUES ($1,$2,$3,$4,$5)`,
    [
      `cs-${companyId}`,
      companyId,
      p.reschedule !== false,
      p.cancel !== false,
      p.cutoffHours ?? 12,
    ],
  );
}

/** A booking on the calendar `hoursOut` hours from now. */
async function seedBooking(opts: {
  id: string;
  hoursOut?: number;
  status?: string;
  companyId?: string;
  customerId?: string;
  riderId?: string | null;
  scheduledAt?: number | null;
}) {
  const s = sqlClient();
  const co = opts.companyId ?? CO;
  await s.query("DELETE FROM bookings WHERE id = $1", [opts.id]);
  await s.query("DELETE FROM booking_change_requests WHERE booking_id = $1", [opts.id]);
  const schedMs =
    opts.scheduledAt === null
      ? null
      : (opts.scheduledAt ?? Date.now() + (opts.hoursOut ?? 48) * HOUR);
  const sched = schedMs === null ? null : new Date(schedMs);
  await s.query(
    `INSERT INTO bookings
            (id, company_id, customer_id, service_id, title, status, assign_status, scheduled_at,
             address, rider_id, price, public_token)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      opts.id, co, opts.customerId ?? CUST, SVC, "Furnace repair",
      opts.status ?? "confirmed", "accepted", sched, "1 Test St",
      opts.riderId === undefined ? RIDER : opts.riderId, 250, `chgtok-${opts.id}`,
    ],
  );
}

async function bookingRow(id: string) {
  const r = await sqlClient().query("SELECT * FROM bookings WHERE id = $1", [id]);
  return r.rows[0] as any;
}

async function requestRows(bookingId: string) {
  const r = await sqlClient().query(
    "SELECT * FROM booking_change_requests WHERE booking_id = $1 ORDER BY created_at",
    [bookingId],
  );
  return r.rows as any[];
}

type Who = { user: string; role?: string; company?: string };

function call(path: string, who: Who, init: { method?: string; body?: unknown } = {}) {
  return app.request(path, {
    method: init.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Test-Company": who.company ?? CO,
      "X-Test-User": who.user,
      "X-Test-Role": who.role ?? "customer",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const asCustomer: Who = { user: CUST, role: "customer" };
const asAdmin: Who = { user: ADMIN, role: "admin" };

beforeAll(async () => {
  const s = sqlClient();
  for (const [id, name, role, co] of [
    [CUST, "Customer One", "customer", CO],
    [CUST_OTHER, "Customer Two", "customer", CO],
    [ADMIN, "Office", "admin", CO],
    [ADMIN2, "Office Two", "admin", CO2],
    [TECH_USER, "Tech", "rider", CO],
  ] as const) {
    await s.query(
      `INSERT INTO "user" (id, company_id, name, email, role, email_verified) VALUES ($1,$2,$3,$4,$5,false) ON CONFLICT DO NOTHING`,
      [id, co, name, `${id}@example.test`, role],
    );
  }
  await s.query(
    "INSERT INTO riders (id, company_id, user_id, status) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    [RIDER, CO, TECH_USER, "online"],
  );
  await s.query(
    "INSERT INTO services (id, company_id, name, category, base_price) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [SVC, CO, "Furnace repair", "hvac", 250],
  );
  // Disabled rules for the new events on the fixture tenants: ensureEventRules
  // sees "a rule exists" and leaves them alone, so no test ever sends anything.
  for (const co of [CO, CO2]) {
    for (const event of NEW_EVENTS) {
      await db.insert(schema.notificationRules).values({
        companyId: co, event, recipient: "office",
        inApp: false, email: false, sms: false, webhook: false, enabled: false,
      });
    }
  }
});

beforeEach(async () => {
  await setPolicy(CO, {});
  await setPolicy(CO2, {});
});

// ---------------------------------------------------------------------------
// what the customer is allowed to do
// ---------------------------------------------------------------------------

describe("GET /bookings/:id/change-policy", () => {
  it("offers self-serve reschedule outside the cutoff, and cancel only as a request", async () => {
    await seedBooking({ id: "chg-b-policy-far", hoursOut: 48 });
    const res = await call("/bookings/chg-b-policy-far/change-policy", asCustomer);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reschedule).toBe("self_serve");
    expect(body.cancel).toBe("request"); // never self_serve, by design
    expect(body.withinCutoff).toBe(false);
    expect(body.cutoffHours).toBe(12);
    expect(body.openRequest).toBeNull();
  });

  it("downgrades reschedule to a request inside the cutoff", async () => {
    await seedBooking({ id: "chg-b-policy-near", hoursOut: 2 });
    const body = await (await call("/bookings/chg-b-policy-near/change-policy", asCustomer)).json();
    expect(body.reschedule).toBe("request");
    expect(body.withinCutoff).toBe(true);
  });

  it("blocks both once the tech is on the road, with copy safe to show a customer", async () => {
    await seedBooking({ id: "chg-b-policy-enroute", hoursOut: 48, status: "enroute" });
    const body = await (await call("/bookings/chg-b-policy-enroute/change-policy", asCustomer)).json();
    expect(body.reschedule).toBe("blocked");
    expect(body.cancel).toBe("blocked");
    expect(body.blockedReason).toContain("on the way");
  });

  it("honours the tenant's toggles", async () => {
    await setPolicy(CO, { reschedule: false, cancel: false });
    await seedBooking({ id: "chg-b-policy-off", hoursOut: 48 });
    const body = await (await call("/bookings/chg-b-policy-off/change-policy", asCustomer)).json();
    expect(body.reschedule).toBe("blocked");
    expect(body.cancel).toBe("blocked");
  });

  it("refuses to leak another customer's appointment", async () => {
    await seedBooking({ id: "chg-b-policy-other", hoursOut: 48 });
    const res = await call("/bookings/chg-b-policy-other/change-policy", {
      user: CUST_OTHER, role: "customer",
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// the hole this feature closes
// ---------------------------------------------------------------------------

describe("POST /bookings/:id/cancel — customers can't kill a job any more", () => {
  it("rejects the booking's own customer with 409 and points at the request endpoint", async () => {
    await seedBooking({ id: "chg-b-hardcancel", hoursOut: 48 });
    const res = await call("/bookings/chg-b-hardcancel/cancel", asCustomer, { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.useEndpoint).toBe("/api/bookings/chg-b-hardcancel/cancel-request");
    expect((await bookingRow("chg-b-hardcancel")).status).toBe("confirmed");
  });

  it("still lets the office cancel directly", async () => {
    await seedBooking({ id: "chg-b-officecancel", hoursOut: 48 });
    const res = await call("/bookings/chg-b-officecancel/cancel", asAdmin, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await bookingRow("chg-b-officecancel")).status).toBe("cancelled");
  });
});

describe("POST /bookings/:id/cancel-request", () => {
  it("files a pending request and leaves the job on the board untouched", async () => {
    await seedBooking({ id: "chg-b-cancelreq", hoursOut: 48 });
    const res = await call("/bookings/chg-b-cancelreq/cancel-request", asCustomer, {
      method: "POST",
      body: { reason: "Landlord is handling it" },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.mode).toBe("requested");
    const rows = await requestRows("chg-b-cancelreq");
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("cancel");
    expect(rows[0].status).toBe("pending");
    expect(rows[0].reason).toBe("Landlord is handling it");
    // the whole point: nothing left the dispatch board
    expect((await bookingRow("chg-b-cancelreq")).status).toBe("confirmed");
  });

  it("refuses a second open request on the same appointment", async () => {
    await seedBooking({ id: "chg-b-dupe", hoursOut: 48 });
    const first = await call("/bookings/chg-b-dupe/cancel-request", asCustomer, {
      method: "POST", body: { reason: "one" },
    });
    expect(first.status).toBe(201);
    const second = await call("/bookings/chg-b-dupe/cancel-request", asCustomer, {
      method: "POST", body: { reason: "two" },
    });
    expect(second.status).toBe(409);
    expect(await requestRows("chg-b-dupe")).toHaveLength(1);
  });

  it("is blocked once the tech is on site", async () => {
    await seedBooking({ id: "chg-b-onsite", hoursOut: 48, status: "in_progress" });
    const res = await call("/bookings/chg-b-onsite/cancel-request", asCustomer, {
      method: "POST", body: { reason: "changed my mind" },
    });
    expect(res.status).toBe(403);
    expect(await requestRows("chg-b-onsite")).toHaveLength(0);
  });

  it("is blocked when the tenant turned cancellation requests off", async () => {
    await setPolicy(CO, { cancel: false });
    await seedBooking({ id: "chg-b-canceloff", hoursOut: 48 });
    const res = await call("/bookings/chg-b-canceloff/cancel-request", asCustomer, {
      method: "POST", body: { reason: "nope" },
    });
    expect(res.status).toBe(403);
    expect(await requestRows("chg-b-canceloff")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// reschedule
// ---------------------------------------------------------------------------

describe("POST /bookings/:id/reschedule", () => {
  it("applies immediately outside the cutoff and records it as applied", async () => {
    await seedBooking({ id: "chg-b-self", hoursOut: 48 });
    const target = Date.now() + 72 * HOUR;
    const res = await call("/bookings/chg-b-self/reschedule", asCustomer, {
      method: "POST",
      body: { scheduledAt: new Date(target).toISOString(), reason: "Work trip" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("applied");
    expect(Number((await bookingRow("chg-b-self")).scheduled_at)).toBe(target);
    const rows = await requestRows("chg-b-self");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("applied");
    expect(Number(rows[0].proposed_at)).toBe(target);
    expect(rows[0].previous_at).toBeTruthy(); // reversible: we kept the old time
  });

  it("an applied self-serve move does not count as an open request", async () => {
    await seedBooking({ id: "chg-b-self2", hoursOut: 48 });
    await call("/bookings/chg-b-self2/reschedule", asCustomer, {
      method: "POST", body: { scheduledAt: new Date(Date.now() + 72 * HOUR).toISOString() },
    });
    const policy = await (await call("/bookings/chg-b-self2/change-policy", asCustomer)).json();
    expect(policy.openRequest).toBeNull();
    const again = await call("/bookings/chg-b-self2/reschedule", asCustomer, {
      method: "POST", body: { scheduledAt: new Date(Date.now() + 96 * HOUR).toISOString() },
    });
    expect(again.status).toBe(200);
  });

  it("inside the cutoff it becomes a pending request and the appointment does NOT move", async () => {
    await seedBooking({ id: "chg-b-near", hoursOut: 3 });
    const before = Number((await bookingRow("chg-b-near")).scheduled_at);
    const res = await call("/bookings/chg-b-near/reschedule", asCustomer, {
      method: "POST",
      body: { scheduledAt: new Date(Date.now() + 96 * HOUR).toISOString(), reason: "Sick" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe("requested");
    expect(Number((await bookingRow("chg-b-near")).scheduled_at)).toBe(before);
    const rows = await requestRows("chg-b-near");
    expect(rows[0].kind).toBe("reschedule");
    expect(rows[0].status).toBe("pending");
  });

  it("rejects a time in the past", async () => {
    await seedBooking({ id: "chg-b-past", hoursOut: 48 });
    const before = Number((await bookingRow("chg-b-past")).scheduled_at);
    const res = await call("/bookings/chg-b-past/reschedule", asCustomer, {
      method: "POST", body: { scheduledAt: new Date(Date.now() - 2 * HOUR).toISOString() },
    });
    expect(res.status).toBe(422);
    expect(Number((await bookingRow("chg-b-past")).scheduled_at)).toBe(before);
  });

  it("is blocked when the tenant turned self-serve reschedule off", async () => {
    await setPolicy(CO, { reschedule: false });
    await seedBooking({ id: "chg-b-resoff", hoursOut: 48 });
    const res = await call("/bookings/chg-b-resoff/reschedule", asCustomer, {
      method: "POST", body: { scheduledAt: new Date(Date.now() + 72 * HOUR).toISOString() },
    });
    expect(res.status).toBe(403);
    expect(await requestRows("chg-b-resoff")).toHaveLength(0);
  });

  // Postgres migration (2026-08-26): bookings.scheduledAt is a real NOT NULL
  // column with no default now — the DB itself refuses to create a booking
  // with a null appointment time, so this scenario is no longer reachable via
  // any insert path (the old SQLite test fixture only allowed it because its
  // ad-hoc DDL derivation silently dropped NOT NULL for columns without a
  // literal default). The app-level defensive check this test exercised is
  // left in place as harmless belt-and-suspenders, but the test itself can no
  // longer simulate its premise, so it's skipped rather than deleted.
  it.skip("is blocked on a booking with no appointment time rather than guessing", async () => {
    await seedBooking({ id: "chg-b-notime", scheduledAt: null });
    const res = await call("/bookings/chg-b-notime/reschedule", asCustomer, {
      method: "POST", body: { scheduledAt: new Date(Date.now() + 72 * HOUR).toISOString() },
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// the office queue
// ---------------------------------------------------------------------------

describe("/change-requests (office)", () => {
  async function fileCancel(bookingId: string) {
    await seedBooking({ id: bookingId, hoursOut: 48 });
    const res = await call(`/bookings/${bookingId}/cancel-request`, asCustomer, {
      method: "POST", body: { reason: "Rescheduling with my tenant" },
    });
    return (await res.json()).request.id as string;
  }

  async function fileReschedule(bookingId: string, targetMs: number) {
    await seedBooking({ id: bookingId, hoursOut: 3 });
    const res = await call(`/bookings/${bookingId}/reschedule`, asCustomer, {
      method: "POST", body: { scheduledAt: new Date(targetMs).toISOString(), reason: "Sick" },
    });
    return (await res.json()).request.id as string;
  }

  it("is admin-only", async () => {
    const res = await call("/change-requests", asCustomer);
    expect(res.status).toBe(403);
  });

  it("lists pending requests with the job and customer attached, plus a badge count", async () => {
    await fileCancel("chg-b-queue1");
    const res = await call("/change-requests", asAdmin, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    const mine = body.requests.find((r: any) => r.bookingId === "chg-b-queue1");
    expect(mine).toBeTruthy();
    expect(mine.booking.shortId).toBe("CHG-B-"); // first 6 of the id, upper-cased
    expect(mine.customer.id).toBe(CUST);
    expect(body.pendingCount).toBeGreaterThanOrEqual(1);
    const count = await (await call("/change-requests/count", asAdmin)).json();
    expect(count.pendingCount).toBe(body.pendingCount);
  });

  it("rejects an unknown status filter instead of silently returning everything", async () => {
    const res = await call("/change-requests?status=banana", asAdmin);
    expect(res.status).toBe(422);
  });

  it("never shows another tenant's requests", async () => {
    await fileCancel("chg-b-tenant");
    const res = await call("/change-requests", { user: ADMIN2, role: "admin", company: CO2 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requests.some((r: any) => r.bookingId === "chg-b-tenant")).toBe(false);
  });

  it("approving a cancel request is what actually cancels the job — once", async () => {
    const id = await fileCancel("chg-b-approve-cancel");
    const res = await call(`/change-requests/${id}/approve`, asAdmin, {
      method: "POST", body: { note: "Confirmed with tenant" },
    });
    expect(res.status).toBe(200);
    expect((await bookingRow("chg-b-approve-cancel")).status).toBe("cancelled");
    const rows = await requestRows("chg-b-approve-cancel");
    expect(rows[0].status).toBe("approved");
    expect(rows[0].decision_note).toBe("Confirmed with tenant");
    // second dispatcher hitting approve must not re-decide it
    const again = await call(`/change-requests/${id}/approve`, asAdmin, {
      method: "POST", body: { note: "again" },
    });
    expect(again.status).toBe(409);
  });

  it("approving a reschedule request moves the appointment to the requested time", async () => {
    const target = Date.now() + 120 * HOUR;
    const id = await fileReschedule("chg-b-approve-res", target);
    const res = await call(`/change-requests/${id}/approve`, asAdmin, {
      method: "POST", body: { note: "Slotted for Friday" },
    });
    expect(res.status).toBe(200);
    expect(Number((await bookingRow("chg-b-approve-res")).scheduled_at)).toBe(target);
    expect((await bookingRow("chg-b-approve-res")).status).toBe("confirmed");
  });

  it("declining leaves the booking exactly as it was", async () => {
    const id = await fileCancel("chg-b-decline");
    const before = await bookingRow("chg-b-decline");
    const res = await call(`/change-requests/${id}/decline`, asAdmin, {
      method: "POST", body: { note: "Tech is already dispatched — call us" },
    });
    expect(res.status).toBe(200);
    const after = await bookingRow("chg-b-decline");
    expect(after.status).toBe(before.status);
    expect(Number(after.scheduled_at)).toBe(Number(before.scheduled_at));
    const rows = await requestRows("chg-b-decline");
    expect(rows[0].status).toBe("declined");
    expect(rows[0].decision_note).toContain("already dispatched");
  });

  it("a declined request no longer blocks the customer from asking again", async () => {
    const id = await fileCancel("chg-b-reopen");
    await call(`/change-requests/${id}/decline`, asAdmin, { method: "POST", body: { note: "no" } });
    const res = await call("/bookings/chg-b-reopen/cancel-request", asCustomer, {
      method: "POST", body: { reason: "still need to cancel" },
    });
    expect(res.status).toBe(201);
  });

  it("404s on a request that doesn't exist", async () => {
    const res = await call("/change-requests/chg-nope/approve", asAdmin, {
      method: "POST", body: { note: "" },
    });
    expect(res.status).toBe(404);
  });

  it("another tenant's admin cannot decide our request", async () => {
    const id = await fileCancel("chg-b-crosstenant");
    const res = await call(`/change-requests/${id}/approve`, {
      user: ADMIN2, role: "admin", company: CO2,
    }, { method: "POST", body: { note: "hijack" } });
    expect(res.status).toBe(404);
    expect((await bookingRow("chg-b-crosstenant")).status).toBe("confirmed");
  });
});

// ---------------------------------------------------------------------------
// notifications for the new events must exist for existing tenants
// ---------------------------------------------------------------------------

describe("notification rules for the new change events", () => {
  it("backfills office, customer and tech rules on a tenant provisioned before the feature", async () => {
    for (const event of NEW_EVENTS) await ensureEventRules(CO3, event);
    const rows = await db
      .select()
      .from(schema.notificationRules)
      .where(eq(schema.notificationRules.companyId, CO3));
    for (const event of NEW_EVENTS) {
      const forEvent = rows.filter((r) => r.event === event);
      expect(forEvent.length).toBeGreaterThan(0);
      // the office has to hear about a request, and the customer has to get a
      // confirmation — in-app alone is not enough, these are email-worthy
      expect(forEvent.some((r) => r.recipient === "office")).toBe(true);
      expect(forEvent.some((r) => r.email)).toBe(true);
    }
    expect(rows.some((r) => r.event === "change_requested" && r.recipient === "client")).toBe(true);
    expect(rows.some((r) => r.event === "rescheduled" && r.recipient === "tech")).toBe(true);
  });

  it("never re-enables a rule an admin deliberately switched off", async () => {
    await ensureEventRules(CO, "change_requested");
    const rows = await db
      .select()
      .from(schema.notificationRules)
      .where(and(
        eq(schema.notificationRules.companyId, CO),
        eq(schema.notificationRules.event, "change_requested"),
      ));
    expect(rows).toHaveLength(1);
    expect(rows[0].enabled).toBe(false);
  });
});
