import { Hono } from "hono";
import { db } from "../database";
import { tdb } from "../database/tenant";
import * as schema from "../database/schema";
import { eq, isNull, and, inArray, desc, sql, type SQL } from "drizzle-orm";
import { requireAuth, tenantId, tx } from "../middleware/auth";
import { isAdminRole } from "../lib/permissions";
import { Err } from "../lib/errors";
import { fireEvent } from "../../services/dispatch";
import { recomputeBooking } from "../../services/billing";
import { reconcileRiderStatus } from "../../services/presence";
import { applyBookingStatus } from "../../services/booking-status";
import { putObject } from "../lib/storage";
import { capture } from "../lib/analytics";
import { incr } from "../lib/metrics";
import { publishTrack } from "../../services/realtime";
import { isInAnyZone } from "../../shared/zone-utils";
import { linkBookingToProperty } from "../../services/properties";
import { logJobEvent, jobTimeline } from "../../services/job-events";
import { z } from "zod";
import {
  parseBody,
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
const AssignBody = z.object({ riderId: idField("Technician") });
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

export const bookingsRoutes = new Hono()
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
      where = eq(schema.bookings.riderId, rp.id);
    } else {
      where = eq(schema.bookings.customerId, u.id);
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
  .get("/:id", requireAuth, async (c) => {
    const b = await tx(c).selectOne(schema.bookings, eq(schema.bookings.id, c.req.param("id")));
    if (!b) return c.json({ message: "Not found" }, 404);
    return c.json({ booking: await enrich(b) }, 200);
  })
  // create a booking (customer)
  .post("/", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    const co = tenantId(c);
    const t = tx(c);
    const body = await parseBody(c, BookingCreate);
    const svc = await t.selectOne(schema.services, eq(schema.services.id, body.serviceId));
    if (!svc) return c.json({ message: "Service not found" }, 404);

    const [cu] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, u.id));
    const [b] = await t.insert(schema.bookings, {
      customerId: u.id,
      serviceId: body.serviceId,
      templateId: body.templateId ?? null,
      title: body.title ?? svc.name,
      priority: body.priority ?? "normal",
      status: "confirmed",
      scheduledAt: new Date(body.scheduledAt),
      address: body.address,
      lat: body.lat ?? 43.6532,
      lng: body.lng ?? -79.3832,
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
    const tax = bill?.taxAmount ?? +(svc.basePrice * 0.13).toFixed(2);
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
  .post("/admin", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    if (!isAdminRole(u.role)) return c.json({ message: "Forbidden" }, 403);
    const body = await parseBody(c, BookingAdminCreate);

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

    // Zone enforcement — only if the booking has a real geocoded lat/lng
    if (body.lat && body.lng) {
      const allZones = await t.select(schema.serviceZones);
      const parsedZones = allZones.map((z) => ({ polygon: JSON.parse(z.polygon || "[]") as [number, number][], active: z.active }));
      const activeZones = parsedZones.filter((z) => z.active && z.polygon.length >= 3);
      if (activeZones.length > 0 && !isInAnyZone(body.lat, body.lng, parsedZones)) {
        return c.json({ message: "Address is outside all active service zones. Please update the client address or adjust your service zones." }, 422);
      }
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
      lat: body.lat ?? 43.6532,
      lng: body.lng ?? -79.3832,
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
  .post("/:id/schedule", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    if (!isAdminRole(u.role)) return c.json({ message: "Forbidden" }, 403);
    const id = c.req.param("id");
    const { scheduledAt } = await parseBody(c, ScheduleBody);
    const t = tx(c);
    const prev = await t.selectOne(schema.bookings, eq(schema.bookings.id, id));
    if (!prev) return c.json({ message: "Not found" }, 404);
    const set: Record<string, unknown> = { scheduledAt };
    const [b] = await t.update(schema.bookings, set, eq(schema.bookings.id, id));
    return c.json({ booking: await enrich(b) }, 200);
  })
  // admin edits any field on a work order (address, schedule, service, pricing, etc.)
  .patch("/:id", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    if (!isAdminRole(u.role)) return c.json({ message: "Forbidden" }, 403);
    const id = c.req.param("id");
    const co = tenantId(c);
    const t = tx(c);
    const body = await parseBody(c, BookingPatch);
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
      if (!cu || cu.companyId !== co) return c.json({ message: "Client not found" }, 404);
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
  .post("/:id/assign", requireAuth, async (c) => {
    const co = tenantId(c);
    const { riderId } = await parseBody(c, AssignBody);
    const id = c.req.param("id");
    // Tenant check: without this an admin could assign a technician belonging to
    // another company by passing their id — the booking update itself is
    // tenant-scoped, but riderId was never checked against the same tenant.
    const assignee = await tx(c).selectOne(schema.riders, eq(schema.riders.id, riderId));
    if (!assignee) return c.json({ message: "Technician not found" }, 404);
    const [b] = await tx(c).update(
      schema.bookings,
      { riderId, status: "assigned", assignStatus: "offered", assignedAt: new Date(), acceptedAt: null, declineReason: "" },
      eq(schema.bookings.id, id),
    );
    await reconcileRiderStatus(co, riderId);

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
  .post("/:id/decline", requireAuth, async (c) => {
    const id = c.req.param("id");
    const { reason } = await parseBody(c, DeclineBody);
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
  .post("/:id/status", requireAuth, async (c) => {
    const co = tenantId(c);
    const { status } = await parseBody(c, StatusBody);
    const id = c.req.param("id");
    const b = await applyBookingStatus(co, id, status);
    if (!b) return c.json({ error: "not found" }, 404);
    return c.json({ booking: await enrich(b) }, 200);
  })
  .post("/:id/cancel", requireAuth, async (c) => {
    const co = tenantId(c);
    const id = c.req.param("id");
    const t = tx(c);
    const prev = await t.selectOne(schema.bookings, eq(schema.bookings.id, id));
    const [b] = await t.update(schema.bookings, { status: "cancelled" }, eq(schema.bookings.id, id));
    await fireEvent("cancelled", id);
    // free the assigned tech so they don't stay stuck "busy" after a cancel
    if (prev?.riderId) await reconcileRiderStatus(co, prev.riderId);
    return c.json({ booking: await enrich(b) }, 200);
  })
  // review
  .post("/:id/review", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    const id = c.req.param("id");
    const { rating, comment } = await parseBody(c, ReviewBody);
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
  .post("/:id/signature", requireAuth, async (c) => {
    const id = c.req.param("id");
    const t = tx(c);
    const b = await t.selectOne(schema.bookings, eq(schema.bookings.id, id));
    if (!b) return c.json({ message: "Not found" }, 404);

    const body = await parseBody(c, SignatureBody);
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
    const stamp = new Date().toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" });
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
  .patch("/:id/checklist", requireAuth, async (c) => {
    const id = c.req.param("id");
    const { index, done } = await parseBody(c, ChecklistBody);
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
  .patch("/:id/driver-notes", requireAuth, async (c) => {
    const id = c.req.param("id");
    const t = tx(c);
    const b = await t.selectOne(schema.bookings, eq(schema.bookings.id, id));
    if (!b) return c.json({ message: "Not found" }, 404);
    const { notes } = await parseBody(c, DriverNotesBody);
    await t.update(schema.bookings, { driverNotes: notes ?? "" }, eq(schema.bookings.id, id));
    return c.json({ ok: true }, 200);
  })
  // ── Today's stats for the logged-in tech ────────────────────────────────
  // GET /api/bookings/today-stats
  // Returns { jobsDone, earnings, activeJobs } for today's date (tenant-aware)
  .get("/today-stats", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    const t = tx(c);
    // find rider record for this user
    const rider = await t.selectOne(schema.riders, eq(schema.riders.userId, u.id));
    if (!rider) return c.json({ jobsDone: 0, earnings: 0, activeJobs: 0 }, 200);
    const all = await t.select(schema.bookings, eq(schema.bookings.riderId, rider.id));
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
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
  });
