import type { AppEnv } from "../env";
import { Hono } from "hono";
import { db } from "../database";
import { tdb } from "../database/tenant";
import * as schema from "../database/schema";
import { eq, isNull, and, inArray, desc, sql, type SQL } from "drizzle-orm";
import { requireAuth, tenantId, tx } from "../middleware/auth";
import { isAdminRole } from "../lib/permissions";
import { Err } from "../lib/errors";
import { isMember } from "../lib/memberships";
import { fireEvent } from "../../services/dispatch";
import { recomputeBooking } from "../../services/billing";
import { reconcileRiderStatus } from "../../services/presence";
import { applyBookingStatus, StatusTransitionError } from "../../services/booking-status";
import { putObject } from "../lib/storage";
import { capture } from "../lib/analytics";
import { incr } from "../lib/metrics";
import { publishTrack } from "../../services/realtime";
import { checkServiceZone, OUTSIDE_ZONE_MESSAGE, OUTSIDE_ZONE_MESSAGE_ADMIN } from "../../services/zones";
import { forwardGeocode } from "../../services/geocode";
import { linkBookingToProperty } from "../../services/properties";
import { logJobEvent, jobTimeline } from "../../services/job-events";
import {
  changeStateFor,
  serializeState,
  requestReschedule,
  requestCancel,
} from "../../services/change-requests";
import { companyTimeZone } from "../../services/company-tz";
import { zonedDayBounds, fmtInZone } from "../../shared/tz";
import { assignBlockedReason, isInFlightStatus, isTerminalStatus } from "../../shared/job-status";
import { z } from "zod";
import { jsonBody,
  id as idField,
  isoDate,
  latitude,
  longitude,
  rating as ratingField,
  bookingStatus,
  priority as priorityField,
  shortText,
  longText,
  jsonBlob,
  jsonObject,
  phone,
} from "../lib/validate";

type SessionUser = { id: string; role?: string; email: string; name: string };

/**
 * Best-effort speech-to-text for tech voice notes. Uses the AI gateway's
 * OpenAI-compatible transcription endpoint when configured. Returns "" on any
 * failure — the audio itself is always kept, the transcript is a convenience.
 */
async function transcribeAudio(
  bytes: Buffer,
  filename: string,
  mime?: string,
): Promise<string> {
  const base = process.env.AI_GATEWAY_BASE_URL;
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!base || !key) return "";
  try {
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(bytes)], { type: mime || "audio/m4a" }), filename);
    fd.append("model", process.env.AI_TRANSCRIBE_MODEL || "openai/whisper-1");
    const res = await fetch(`${base.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return "";
    const json = (await res.json()) as { text?: string };
    return String(json?.text || "").trim();
  } catch (e) {
    console.error("[voice-note] transcription failed", e);
    return "";
  }
}

/**
 * Convert a Form Builder template's `fields` (text/number/checkbox/select/
 * photo/signature/date) into the `_customFields` shape the work-order modal
 * and mobile job screen already know how to render and fill in. This is what
 * actually connects templates to real work orders — previously a template's
 * fields were saved but never read back anywhere once a booking was created.
 * "photo" and "signature" both map to "file" (the existing attach-a-file
 * type); there's no dedicated signature capture yet, tracked separately.
 */
function templateFieldsToCustomFields(rawFields: string | null | undefined): any[] {
  let parsed: any[] = [];
  try { parsed = JSON.parse(rawFields || "[]"); } catch { parsed = []; }
  if (!Array.isArray(parsed)) return [];
  const TYPE_MAP: Record<string, string> = {
    text: "text", number: "number", checkbox: "checkbox", select: "select",
    date: "date", photo: "file", signature: "file",
  };
  return parsed
    .filter((f) => f && f.type && TYPE_MAP[f.type])
    .map((f) => ({
      id: `tpl_${Math.random().toString(36).slice(2, 10)}`,
      type: TYPE_MAP[f.type],
      label: f.label || "",
      required: !!f.required,
      ...(f.type === "select" ? { options: Array.isArray(f.options) ? f.options : [] } : {}),
    }));
}

// status -> notification mapping


/** The shape every booking endpoint returns. Unchanged from the original
 *  per-row `enrich()` — batching must not alter the contract, because 10
 *  call sites (including the mobile app) already consume it. */
type EnrichedBooking = typeof schema.bookings.$inferSelect & {
  service: any;
  rider: any;
  customer: { id: string; name: any; phone: any; email: any } | null;
};

/**
 * Batched enrichment — 4 queries TOTAL regardless of row count.
 *
 * This replaces a per-booking `enrich()` that issued up to 4 SEQUENTIAL queries
 * for every row (service → rider → rider's user → customer). Against a remote
 * Turso instance that measured 822 ms / ~50 round trips for just 14 bookings and
 * scaled linearly — a tenant with a few hundred jobs would have timed out.
 *
 * Pattern copied from `job-search.ts`'s `enrichRows()`, which already did this
 * correctly. Output is byte-for-byte the same as the old per-row version.
 *
 * Tenant safety: `services` and `riders` are tenant-owned, so those lookups go
 * through `tdb(companyId)` and stay company-scoped. `user` is a GLOBAL table
 * (see database/tenant.ts) and is queried by explicit id list only.
 */
async function enrichMany(
  rows: (typeof schema.bookings.$inferSelect)[],
): Promise<EnrichedBooking[]> {
  if (!rows.length) return [];

  // Fallback used if the batch fails — never let enrichment crash a whole list.
  const bare = (): EnrichedBooking[] =>
    rows.map((b) => ({ ...b, service: null, rider: null, customer: null }));

  try {
    // Rows can span companies only via system paths; group defensively so the
    // tenant-scoped lookups stay correct either way.
    const companyIds = [...new Set(rows.map((r) => r.companyId).filter(Boolean))];

    const svcIds = [...new Set(rows.map((r) => r.serviceId).filter((v): v is string => !!v))];
    const riderIds = [...new Set(rows.map((r) => r.riderId).filter((v): v is string => !!v))];
    const custIds = [...new Set(rows.map((r) => r.customerId).filter((v): v is string => !!v))];

    // 1) services — tenant-scoped, one query per company (normally exactly one)
    const svcMap = new Map<string, any>();
    if (svcIds.length) {
      await Promise.all(
        companyIds.map(async (cid) => {
          const found = await tdb(cid)
            .select(schema.services, inArray(schema.services.id, svcIds))
            .catch(() => []);
          found.forEach((s: any) => svcMap.set(s.id, s));
        }),
      );
    }

    // 2) riders — tenant-scoped
    const riderRows: any[] = [];
    if (riderIds.length) {
      await Promise.all(
        companyIds.map(async (cid) => {
          const found = await tdb(cid)
            .select(schema.riders, inArray(schema.riders.id, riderIds))
            .catch(() => []);
          riderRows.push(...found);
        }),
      );
    }

    // 3) users — GLOBAL table; one query covers both rider users and customers
    const userIds = [
      ...new Set([...riderRows.map((r) => r.userId).filter(Boolean), ...custIds]),
    ] as string[];
    const userMap = new Map<string, any>();
    if (userIds.length) {
      const us = await db
        .select()
        .from(schema.user)
        .where(inArray(schema.user.id, userIds))
        .catch(() => []);
      us.forEach((u: any) => userMap.set(u.id, u));
    }

    const riderMap = new Map<string, any>();
    riderRows.forEach((r) => {
      const ru = userMap.get(r.userId);
      riderMap.set(r.id, { ...r, name: ru?.name, phone: ru?.phone });
    });

    return rows.map((b) => {
      const cust = b.customerId ? userMap.get(b.customerId) : undefined;
      return {
        ...b,
        service: (b.serviceId ? svcMap.get(b.serviceId) : null) ?? null,
        rider: b.riderId ? (riderMap.get(b.riderId) ?? null) : null,
        customer: cust
          ? { id: cust.id, name: cust.name, phone: cust.phone, email: cust.email }
          : null,
      };
    });
  } catch (err) {
    console.error("[enrichMany] batch failed, returning unenriched rows", err);
    return bare();
  }
}

/** Single-row convenience wrapper. Same contract as before. */
async function enrich(b: typeof schema.bookings.$inferSelect) {
  const [one] = await enrichMany([b]);
  return one ?? { ...b, service: null, rider: null, customer: null };
}

async function enrichById(companyId: string, id: string) {
  const fresh = await tdb(companyId).selectOne(schema.bookings, eq(schema.bookings.id, id));
  if (!fresh) throw new Error(`Booking ${id} not found`);
  return enrich(fresh);
}


/* -------------------------------------------------------------------------- */
/*  Request schemas                                                            */
/* -------------------------------------------------------------------------- */
/**
 * These routes previously wrote `await c.req.json()` straight into the
 * bookings table. The consequences were not theoretical:
 * - `POST /:id/status` accepted ANY string, so a typo'd or hand-crafted status
 *   ("Completed", "done", "<script>") was written to the row. Every screen and
 *   every dispatch rule keys off that value, and none of them match it again.
 * - `POST /:id/review` accepted any rating, so `rating: 500` sailed into the
 *   reviews table and straight through the technician's rating average.
 * - Anything doing `new Date(body.scheduledAt)` produced an Invalid Date on
 *   garbage input and stored it, breaking the row on every calendar view.
 * - fieldData / rateModel / lineItems were JSON.stringify'd with no size limit.
 *
 * Unknown keys are stripped rather than rejected (several clients send extras),
 * which also removes the mass-assignment surface on the PATCH route.
 */

/** Fields shared by the customer-facing and admin work-order create routes. */
const BookingCore = {
  serviceId: idField("Service"),
  templateId: idField("Template").nullish(),
  title: shortText("Title", 200).optional(),
  priority: priorityField.optional(),
  scheduledAt: isoDate("Schedule date"),
  address: shortText("Address", 500),
  lat: latitude.optional(),
  lng: longitude.optional(),
  notes: longText(10_000).optional(),
  staffNotes: longText(10_000).optional(),
  region: shortText("Region", 120).optional().or(z.literal("")),
  phone: phone.optional(),
  fieldData: jsonObject().optional(),
  rateModel: jsonBlob().optional(),
  lineItems: z.array(z.unknown()).max(500, "Too many line items").optional(),
  requiredSkillClass: shortText("Skill class", 120).optional().or(z.literal("")),
  requiredSkills: z.union([z.string().max(2_000), z.array(z.string().max(120)).max(50)]).optional(),
};

const BookingCreate = z.object(BookingCore);

const BookingAdminCreate = z.object({
  ...BookingCore,
  customerId: idField("Client"),
  riderId: idField("Technician").nullish(),
  status: bookingStatus.optional(),
});

/** Every field is optional, but a present field must still be the right shape. */
const BookingPatch = z
  .object({
    title: shortText("Title", 200),
    priority: priorityField,
    address: shortText("Address", 500),
    notes: longText(10_000),
    staffNotes: longText(10_000),
    customerId: idField("Client"),
    serviceId: idField("Service"),
    templateId: idField("Template").nullable().or(z.literal("")),
    region: shortText("Region", 120).or(z.literal("")),
    lat: latitude,
    lng: longitude,
    customerPhone: phone,
    scheduledAt: z.union([isoDate("Schedule date"), z.literal("")]),
    rateModel: jsonBlob(),
    lineItems: z.array(z.unknown()).max(500, "Too many line items"),
    requiredSkillClass: shortText("Skill class", 120).or(z.literal("")),
    requiredSkills: z.union([z.string().max(2_000), z.array(z.string().max(120)).max(50)]),
    fieldData: jsonObject(),
    riderId: idField("Technician").nullable().or(z.literal("")),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

const ScheduleBody = z.object({ scheduledAt: isoDate("Schedule date") });
const AssignBody = z.object({
  riderId: idField("Technician"),
  /** Explicit dispatcher confirmation to pull a tech off a job they're working. */
  force: z.boolean().optional(),
});
const StatusBody = z.object({ status: bookingStatus });
const ReviewBody = z.object({ rating: ratingField, comment: longText(4_000).optional() });
const ChecklistBody = z.object({
  index: z.number({ message: "Index must be a number" }).int("Index must be a whole number").min(0, "Index must be 0 or greater"),
  done: z.boolean({ message: "Done must be true or false" }),
});
const DriverNotesBody = z.object({ notes: longText(10_000).default("") });

/**
 * Signature capture. The route already hand-guarded the point count, but the
 * stroke array itself was unchecked `any[][][]` — a stroke of non-numbers
 * rendered `MNaN NaN` into the stored SVG.
 */
const SignatureBody = z.object({
  strokes: z
    .array(z.array(z.tuple([z.number().finite(), z.number().finite()])).max(20_000))
    .min(1, "Signature is empty")
    .max(500, "Too many strokes"),
  width: z.number().finite().min(1).max(10_000).optional(),
  height: z.number().finite().min(1).max(10_000).optional(),
  name: shortText("Printed name", 120),
});
const DeclineBody = z.object({ reason: longText(2_000).optional().default("") });

/** Customer-initiated appointment changes (see shared/change-policy.ts). */
const RescheduleRequestBody = z.object({
  scheduledAt: isoDate("New appointment time"),
  reason: longText(2_000).optional().default(""),
});
const CancelRequestBody = z.object({ reason: longText(2_000).optional().default("") });

/**
 * Why a tech is dropping a job they already ACCEPTED. Fixed list (so the office
 * can count patterns per tech / per reason) plus an optional free-text note for
 * the detail a dropdown can never capture.
 */
export const RELEASE_REASONS = [
  "emergency",
  "vehicle",
  "running_late",
  "missing_parts",
  "unsafe_site",
  "wrong_skills",
  "other",
] as const;
export const RELEASE_REASON_LABELS: Record<(typeof RELEASE_REASONS)[number], string> = {
  emergency: "Personal emergency",
  vehicle: "Vehicle breakdown",
  running_late: "Running too late to make it",
  missing_parts: "Missing parts or equipment",
  unsafe_site: "Unsafe site conditions",
  wrong_skills: "Wrong skill set for this job",
  other: "Other",
};
const ReleaseBody = z.object({
  reason: z.enum(RELEASE_REASONS, { error: "Pick a reason for releasing this job" }),
  note: longText(2_000).optional().default(""),
});

/**
 * Job stages a tech may still hand back. "offered" is deliberately excluded —
 * an un-accepted offer is a Decline, which is a different (routine) event.
 * Once work is finished or the job is dead there is nothing to release.
 */
const RELEASABLE_STATUSES = [
  "assigned",
  "confirmed",
  "enroute",
  "arrived",
  "onsite",
  "in_progress",
  "paused",
] as const;

export const bookingsRoutes = new Hono<AppEnv>()
  // list for current user (customer sees own, rider sees assigned, admin sees all)
  /**
   * List bookings for the current user (customer sees own, rider sees assigned,
   * admin sees all).
   *
   * Pagination is OPT-IN via `?page` / `?pageSize`, deliberately. Several
   * existing consumers (admin dashboard, scheduler, rider earnings) aggregate
   * over the WHOLE result set to compute revenue and counts — silently
   * defaulting to page 1 would have made those totals quietly wrong, which is a
   * worse bug than the one being fixed.
   *
   * Instead:
   *  - enrichment is now batched for everyone (the actual N+1 fix), and
   *  - an unpaginated read is hard-capped at MAX_LIST rows and reports
   *    `truncated: true` so it can never become an unbounded fetch.
   *
   * Extra response fields (`total`, `page`, `pageSize`, `pages`, `truncated`)
   * are additive — existing callers that only read `bookings` are unaffected.
   */
  .get("/", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    const t = tx(c);

    /** Absolute ceiling for an unpaginated read. */
    const MAX_LIST = 2000;

    const rawPage = Number(c.req.query("page"));
    const rawSize = Number(c.req.query("pageSize"));
    const paginated = Number.isFinite(rawPage) && rawPage >= 1;
    const page = paginated ? Math.floor(rawPage) : 1;
    const pageSize = Math.min(
      Math.max(Number.isFinite(rawSize) && rawSize >= 1 ? Math.floor(rawSize) : 50, 1),
      200,
    );

    // Build the same visibility predicate the old code expressed with branches.
    let where: SQL | undefined;
    if (isAdminRole(u.role)) {
      where = isNull(schema.bookings.deletedAt);
    } else if (u.role === "rider") {
      const rp = await t.selectOne(schema.riders, eq(schema.riders.userId, u.id));
      // No rider profile → no jobs. Preserves the previous `[]` behaviour.
      if (!rp) {
        return c.json(
          { bookings: [], total: 0, page, pageSize, pages: 0, truncated: false },
          200,
        );
      }
      // isNull(deletedAt) matters as much here as it does for admins: without
      // it a soft-deleted work order stayed in the tech's list forever and was
      // counted in their Earnings history (found live — one deleted job was
      // padding a driver's completed-jobs list).
      where = and(eq(schema.bookings.riderId, rp.id), isNull(schema.bookings.deletedAt));
    } else {
      where = and(eq(schema.bookings.customerId, u.id), isNull(schema.bookings.deletedAt));
    }

    const scoped = t.scope(schema.bookings, where);

    // Total via COUNT(*) rather than fetching rows to count them.
    const countQ = db
      .select({ n: sql<number>`count(*)` })
      .from(schema.bookings);
    const [{ n: total }] = await (scoped ? countQ.where(scoped) : countQ);

    // Sort in SQL (was an in-memory sort over every row).
    const baseQ = db
      .select()
      .from(schema.bookings)
      .orderBy(desc(schema.bookings.createdAt));
    const withWhere = scoped ? baseQ.where(scoped) : baseQ;

    const limit = paginated ? pageSize : MAX_LIST;
    const offset = paginated ? (page - 1) * pageSize : 0;
    const rows = (await withWhere.limit(limit).offset(offset)) as
      (typeof schema.bookings.$inferSelect)[];

    const truncated = !paginated && Number(total) > MAX_LIST;
    if (truncated) {
      console.warn(
        `[bookings] unpaginated read truncated at ${MAX_LIST} of ${total} rows ` +
          `(company=${t.companyId}) — this caller should paginate`,
      );
    }

    const enriched = await enrichMany(rows);
    return c.json(
      {
        bookings: enriched,
        total: Number(total),
        page,
        pageSize: paginated ? pageSize : rows.length,
        pages: paginated ? Math.ceil(Number(total) / pageSize) : 1,
        truncated,
      },
      200,
    );
  })
  // ── Today's stats for the logged-in tech ────────────────────────────────
  // GET /api/bookings/today-stats
  //
  // MUST stay above `/:id`. Hono matches in registration order, and this route
  // used to be declared at the very bottom of the file — so `/:id` swallowed it
  // and every call returned 404 "Not found" with `id = "today-stats"`. The
  // driver app treats a non-ok response as zeros, so the home screen showed
  // 0 jobs / $0 earnings for every technician, always.
  // Returns { jobsDone, earnings, activeJobs, totalToday } for the tenant's
  // local day.
  .get("/today-stats", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    const t = tx(c);
    // find rider record for this user
    const rider = await t.selectOne(schema.riders, eq(schema.riders.userId, u.id));
    if (!rider) return c.json({ jobsDone: 0, earnings: 0, activeJobs: 0 }, 200);
    const all = await t.select(schema.bookings, eq(schema.bookings.riderId, rider.id));
    // "Today" is the tenant's local day, not the server's. setHours() here ran
    // in the process time zone (UTC in production), so for a Winnipeg tenant
    // the window rolled over at 19:00 local: the tech's completed jobs and
    // earnings for the day disappeared from their phone mid-evening, and an
    // evening job counted toward tomorrow.
    const tz = await companyTimeZone(tenantId(c));
    const { start: todayStart, end: todayEnd } = zonedDayBounds(new Date(), tz);
    const todayJobs = all.filter(b => {
      const d = b.scheduledAt ? new Date(b.scheduledAt) : null;
      return d && d >= todayStart && d <= todayEnd;
    });
    const jobsDone = todayJobs.filter(b => b.status === "completed").length;
    const earnings = todayJobs
      .filter(b => b.status === "completed")
      .reduce((sum, b) => sum + (Number(b.price) || 0), 0);
    const activeJobs = todayJobs.filter(b => ["assigned","enroute","arrived","in_progress"].includes(b.status)).length;
    return c.json({ jobsDone, earnings, activeJobs, totalToday: todayJobs.length }, 200);
  })
  .get("/:id", requireAuth, async (c) => {
    const b = await tx(c).selectOne(schema.bookings, eq(schema.bookings.id, c.req.param("id")));
    if (!b) return c.json({ message: "Not found" }, 404);
    return c.json({ booking: await enrich(b) }, 200);
  })
  // create a booking (customer)
  .post("/", requireAuth, jsonBody(BookingCreate), async (c) => {
    const u = c.get("user") as SessionUser;
    const co = tenantId(c);
    const t = tx(c);
    const body = c.req.valid("json");
    const svc = await t.selectOne(schema.services, eq(schema.services.id, body.serviceId));
    if (!svc) return c.json({ message: "Service not found" }, 404);

    const [cu] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, u.id));

    // Resolve real coordinates for the address. The lat/lng columns are NOT NULL
    // with a downtown-Toronto default, so a create with no coordinates used to
    // record the job at 43.6532,-79.3832 — visible on the fleet map, feeding
    // distance/ETA, and skipping the zone check below. If we still can't resolve
    // them we do NOT invent a location and we do NOT zone-check on a guess.
    const geo = body.lat != null && body.lng != null
      ? { lat: body.lat, lng: body.lng }
      : await forwardGeocode(body.address);

    // Zone enforcement — the customer path had NONE, so a customer far outside
    // every active zone got a confirmed booking, an invoice and a dispatch.
    if (geo) {
      const zone = await checkServiceZone(co, geo.lat, geo.lng);
      if (!zone.ok) return c.json({ message: OUTSIDE_ZONE_MESSAGE }, 422);
    }

    const [b] = await t.insert(schema.bookings, {
      customerId: u.id,
      serviceId: body.serviceId,
      templateId: body.templateId ?? null,
      title: body.title ?? svc.name,
      priority: body.priority ?? "normal",
      status: "confirmed",
      scheduledAt: new Date(body.scheduledAt),
      address: body.address,
      lat: geo?.lat ?? 43.6532,
      lng: geo?.lng ?? -79.3832,
      notes: body.notes ?? "",
      staffNotes: (body as any).staffNotes ?? "",
      fieldData: body.fieldData ? JSON.stringify(body.fieldData) : "{}",
      customerPhone: body.phone ?? cu?.phone ?? "",
      region: body.region ?? "",
      rateModel: body.rateModel ? JSON.stringify(body.rateModel) : "",
      lineItems: Array.isArray(body.lineItems) ? JSON.stringify(body.lineItems) : "",
      requiredSkillClass: (body as any).requiredSkillClass ?? "",
      requiredSkills: (body as any).requiredSkills ?? "",
      price: svc.basePrice,
    });

    // compute estimate from rate model + region (no actuals yet -> uses included-only quote)
    const bill = await recomputeBooking(co, b.id);

    // create invoice (unpaid)
    const num = `INV-${Date.now().toString().slice(-6)}`;
    const amount = bill?.subtotal ?? svc.basePrice;
    // No hardcoded 0.13 fallback: recomputeBooking() only returns null when the
    // booking we just inserted can't be read back, and inventing Ontario HST for
    // a Calgary customer is worse than invoicing tax-free and letting the office
    // recompute. bill is the only source of tax.
    const tax = bill?.taxAmount ?? 0;
    await t.insert(schema.invoices, {
      bookingId: b.id,
      customerId: u.id,
      number: num,
      amount,
      tax,
      total: bill?.total ?? +(amount + tax).toFixed(2),
    });

    // Attach to the property record for this address (creates it on first
    // job there). Best-effort — a failure here must not fail the booking.
    await linkBookingToProperty(b.id);

    // fire "created" event through the configurable dispatch engine
    await fireEvent("created", b.id);

    incr("bookings_created_total");
    capture("booking.created", co, { bookingId: b.id, serviceId: body.serviceId, source: "customer" });

    return c.json({ booking: await enrichById(co, b.id) }, 201);
  })
  // admin creates a work order on behalf of a client
  .post("/admin", requireAuth, jsonBody(BookingAdminCreate), async (c) => {
    const u = c.get("user") as SessionUser;
    if (!isAdminRole(u.role)) return c.json({ message: "Forbidden" }, 403);
    const body = c.req.valid("json");

    const co = tenantId(c);
    const t = tx(c);
    const svc = await t.selectOne(schema.services, eq(schema.services.id, body.serviceId));
    if (!svc) return c.json({ message: "Service not found" }, 404);

    const [cu] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, body.customerId));
    if (!cu) return c.json({ message: "Client not found" }, 404);

    // riderId is a foreign key too, and unlike serviceId/customerId it was
    // never resolved — a bogus technician id was a bare 500 on the FK.
    if (body.riderId) {
      const rd = await t.selectOne(schema.riders, eq(schema.riders.id, body.riderId));
      if (!rd) return c.json({ message: "Technician not found" }, 404);
    }

    // Coordinates + zone enforcement, identical logic to the customer path
    // (services/zones.ts) so the two can't drift. Geocode when the office typed
    // an address without picking a suggestion, instead of defaulting to Toronto.
    const geo = body.lat != null && body.lng != null
      ? { lat: body.lat, lng: body.lng }
      : await forwardGeocode(body.address);
    if (geo) {
      const zone = await checkServiceZone(co, geo.lat, geo.lng);
      if (!zone.ok) return c.json({ message: OUTSIDE_ZONE_MESSAGE_ADMIN }, 422);
    }

    // Seed field data + checklist from the chosen template. The admin modal
    // already lets the office add/edit custom fields before saving (sent as
    // body.fieldData._customFields) — if it did, that's authoritative (it may
    // include office edits on top of the template's defaults). Otherwise, if
    // a template is selected, seed both from it so templates actually DO
    // something on a real work order instead of being write-only.
    let fieldData = body.fieldData ? JSON.stringify(body.fieldData) : "{}";
    let checklistState = "[]";
    if (body.templateId) {
      const tpl = await t.selectOne(schema.taskTemplates, eq(schema.taskTemplates.id, body.templateId));
      if (tpl) {
        const hasOwnFields = Array.isArray(body.fieldData?._customFields) && body.fieldData._customFields.length > 0;
        if (!hasOwnFields) {
          const seeded = templateFieldsToCustomFields(tpl.fields);
          if (seeded.length) fieldData = JSON.stringify({ ...body.fieldData, _customFields: seeded });
        }
        try {
          const checklist = JSON.parse(tpl.checklist || "[]");
          if (Array.isArray(checklist) && checklist.length) {
            // `required` carries through from the template: a real
            // compliance/quality gate (e.g. a documented reading, a
            // mandated sign-off) that the mobile app blocks job completion
            // on if left unchecked — not just a cosmetic label.
            checklistState = JSON.stringify(checklist.map((item: any) => ({
              label: typeof item === "string" ? item : item.label,
              done: false,
              required: typeof item === "object" && item.required === true,
            })));
          }
        } catch { /* leave as "[]" */ }
      }
    }

    const assignedRider = body.riderId || null;
    const [b] = await t.insert(schema.bookings, {
      customerId: body.customerId,
      serviceId: body.serviceId,
      riderId: assignedRider,
      templateId: body.templateId ?? null,
      title: body.title || svc.name,
      priority: body.priority ?? "normal",
      status: assignedRider ? "assigned" : "confirmed",
      scheduledAt: new Date(body.scheduledAt),
      address: body.address ?? "",
      lat: geo?.lat ?? 43.6532,
      lng: geo?.lng ?? -79.3832,
      notes: body.notes ?? "",
      staffNotes: (body as any).staffNotes ?? "",
      fieldData,
      checklistState,
      customerPhone: body.phone ?? cu.phone ?? "",
      region: body.region ?? "",
      rateModel: body.rateModel ? JSON.stringify(body.rateModel) : "",
      lineItems: Array.isArray(body.lineItems) ? JSON.stringify(body.lineItems) : "",
      requiredSkillClass: (body as any).requiredSkillClass ?? "",
      requiredSkills: (body as any).requiredSkills ?? "",
      price: svc.basePrice,
    });

    const bill = await recomputeBooking(co, b.id);

    const num = `INV-${Date.now().toString().slice(-6)}`;
    const amount = bill?.subtotal ?? svc.basePrice;
    const tax = bill?.taxAmount ?? +(svc.basePrice * 0.13).toFixed(2);
    await t.insert(schema.invoices, {
      bookingId: b.id,
      customerId: body.customerId,
      number: num,
      amount,
      tax,
      total: bill?.total ?? +(amount + tax).toFixed(2),
    });

    if (assignedRider) {
      await reconcileRiderStatus(co, assignedRider);
    }

    await linkBookingToProperty(b.id);
    await fireEvent("created", b.id);
    incr("bookings_created_total");
    capture("booking.created", co, { bookingId: b.id, serviceId: body.serviceId, source: "admin" });
    if (assignedRider) {
      await t.update(
        schema.bookings,
        { assignStatus: "offered", assignedAt: new Date() },
        eq(schema.bookings.id, b.id),
      );
      await fireEvent("assigned", b.id);
      incr("dispatch_assigned_total");
      capture("dispatch.assigned", co, { bookingId: b.id, riderId: assignedRider });
    }

    return c.json({ booking: await enrichById(co, b.id) }, 201);
  })
  // reschedule a work order (admin) -> set scheduledAt (drag onto a calendar day)
  .post("/:id/schedule", requireAuth, jsonBody(ScheduleBody), async (c) => {
    const u = c.get("user") as SessionUser;
    if (!isAdminRole(u.role)) return c.json({ message: "Forbidden" }, 403);
    const id = c.req.param("id");
    const { scheduledAt } = c.req.valid("json");
    const t = tx(c);
    const prev = await t.selectOne(schema.bookings, eq(schema.bookings.id, id));
    if (!prev) return c.json({ message: "Not found" }, 404);
    // Revenue reports and payout periods are selected by scheduledAt, so dragging
    // a finished or cancelled job on the calendar quietly moved money from one
    // reporting period into another.
    if (isTerminalStatus(prev.status))
      return c.json(
        {
          message:
            prev.status === "completed"
              ? "This job is already completed — its date is part of your reports and payouts and can't be moved."
              : "This job was cancelled — restore it before rescheduling.",
          status: prev.status,
        },
        409,
      );
    const set: Record<string, unknown> = { scheduledAt };
    const [b] = await t.update(schema.bookings, set, eq(schema.bookings.id, id));
    // A `rescheduled` notification exists and is on by default for the client
    // (email) and the tech (SMS) — but only the customer-initiated change-request
    // flow ever fired it. When the office moved a job on the calendar, the tech's
    // phone kept showing the old time and the customer was never told.
    const moved = Number(prev.scheduledAt ?? 0) !== Number(scheduledAt ?? 0);
    if (moved) await fireEvent("rescheduled", id);
    return c.json({ booking: await enrich(b) }, 200);
  })
  // admin edits any field on a work order (address, schedule, service, pricing, etc.)
  .patch("/:id", requireAuth, jsonBody(BookingPatch), async (c) => {
    const u = c.get("user") as SessionUser;
    if (!isAdminRole(u.role)) return c.json({ message: "Forbidden" }, 403);
    const id = c.req.param("id");
    const co = tenantId(c);
    const t = tx(c);
    const body = c.req.valid("json");
    const prev = await t.selectOne(schema.bookings, eq(schema.bookings.id, id));
    if (!prev) return c.json({ message: "Not found" }, 404);

    // Every one of these columns is a foreign key. The schema only checks the
    // SHAPE of an id, so a stale or hand-typed id sailed through and blew up
    // on the FK constraint as a bare 500 (reproduced live with
    // { serviceId: "zz-deleted-service" }, and the same for riderId,
    // customerId and templateId). Resolving them here also keeps the write
    // inside the caller's tenant instead of pointing a work order at another
    // company's row.
    if (body.serviceId !== undefined) {
      const svc = await t.selectOne(schema.services, eq(schema.services.id, body.serviceId));
      if (!svc) return c.json({ message: "Service not found" }, 404);
    }
    if (body.customerId !== undefined) {
      const [cu] = await db.select().from(schema.user).where(eq(schema.user.id, body.customerId));
      // Membership, not user.companyId: a client shared with another company is
      // still this company's client, and comparing home companies rejected them.
      if (!cu || !(await isMember(cu.id, co))) return c.json({ message: "Client not found" }, 404);
    }
    if (body.riderId) {
      const rd = await t.selectOne(schema.riders, eq(schema.riders.id, body.riderId));
      if (!rd) return c.json({ message: "Technician not found" }, 404);
    }
    if (body.templateId) {
      const tpl = await t.selectOne(schema.taskTemplates, eq(schema.taskTemplates.id, body.templateId));
      if (!tpl) return c.json({ message: "Template not found" }, 404);
    }

    const set: Record<string, unknown> = {};
    if (body.title !== undefined) set.title = body.title;
    if (body.priority !== undefined) set.priority = body.priority;
    if (body.address !== undefined) set.address = body.address;
    if (body.notes !== undefined) set.notes = body.notes;
    if ((body as any).staffNotes !== undefined) set.staffNotes = (body as any).staffNotes;
    if (body.customerId !== undefined) set.customerId = body.customerId;
    if (body.serviceId !== undefined) set.serviceId = body.serviceId;
    if (body.templateId !== undefined) set.templateId = body.templateId || null;
    if (body.region !== undefined) set.region = body.region ?? "";
    if (body.lat !== undefined) set.lat = body.lat;
    if (body.lng !== undefined) set.lng = body.lng;
    if (body.customerPhone !== undefined) set.customerPhone = body.customerPhone;
    if (body.scheduledAt) set.scheduledAt = body.scheduledAt;
    if (body.rateModel !== undefined)
      set.rateModel = body.rateModel ? JSON.stringify(body.rateModel) : "";
    if (body.lineItems !== undefined)
      set.lineItems = Array.isArray(body.lineItems) ? JSON.stringify(body.lineItems) : "";
    if ((body as any).requiredSkillClass !== undefined)
      set.requiredSkillClass = (body as any).requiredSkillClass ?? "";
    if ((body as any).requiredSkills !== undefined)
      set.requiredSkills = (body as any).requiredSkills ?? "";
    // BUG FIX: this route never accepted fieldData at all, so any custom
    // field edits made in the work-order modal (e.g. filling in/adjusting the
    // dropdown/checkbox/etc. fields carried over from a template) were
    // silently dropped on every save. The modal always sends the full
    // { _customFields: [...] } shape, so a plain overwrite is correct here —
    // there's no partial-merge case to worry about.
    if (body.fieldData !== undefined) set.fieldData = JSON.stringify(body.fieldData);

    // handle (re)assignment if the rider changed
    const newRider = body.riderId;
    if (newRider !== undefined && newRider !== (prev.riderId ?? "")) {
      if (newRider) {
        set.riderId = newRider;
        if (["pending", "confirmed", "unassigned"].includes(prev.status))
          set.status = "assigned";
        set.assignStatus = "offered";
        set.assignedAt = new Date();
        set.acceptedAt = null;
        set.declineReason = "";
      } else {
        set.riderId = null;
        if (["assigned"].includes(prev.status)) set.status = "confirmed";
        set.assignStatus = "";
      }
    }

    await t.update(schema.bookings, set, eq(schema.bookings.id, id));

    // keep busy status + offer flow in sync on a real reassignment
    if (newRider !== undefined && newRider !== (prev.riderId ?? "")) {
      if (newRider) {
        await reconcileRiderStatus(co, newRider);
        await fireEvent("assigned", id);
      }
      // free the previous tech if they were assigned (clears their stale "busy")
      if (prev.riderId) await reconcileRiderStatus(co, prev.riderId);
    }

    // Editing the date in the work-order modal is a reschedule too — same silent
    // failure as the calendar drag: nobody was told the appointment moved.
    if (
      body.scheduledAt &&
      !isTerminalStatus(prev.status) &&
      Number(prev.scheduledAt ?? 0) !== Number(body.scheduledAt ?? 0)
    ) {
      await fireEvent("rescheduled", id);
    }

    // re-price whenever pricing-relevant fields move
    if (
      body.rateModel !== undefined ||
      body.region !== undefined ||
      body.serviceId !== undefined ||
      body.templateId !== undefined ||
      body.lineItems !== undefined
    ) {
      await recomputeBooking(co, id);
    }

    return c.json({ booking: await enrichById(co, id) }, 200);
  })
  // assign a rider (admin) -> offers the job; tech must accept before en route
  .post("/:id/assign", requireAuth, jsonBody(AssignBody), async (c) => {
    const co = tenantId(c);
    const u = c.get("user") as SessionUser;
    // Dispatching work is an office action. This route was open to any signed-in
    // user in the tenant, so a technician could hand themselves (or a coworker)
    // any job on the board.
    if (!isAdminRole(u.role)) return c.json({ message: "Forbidden" }, 403);
    const { riderId, force } = c.req.valid("json");
    const id = c.req.param("id");
    const t = tx(c);
    // Tenant check: without this an admin could assign a technician belonging to
    // another company by passing their id — the booking update itself is
    // tenant-scoped, but riderId was never checked against the same tenant.
    const assignee = await t.selectOne(schema.riders, eq(schema.riders.id, riderId));
    if (!assignee) return c.json({ message: "Technician not found" }, 404);
    // A bad/stale booking id used to fall through to `enrich(undefined)`.
    const prev = await t.selectOne(schema.bookings, eq(schema.bookings.id, id));
    if (!prev) return c.json({ message: "Work order not found" }, 404);

    // Terminal and in-flight jobs are protected (see assignBlockedReason).
    const blocked = assignBlockedReason(prev.status, { force });
    // `forceable` tells the dispatch UI whether this refusal is a "are you sure"
    // (a tech is mid-job) or a hard no (the job is completed/cancelled), so it can
    // offer a Reassign confirmation for the first and only explain the second.
    if (blocked)
      return c.json(
        { message: blocked, status: prev.status, forceable: isInFlightStatus(prev.status) },
        409,
      );
    // Re-offering the job to the tech who already accepted it looks harmless in
    // the UI but wipes acceptedAt, drops them back to "offered" and re-sends the
    // dispatch notification. Refuse unless the office really means it.
    if (prev.riderId === riderId && prev.assignStatus === "accepted" && !force)
      return c.json(
        { message: "This technician has already accepted this job.", status: prev.status, forceable: true },
        409,
      );

    const set: Record<string, unknown> = {
      riderId, status: "assigned", assignStatus: "offered",
      assignedAt: new Date(), acceptedAt: null, declineReason: "",
    };
    // Handing a live job to someone else: the new tech must not inherit the
    // previous tech's drive time, arrival or running on-site clock (that time is
    // billable and belongs to the first visit, not to this one).
    if (prev.status !== "assigned" && prev.riderId !== riderId) {
      set.enrouteAt = null;
      set.startedAt = null;
      set.clockState = "idle";
      set.lastResumeAt = null;
      set.insideGeofence = false;
    }
    // Compare-and-set on the status we just checked: if a tech accepted, released
    // or completed the job in the meantime, this write does nothing rather than
    // clobbering the newer state.
    const [b] = await t.update(
      schema.bookings,
      set,
      and(eq(schema.bookings.id, id), eq(schema.bookings.status, prev.status)),
    );
    if (!b)
      return c.json(
        { message: "This job just changed — pull it up again to see where it is now." },
        409,
      );
    await reconcileRiderStatus(co, riderId);
    // Free the tech who was pulled off, so they don't stay "busy" on a job they
    // no longer hold.
    if (prev.riderId && prev.riderId !== riderId) await reconcileRiderStatus(co, prev.riderId);

    await fireEvent("assigned", id);
    return c.json({ booking: await enrich(b) }, 200);
  })
  // tech accepts an offered job.
  // Compare-and-set: only transitions a job that is STILL "offered". If the
  // office reassigned, cancelled, or another tech already grabbed it (or a
  // duplicate tap / multi-node race fires twice), 0 rows update and we return
  // 409 instead of silently clobbering a newer state.
  .post("/:id/accept", requireAuth, async (c) => {
    const id = c.req.param("id");
    const [b] = await tx(c).update(
      schema.bookings,
      { assignStatus: "accepted", acceptedAt: new Date() },
      and(eq(schema.bookings.id, id), eq(schema.bookings.assignStatus, "offered")),
    );
    if (!b) throw Err.conflict("This job is no longer available to accept.");
    await fireEvent("accepted", id);
    return c.json({ booking: await enrich(b) }, 200);
  })
  // tech declines an offered job -> back to dispatch queue, notify office
  .post("/:id/decline", requireAuth, jsonBody(DeclineBody), async (c) => {
    const id = c.req.param("id");
    const { reason } = c.req.valid("json");
    const t = tx(c);
    const cur = await t.selectOne(schema.bookings, eq(schema.bookings.id, id));
    // Only an OFFERED job can be declined. Guards against a stale tap after the
    // office already pulled/reassigned the job (would otherwise wrongly null
    // out a freshly-assigned rider).
    if (!cur || cur.assignStatus !== "offered") {
      throw Err.conflict("This job is no longer pending your response.");
    }
    // free the tech, return to queue (unassigned + confirmed)
    if (cur.riderId) {
      await t.update(schema.riders, { status: "available" }, eq(schema.riders.id, cur.riderId));
    }
    // fire declined first (while riderId still resolves to the tech who declined)
    await fireEvent("declined", id);
    const [b] = await t.update(
      schema.bookings,
      { riderId: null, status: "confirmed", assignStatus: "declined", declineReason: reason || "" },
      and(eq(schema.bookings.id, id), eq(schema.bookings.assignStatus, "offered")),
    );
    if (!b) throw Err.conflict("This job is no longer pending your response.");
    return c.json({ booking: await enrich(b) }, 200);
  })
  // update status (rider/admin) -> triggers notifications + emails
  .post("/:id/status", requireAuth, jsonBody(StatusBody), async (c) => {
    const co = tenantId(c);
    const u = c.get("user") as SessionUser;
    const { status } = c.req.valid("json");
    const id = c.req.param("id");
    // The office can correct a record (put a wrongly-completed job back on the
    // board); the field app cannot skip or reverse a stage. Without this a
    // driver could go enroute -> completed: no arrival, no transit time, no
    // on-site clock, and no "your technician is here" for the customer.
    let b;
    try {
      b = await applyBookingStatus(co, id, status, { force: isAdminRole(u.role) });
    } catch (e) {
      if (e instanceof StatusTransitionError)
        return c.json({ message: e.message, from: e.from, to: e.to }, 409);
      throw e;
    }
    if (!b) return c.json({ error: "not found" }, 404);
    return c.json({ booking: await enrich(b) }, 200);
  })
  /**
   * Tech hands an ACCEPTED job back to dispatch (van broke down, emergency,
   * can't make it). The job returns to the queue UNASSIGNED so the office can
   * re-dispatch it — it is NOT cancelled, and the customer is told nothing here
   * (office owns that conversation).
   */
  .post("/:id/release", requireAuth, jsonBody(ReleaseBody), async (c) => {
    const co = tenantId(c);
    const u = c.get("user") as SessionUser;
    const id = c.req.param("id");
    const { reason, note } = c.req.valid("json");
    const t = tx(c);
    const cur = await t.selectOne(schema.bookings, eq(schema.bookings.id, id));
    if (!cur) return c.json({ message: "Not found" }, 404);
    // Only the tech actually holding the job (or the office) can release it.
    // Without this any signed-in user in the tenant could unassign anyone's job.
    const holder = cur.riderId
      ? await t.selectOne(schema.riders, eq(schema.riders.id, cur.riderId))
      : null;
    const isHolder = !!holder && holder.userId === u.id;
    if (!isHolder && !isAdminRole(u.role)) return c.json({ message: "Forbidden" }, 403);
    if (!cur.riderId) throw Err.conflict("This job isn't assigned to anyone.");
    if (cur.assignStatus === "offered")
      throw Err.conflict("You haven't accepted this job yet — decline it instead.");
    if (!RELEASABLE_STATUSES.includes(cur.status as (typeof RELEASABLE_STATUSES)[number]))
      throw Err.conflict("This job can no longer be released.");
    const detail = `${RELEASE_REASON_LABELS[reason]}${note ? ` — ${note}` : ""}`;
    const releasedRider = cur.riderId;
    // Compare-and-set on (id, riderId, status): if the office reassigned or the
    // job moved on between the read and the write, 0 rows change and we 409
    // instead of clobbering newer state. Doing that as the reason-write means
    // the reason is already on the row when the event fires (notification +
    // timeline read it from there) while riderId still resolves to the tech who
    // bailed, so the office sees WHO dropped it and why.
    const [claimed] = await t.update(
      schema.bookings,
      { declineReason: detail },
      and(
        eq(schema.bookings.id, id),
        eq(schema.bookings.riderId, releasedRider),
        eq(schema.bookings.status, cur.status),
      ),
    );
    if (!claimed) throw Err.conflict("This job just changed — pull it up again.");
    await fireEvent("released", id);
    const [b] = await t.update(
      schema.bookings,
      {
        riderId: null,
        status: "confirmed",
        assignStatus: "released",
        declineReason: detail,
        assignedAt: null,
        acceptedAt: null,
        // in-flight progress belongs to the trip that just ended: reset it so
        // the next tech's drive/clock starts clean. Banked totals
        // (onSiteMinutes, mileageKm, transitMinutes, accumulatedMs) are kept as
        // the record of work already done — the office adjusts pay, not us.
        enrouteAt: null,
        startedAt: null,
        clockState: "idle",
        lastResumeAt: null,
        insideGeofence: false,
        etaMins: null,
        etaDistanceKm: null,
      },
      eq(schema.bookings.id, id),
    );
    if (!b) throw Err.conflict("This job just changed — pull it up again.");
    await reconcileRiderStatus(co, releasedRider);
    return c.json({ booking: await enrich(b) }, 200);
  })
  .post("/:id/cancel", requireAuth, async (c) => {
    const co = tenantId(c);
    const u = c.get("user") as SessionUser;
    const id = c.req.param("id");
    const t = tx(c);
    const prev = await t.selectOne(schema.bookings, eq(schema.bookings.id, id));
    if (!prev) return c.json({ message: "Not found" }, 404);
    // Cancelling belongs to the office or the customer whose job it is. This
    // route used to be guarded by requireAuth alone, so ANY signed-in user in
    // the tenant — including a tech, or a customer poking at another
    // customer's booking id — could kill someone else's work order.
    if (!isAdminRole(u.role) && prev.customerId !== u.id)
      return c.json({ message: "Forbidden" }, 403);
    // A CUSTOMER can no longer hard-cancel their own job here, which is what
    // this endpoint allowed: a job could leave the dispatch board with nobody at
    // the company deciding it should, and no reason recorded. Customer-side
    // cancellation is a request the office approves
    // (POST /:id/cancel-request). Office cancellation is unchanged.
    if (!isAdminRole(u.role))
      return c.json(
        {
          message:
            "Cancellations are handled by the office — send a cancellation request and we'll confirm it.",
          useEndpoint: `/api/bookings/${id}/cancel-request`,
        },
        409,
      );
    const [b] = await t.update(schema.bookings, { status: "cancelled" }, eq(schema.bookings.id, id));
    await fireEvent("cancelled", id);
    // free the assigned tech so they don't stay stuck "busy" after a cancel
    if (prev?.riderId) await reconcileRiderStatus(co, prev.riderId);
    return c.json({ booking: await enrich(b) }, 200);
  })
  /**
   * What the signed-in customer may do to this appointment right now, plus any
   * request already in flight. The portal renders buttons off this instead of
   * guessing, and the write endpoints below re-run the same evaluator — so the
   * screen and the server can never disagree.
   */
  .get("/:id/change-policy", requireAuth, async (c) => {
    const co = tenantId(c);
    const u = c.get("user") as SessionUser;
    const id = c.req.param("id");
    const b = await tx(c).selectOne(schema.bookings, eq(schema.bookings.id, id));
    if (!b) return c.json({ message: "Not found" }, 404);
    if (!isAdminRole(u.role) && b.customerId !== u.id)
      return c.json({ message: "Forbidden" }, 403);
    const state = await changeStateFor(co, b);
    return c.json(serializeState(state), 200);
  })
  /**
   * Customer moves their appointment. Outside the tenant's cutoff this is
   * applied immediately; inside it, it becomes a request the office approves.
   * services/change-requests.ts owns both paths so the audit trail is identical.
   */
  .post("/:id/reschedule", requireAuth, jsonBody(RescheduleRequestBody), async (c) => {
    const co = tenantId(c);
    const u = c.get("user") as SessionUser;
    const id = c.req.param("id");
    const body = c.req.valid("json");
    const b = await tx(c).selectOne(schema.bookings, eq(schema.bookings.id, id));
    if (!b) return c.json({ message: "Not found" }, 404);
    if (!isAdminRole(u.role) && b.customerId !== u.id)
      return c.json({ message: "Forbidden" }, 403);
    const r = await requestReschedule({
      companyId: co,
      booking: b,
      proposedAt: body.scheduledAt,
      reason: body.reason ?? "",
      actorId: u.id,
      actorName: u.name ?? "",
    });
    if (!r.ok)
      return c.json(
        { message: r.message },
        r.code === "invalid" ? 422 : r.code === "conflict" ? 409 : 403,
      );
    return c.json(
      r.mode === "applied"
        ? { mode: "applied", scheduledAt: r.scheduledAt, request: r.request }
        : { mode: "requested", request: r.request },
      200,
    );
  })
  /**
   * Customer ASKS to cancel. Never cancels anything — it files a pending request
   * for the office. See the /:id/cancel guard above for why.
   */
  .post("/:id/cancel-request", requireAuth, jsonBody(CancelRequestBody), async (c) => {
    const co = tenantId(c);
    const u = c.get("user") as SessionUser;
    const id = c.req.param("id");
    const body = c.req.valid("json");
    const b = await tx(c).selectOne(schema.bookings, eq(schema.bookings.id, id));
    if (!b) return c.json({ message: "Not found" }, 404);
    if (!isAdminRole(u.role) && b.customerId !== u.id)
      return c.json({ message: "Forbidden" }, 403);
    const r = await requestCancel({
      companyId: co,
      booking: b,
      reason: body.reason ?? "",
      actorId: u.id,
      actorName: u.name ?? "",
    });
    if (!r.ok)
      return c.json({ message: r.message }, r.code === "conflict" ? 409 : 403);
    return c.json({ mode: "requested", request: r.request }, 201);
  })
  // review
  .post("/:id/review", requireAuth, jsonBody(ReviewBody), async (c) => {
    const u = c.get("user") as SessionUser;
    const id = c.req.param("id");
    const { rating, comment } = c.req.valid("json");
    const t = tx(c);
    const b = await t.selectOne(schema.bookings, eq(schema.bookings.id, id));
    if (!b) return c.json({ message: "Not found" }, 404);
    const [r] = await t.insert(schema.reviews, {
      bookingId: id,
      customerId: u.id,
      riderId: b.riderId,
      rating,
      comment: comment ?? "",
    });
    return c.json({ review: r }, 201);
  })
  // list job photos for a work order
  .get("/:id/photos", requireAuth, async (c) => {
    const rows = await tx(c).select(
      schema.jobPhotos,
      eq(schema.jobPhotos.bookingId, c.req.param("id")),
    );
    rows.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    return c.json({ photos: rows }, 200);
  })
  // upload a job photo (tech). multipart: file, optional caption
  .post("/:id/photos", requireAuth, async (c) => {
    const id = c.req.param("id");
    const t = tx(c);
    const b = await t.selectOne(schema.bookings, eq(schema.bookings.id, id));
    if (!b) return c.json({ message: "Not found" }, 404);
    const form = await c.req.formData();
    const file = form.get("file");
    const caption = String(form.get("caption") || "");
    // before | during | after — what stage of the job this shot documents.
    const rawPhase = String(form.get("phase") || "during").toLowerCase();
    const phase = ["before", "during", "after"].includes(rawPhase) ? rawPhase : "during";
    // techs can mark a shot office-only (default: the homeowner sees it)
    const customerVisible = String(form.get("customerVisible") ?? "true") !== "false";
    if (!(file instanceof File)) return c.json({ message: "No file" }, 400);
    if (file.size > 15 * 1024 * 1024) return c.json({ message: "Image too large (max 15MB)" }, 400);
    const ALLOWED = ["image/jpeg", "image/png", "image/webp"];
    if (file.type && !ALLOWED.includes(file.type))
      return c.json({ message: `Unsupported type ${file.type}` }, 400);
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase().slice(0, 8);
    const key = `job-photos/${id}/${crypto.randomUUID()}.${ext}`;
    const stored = await putObject(
      key,
      Buffer.from(await file.arrayBuffer()),
      file.type || "image/jpeg",
    );
    const [p] = await t.insert(schema.jobPhotos, {
      bookingId: id,
      url: stored.url,
      caption,
      source: "upload",
      phase,
      customerVisible,
    });
    // Timeline entry so the photo shows up in the customer's job history and
    // permanent record, not just the admin gallery.
    const me = c.get("user") as SessionUser;
    await logJobEvent({
      companyId: b.companyId,
      bookingId: id,
      kind: "photo_added",
      actorRole: "tech",
      actorName: me?.name || "",
      label: caption
        ? `${phase === "before" ? "Before" : phase === "after" ? "After" : "Job"} photo — ${caption}`
        : `${phase === "before" ? "Before" : phase === "after" ? "After" : "Job"} photo added`,
      meta: { photoId: p.id, url: stored.url, caption, phase },
      // an office-only photo must not surface a timeline entry to the customer
      customerVisible: customerVisible ? undefined : false,
    });

    // Notify dispatch in real-time so the office sees the new photo immediately
    if (b.publicToken) {
      void publishTrack({
        type: "status",
        token: b.publicToken,
        data: { event: "photo_added", photoId: p.id, bookingId: id },
      });
    }
    return c.json({ photo: p }, 201);
  })
  // ── Full internal timeline for the office (includes hidden events) ───────
  // GET /api/bookings/:id/events
  .get("/:id/events", requireAuth, async (c) => {
    const id = c.req.param("id");
    const b = await tx(c).selectOne(schema.bookings, eq(schema.bookings.id, id));
    if (!b) return c.json({ message: "Not found" }, 404);
    const events = await jobTimeline(id, { onlyCustomerVisible: false });
    return c.json(
      {
        events,
        signature: b.signedAt
          ? { url: b.signatureUrl, name: b.signatureName, at: b.signedAt }
          : null,
      },
      200,
    );
  })
  // ── Customer sign-off (tech captures on site) ────────────────────────────
  // POST /api/bookings/:id/signature
  //   { strokes: [[[x,y],...], ...], width, height, name }  ← drawn on device
  // Strokes are rendered to an SVG server-side and stored like any other job
  // asset. Drawing is sent as points rather than a rasterised image so the
  // mobile app needs no native canvas/webview dependency (ships over-the-air).
  .post("/:id/signature", requireAuth, jsonBody(SignatureBody), async (c) => {
    const id = c.req.param("id");
    const t = tx(c);
    const b = await t.selectOne(schema.bookings, eq(schema.bookings.id, id));
    if (!b) return c.json({ message: "Not found" }, 404);

    const body = c.req.valid("json");
    const strokes = body.strokes;
    const name = body.name;
    // guard against a runaway payload
    const points = strokes.reduce((n, s) => n + s.length, 0);
    if (points > 20000) throw Err.badRequest("Signature too large");

    const w = Math.round(body.width ?? 600);
    const h = Math.round(body.height ?? 200);
    const paths = strokes
      .filter((s) => s.length > 0)
      .map((s) => {
        const d = s
          .map((pt, i) => {
            const x = Math.round(pt[0] * 100) / 100;
            const y = Math.round(pt[1] * 100) / 100;
            return `${i === 0 ? "M" : "L"}${x} ${y}`;
          })
          .join(" ");
        return `<path d="${d}" fill="none" stroke="#0f172a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
      })
      .join("");
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
      `<rect width="100%" height="100%" fill="#ffffff"/>${paths}</svg>`;

    const stored = await putObject(
      `signatures/${id}/${crypto.randomUUID()}.svg`,
      Buffer.from(svg, "utf8"),
      "image/svg+xml",
    );
    const signedAt = new Date();
    await t.update(
      schema.bookings,
      { signatureUrl: stored.url, signatureName: name, signedAt },
      eq(schema.bookings.id, id),
    );

    const me = c.get("user") as SessionUser;
    await logJobEvent({
      companyId: b.companyId,
      bookingId: id,
      kind: "signature_captured",
      actorRole: "tech",
      actorName: me?.name || "",
      label: `Signed off by ${name}`,
      meta: { url: stored.url, name },
    });
    if (b.publicToken) {
      void publishTrack({
        type: "status",
        token: b.publicToken,
        data: { event: "signature_captured", bookingId: id },
      });
    }
    return c.json({ signatureUrl: stored.url, signatureName: name, signedAt }, 201);
  })
  // ── Voice note (tech dictates, office reads) ─────────────────────────────
  // POST /api/bookings/:id/voice-note   multipart: file, optional transcript
  // Office-only: stored as an internal job event and appended to driverNotes.
  // Never customer-visible.
  .post("/:id/voice-note", requireAuth, async (c) => {
    const id = c.req.param("id");
    const t = tx(c);
    const b = await t.selectOne(schema.bookings, eq(schema.bookings.id, id));
    if (!b) return c.json({ message: "Not found" }, 404);

    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ message: "No file" }, 400);
    if (file.size > 25 * 1024 * 1024) return c.json({ message: "Recording too long (max 25MB)" }, 400);
    const secs = Math.max(0, Math.round(Number(form.get("durationSecs")) || 0));
    const bytes = Buffer.from(await file.arrayBuffer());
    const ext = (file.name.split(".").pop() || "m4a").toLowerCase().slice(0, 8);
    const stored = await putObject(
      `voice-notes/${id}/${crypto.randomUUID()}.${ext}`,
      bytes,
      file.type || "audio/m4a",
    );

    // Client may transcribe on-device; otherwise try the gateway. Both are
    // best-effort — a failed transcript must never lose the recording.
    let transcript = String(form.get("transcript") || "").trim();
    if (!transcript) transcript = await transcribeAudio(bytes, file.name || `note.${ext}`, file.type);

    const me = c.get("user") as SessionUser;
    // Stamped on the tenant's clock: an office reader seeing "2:14 AM" on a
    // note dictated at 9:14 PM has no idea what they're looking at.
    const stamp = fmtInZone(
      new Date(),
      await companyTimeZone(t.companyId),
      { dateStyle: "medium", timeStyle: "short" },
      "en-CA",
    );
    if (transcript) {
      const line = `[Voice note — ${me?.name || "Tech"}, ${stamp}] ${transcript}`;
      const next = b.driverNotes ? `${b.driverNotes}\n${line}` : line;
      await t.update(schema.bookings, { driverNotes: next }, eq(schema.bookings.id, id));
    }
    await logJobEvent({
      companyId: b.companyId,
      bookingId: id,
      kind: "voice_note",
      actorRole: "tech",
      actorName: me?.name || "",
      label: transcript ? `Voice note: ${transcript.slice(0, 120)}` : "Voice note recorded",
      detail: transcript,
      meta: { url: stored.url, durationSecs: secs, transcribed: !!transcript },
    });
    return c.json({ url: stored.url, transcript, durationSecs: secs }, 201);
  })
  // ── Checklist toggle (tech) ──────────────────────────────────────────────
  // PATCH /api/bookings/:id/checklist { index: number, done: boolean }
  // Tech can check/uncheck individual items. Stored in bookings.checklistState JSON.
  .patch("/:id/checklist", requireAuth, jsonBody(ChecklistBody), async (c) => {
    const id = c.req.param("id");
    const { index, done } = c.req.valid("json");
    const t = tx(c);
    const b = await t.selectOne(schema.bookings, eq(schema.bookings.id, id));
    if (!b) return c.json({ message: "Not found" }, 404);
    let checklist: any[] = [];
    try { checklist = JSON.parse(b.checklistState || "[]"); } catch {}
    if (index < 0 || index >= checklist.length) return c.json({ message: "Invalid index" }, 400);
    const item = checklist[index];
    checklist[index] = typeof item === "object" ? { ...item, done } : { label: String(item), done };
    await t.update(schema.bookings, { checklistState: JSON.stringify(checklist) }, eq(schema.bookings.id, id));
    return c.json({ checklist }, 200);
  })
  // Tech saves a field note to the booking record (visible to office/dispatch)
  .patch("/:id/driver-notes", requireAuth, jsonBody(DriverNotesBody), async (c) => {
    const id = c.req.param("id");
    const t = tx(c);
    const b = await t.selectOne(schema.bookings, eq(schema.bookings.id, id));
    if (!b) return c.json({ message: "Not found" }, 404);
    const { notes } = c.req.valid("json");
    await t.update(schema.bookings, { driverNotes: notes ?? "" }, eq(schema.bookings.id, id));
    return c.json({ ok: true }, 200);
  });

