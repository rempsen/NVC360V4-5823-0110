import { Hono } from "hono";
import { db } from "../database";
import { tdb } from "../database/tenant";
import * as schema from "../database/schema";
import { eq, and, inArray } from "drizzle-orm";
import { sendSms, trackingUrl } from "../../services/sms";
import { computeRoute } from "./geo";
import { trackLimiter, trackWriteLimiter } from "../lib/rate-limit";
import { streamSSE } from "hono/streaming";
import { subscribeTrack, publishMsg } from "../../services/realtime";
import { jobTimeline } from "../../services/job-events";
import { reviewRouting, alertLowRating } from "../../services/reviews";
import { propertyUrl } from "../../services/properties";
import { safeTimeZone } from "../../shared/tz";

// Resolve a booking by its public token, enforcing expiry. Returns null when
// the token is unknown OR has expired (PII link safety).
async function resolveByToken(token: string) {
  const [b] = await db
    .select()
    .from(schema.bookings)
    .where(eq(schema.bookings.publicToken, token));
  if (!b) return null;
  // A completed job's link is the customer's permanent record — it must keep
  // resolving forever. Expiry only protects LIVE links (which expose the
  // technician's real-time location); once the job is done there's no live
  // location to protect.
  if (b.status === "completed") return b;
  if (b.tokenExpiresAt && Number(b.tokenExpiresAt) < Date.now()) return null;
  return b;
}

// ── Public input handling ────────────────────────────────────────────────────
// Everything below /api/track is reachable by anyone holding the link: no
// session, no CSRF, no client we control. So the body is treated as hostile.
// Bad input must come back as a 400 the page can show, never a 500 (which is
// what an unguarded `await c.req.json()` produces for an empty or malformed
// body, and what a NaN rating produces at the insert).

/** Max characters accepted in a customer message / review comment. */
const MAX_MESSAGE_CHARS = 2000;
/** Max characters of a customer message we forward into an SMS (cost control). */
const SMS_PREVIEW_CHARS = 140;
/** Max characters accepted for the display name on a public message. */
const MAX_SENDER_NAME_CHARS = 60;

/** Parse a JSON body without throwing. Returns null when absent/malformed. */
async function safeJson(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown> | null> {
  try {
    const v = await c.req.json();
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Require a non-empty, length-bounded string. Anything that is not already a
 * string is rejected rather than coerced — `String({})` is "[object Object]",
 * which is exactly what used to land in the message thread and in the SMS sent
 * to the technician.
 */
function readText(
  v: unknown,
  max: number,
): { ok: true; value: string } | { ok: false; reason: "type" | "empty" | "long" } {
  if (typeof v !== "string") return { ok: false, reason: "type" };
  const s = v.trim();
  if (!s) return { ok: false, reason: "empty" };
  if (s.length > max) return { ok: false, reason: "long" };
  return { ok: true, value: s };
}

/** A star rating is 1–5 whole stars. Out of range is a bad request, not a clamp. */
function readRating(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 5) return null;
  return n;
}

// road-route cache so the 2.5s public poll never hammers Google Directions.
// recompute at most once per ~12s per booking (driver hasn't moved far in that).
const ROUTE_TTL_MS = 12_000;
const routeCache = new Map<
  string,
  { at: number; oLat: number; oLng: number; route: Awaited<ReturnType<typeof computeRoute>> }
>();

async function cachedRoute(
  bookingId: string,
  oLat: number,
  oLng: number,
  dLat: number,
  dLng: number,
) {
  const now = Date.now();
  const c = routeCache.get(bookingId);
  // reuse cache unless it's stale OR the driver moved >120m since last route
  if (c) {
    const moved =
      Math.abs(c.oLat - oLat) > 0.0011 || Math.abs(c.oLng - oLng) > 0.0011;
    if (now - c.at < ROUTE_TTL_MS && !moved) return c.route;
  }
  const route = await computeRoute(oLat, oLng, dLat, dLng);
  routeCache.set(bookingId, { at: now, oLat, oLng, route });
  return route;
}

/** Build the full public tracking snapshot for a booking row. */
/** Statuses where a running-late banner still helps. Once the tech is on site
 * the customer can see the van, and a delay banner is just noise. */
const DELAY_VISIBLE_STATUSES = new Set([
  "pending",
  "confirmed",
  "assigned",
  "accepted",
  "enroute",
]);

async function buildSnapshot(b: typeof schema.bookings.$inferSelect) {
  const t = tdb(b.companyId);
  const svc = await t.selectOne(schema.services, eq(schema.services.id, b.serviceId));

  // Company (tenant) contact info — shown on the public page so a client can
  // reach the company directly, especially once the job is complete and the
  // live map is no longer relevant.
  const [co] = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.id, b.companyId));
  // tenant settings carry brand vocabulary (what they call their field worker)
  const cs = await t.selectOne(schema.companySettings);
  const workerNoun = cs?.workerNoun || "Technician";
  const company = co
    ? { name: co.name, email: co.contactEmail || "", phone: co.phone || "" }
    : null;

  let tech: any = null;
  if (b.riderId) {
    const r = await t.selectOne(schema.riders, eq(schema.riders.id, b.riderId));
    if (r) {
      const [ru] = await db
        .select()
        .from(schema.user)
        .where(eq(schema.user.id, r.userId));
      tech = {
        name: ru?.name,
        phone: r.phone || ru?.phone || "",
        vehicle: r.vehicle,
        rating: r.rating,
        skillClass: r.skillClass,
        color: r.color,
        photoUrl: r.photoUrl,
        lat: r.lat,
        lng: r.lng,
      };
    }
  }

  const latestRows = await t.select(
    schema.trackingPings,
    eq(schema.trackingPings.bookingId, b.id),
  );
  latestRows.sort((a, z) => Number(z.createdAt) - Number(a.createdAt));
  const latest = latestRows[0];

  const techLocation = latest
    ? { lat: latest.lat, lng: latest.lng }
    : tech?.lat
      ? { lat: tech.lat, lng: tech.lng }
      : null;

  let route: { lat: number; lng: number }[] | null = null;
  let etaMins = b.etaMins;
  let etaDistanceKm = b.etaDistanceKm ?? null;
  if (
    techLocation &&
    ["assigned", "enroute"].includes(b.status) &&
    b.lat != null &&
    b.lng != null
  ) {
    const r = await cachedRoute(b.id, techLocation.lat, techLocation.lng, b.lat, b.lng);
    if (r) {
      route = r.path.map(([lat, lng]) => ({ lat, lng }));
      etaMins = r.etaMins;
      etaDistanceKm = r.distanceKm;
    }
  }

  // ── Customer-facing job history ─────────────────────────────────────────
  // Only events flagged customerVisible (policy lives in services/job-events.ts)
  // so internal activity — declines, staff notes — never leaks to the client.
  const timeline = await jobTimeline(b.id, { onlyCustomerVisible: true });

  const photoRows = await t.select(
    schema.jobPhotos,
    eq(schema.jobPhotos.bookingId, b.id),
  );
  photoRows.sort((a, z) => Number(a.createdAt) - Number(z.createdAt));
  // Office-only shots (customerVisible = false) never reach this page.
  const photos = photoRows
    .filter((p) => p.customerVisible !== false)
    .map((p) => ({
      id: p.id,
      url: p.url,
      caption: p.caption,
      phase: p.phase || "during",
      at: p.createdAt,
    }));

  // Materials/services used — WHAT was done, deliberately WITHOUT pricing.
  // Invoicing is out of scope; this is a record of work, not a bill.
  let materials: { name: string; qty: number; unit: string }[] = [];
  try {
    const li = JSON.parse(b.lineItems || "[]");
    if (Array.isArray(li)) {
      materials = li
        .filter((x: any) => x?.name)
        .map((x: any) => ({
          name: String(x.name),
          qty: Number(x.qty) || 1,
          unit: String(x.unit || ""),
        }));
    }
  } catch {
    /* malformed lineItems — show nothing rather than break the page */
  }

  // Persistent property hub link, so the customer can reach their full
  // service history for this address from any single job.
  let propertyLink: string | null = null;
  if (b.propertyId) {
    const [prop] = await db
      .select()
      .from(schema.properties)
      .where(eq(schema.properties.id, b.propertyId));
    if (prop) propertyLink = propertyUrl(prop.publicToken);
  }

  return {
    id: b.id,
    token: b.publicToken,
    title: b.title || svc?.name || "Service",
    status: b.status,
    timeline,
    photos,
    materials,
    // customer's own sign-off, shown back to them on the permanent record
    signature: b.signedAt
      ? { url: b.signatureUrl, name: b.signatureName, at: b.signedAt }
      : null,
    propertyLink,
    // Running late — shown ONLY once the office has actually told them. The
    // dispatcher gets first refusal on every notice, so a customer must never
    // read a delay on this page that nobody has decided to send yet. It also
    // disappears the moment the tech is on site: they can see the van.
    delay:
      b.delayNotifiedAt && DELAY_VISIBLE_STATUSES.has(b.status)
        ? {
            mins: b.delayNotifiedMins ?? 0,
            at: Number(b.delayNotifiedAt),
            revisedAt: b.scheduledAt
              ? Number(b.scheduledAt) + (b.delayNotifiedMins ?? 0) * 60_000
              : null,
          }
        : null,
    scheduledAt: b.scheduledAt,
    // The company's clock. The page used to format every time on the DEVICE's
    // clock with no zone label, so an out-of-town property owner opening the
    // SMS link saw an appointment time that was hours off what the office told
    // them, with nothing on screen to explain it.
    timezone: safeTimeZone(cs?.timezone),
    startedAt: b.startedAt,
    finishedAt: b.finishedAt,
    onSiteMinutes: b.onSiteMinutes,
    address: b.address,
    etaMins,
    etaDistanceKm,
    service: svc ? { name: svc.name, icon: svc.icon } : null,
    company,
    workerNoun,
    destination: { lat: b.lat, lng: b.lng, address: b.address },
    tech,
    techLocation,
    route,
  };
}

/**
 * PUBLIC tracking — accessed via SMS link /t/:token, no auth required.
 * Exposes only what a client needs to track + contact their technician.
 */
export const trackRoutes = new Hono()
  // public live tracking by token (snapshot — also used as SSE fallback)
  .get("/:token", trackLimiter, async (c) => {
    const token = c.req.param("token");
    const b = await resolveByToken(token);
    if (!b) return c.json({ message: "Not found" }, 404);
    return c.json(await buildSnapshot(b), 200);
  })
  // SSE live stream — pushes a fresh snapshot on every driver ping / status
  // change instead of the client polling every 2.5s. Falls back gracefully:
  // clients that can't hold the stream still have GET /:token.
  .get("/:token/stream", async (c) => {
    const token = c.req.param("token");
    const b = await resolveByToken(token);
    if (!b) return c.json({ message: "Not found" }, 404);

    return streamSSE(c, async (stream) => {
      // initial snapshot immediately so the map paints without waiting
      const snap = await buildSnapshot(b);
      await stream.writeSSE({ event: "snapshot", data: JSON.stringify(snap) });

      // All socket writes happen on this main async loop. Hono's streamSSE does
      // not reliably flush writes issued from a detached setInterval while the
      // generator is parked, so the realtime callback only flips a dirty flag
      // and the loop drains it on its next tick.
      let closed = false;
      let dirty = false;
      const unsub = subscribeTrack(token, () => {
        dirty = true; // coalesced: only the newest snapshot matters
      });
      stream.onAbort(() => {
        closed = true;
        unsub();
      });

      const TICK_MS = 1_000;
      const PING_EVERY = 20; // ticks → 20s heartbeat
      let sinceData = 0;
      while (!closed) {
        await stream.sleep(TICK_MS);
        if (closed) break;
        if (dirty) {
          dirty = false;
          const fresh = await resolveByToken(token);
          if (fresh) {
            const s = await buildSnapshot(fresh);
            await stream.writeSSE({ event: "snapshot", data: JSON.stringify(s) });
            sinceData = 0;
            continue;
          }
        }
        if (++sinceData >= PING_EVERY) {
          sinceData = 0;
          await stream.writeSSE({ event: "ping", data: "1" });
        }
      }
    });
  })
  // public message thread for a tracked work order
  .get("/:token/messages", trackLimiter, async (c) => {
    const token = c.req.param("token");
    const b = await resolveByToken(token);
    if (!b) return c.json({ message: "Not found" }, 404);
    const rows = await tdb(b.companyId).select(
      schema.messages,
      eq(schema.messages.bookingId, b.id),
    );
    rows.sort((a, z) => Number(a.createdAt) - Number(z.createdAt));
    return c.json({ messages: rows }, 200);
  })
  // ── Public review (no auth) — customer rates job after completion ───────
  // POST /api/track/:token/review { rating: 1-5, comment?: string }
  .post("/:token/review", trackWriteLimiter, async (c) => {
    const token = c.req.param("token");
    const b = await resolveByToken(token);
    if (!b) return c.json({ message: "Not found" }, 404);
    if (b.status !== "completed") return c.json({ message: "Job not yet complete" }, 400);
    const json = await safeJson(c);
    if (!json) return c.json({ message: "Invalid request body" }, 400);
    const r = readRating(json.rating);
    if (r == null) return c.json({ message: "Rating must be a whole number from 1 to 5" }, 400);
    // Comment is optional; when present it must be a sane string. A raw
    // `comment?.trim()` accepted 60 KB of anything and stored it verbatim.
    let comment = "";
    if (json.comment != null && json.comment !== "") {
      const parsed = readText(json.comment, MAX_MESSAGE_CHARS);
      if (!parsed.ok) {
        if (parsed.reason === "long")
          return c.json({ message: `Comment is too long (max ${MAX_MESSAGE_CHARS} characters)` }, 400);
        if (parsed.reason === "type")
          return c.json({ message: "Comment must be text" }, 400);
      } else comment = parsed.value;
    }
    const t = tdb(b.companyId);
    // idempotent: only one review per booking from the tracking page
    const existing = await t.selectOne(schema.reviews, eq(schema.reviews.bookingId, b.id));
    if (existing) return c.json({ review: existing }, 200);
    const [rev] = await t.insert(schema.reviews, {
      bookingId: b.id,
      customerId: b.customerId || undefined,
      riderId: b.riderId || null,
      rating: r,
      comment,
    });
    // Bump the rider's average rating. Only finite stored ratings count, and the
    // write is skipped if the average somehow isn't a number — a single bad row
    // must never overwrite a technician's rating with NaN.
    if (b.riderId) {
      const all = await t.select(schema.reviews, eq(schema.reviews.riderId, b.riderId));
      const valid = all.filter((x) => Number.isFinite(Number(x.rating)));
      if (valid.length) {
        const avg = valid.reduce((s, x) => s + Number(x.rating), 0) / valid.length;
        if (Number.isFinite(avg))
          await t.update(schema.riders, { rating: Math.round(avg * 10) / 10 }, eq(schema.riders.id, b.riderId));
      }
    }
    // Reputation routing: 4-5 stars get offered the tenant's public review
    // link; 3 or below never do — they raise a private alert to the office so
    // it can be fixed before it becomes a public complaint. Either way the
    // rating itself is stored and visible in admin.
    let publicUrl: string | null = null;
    try {
      const routing = await reviewRouting(b.companyId, r);
      publicUrl = routing.publicUrl;
      if (routing.escalate) {
        await alertLowRating({
          companyId: b.companyId,
          bookingId: b.id,
          rating: r,
          comment,
          jobTitle: b.title || "Job",
        });
      }
    } catch (e) {
      console.error("[track] review routing failed", e);
    }

    return c.json({ review: rev, publicReviewUrl: publicUrl }, 201);
  })
  // client posts a message from the public tracking page
  .post("/:token/messages", trackWriteLimiter, async (c) => {
    const token = c.req.param("token");
    const json = await safeJson(c);
    if (!json) return c.json({ message: "Invalid request body" }, 400);
    const parsed = readText(json.body, MAX_MESSAGE_CHARS);
    if (!parsed.ok)
      return c.json(
        {
          message:
            parsed.reason === "long"
              ? `Message is too long (max ${MAX_MESSAGE_CHARS} characters)`
              : parsed.reason === "type"
                ? "Message must be text"
                : "Message can't be empty",
        },
        400,
      );
    const body = parsed.value;
    const nameParsed = readText(json.senderName, MAX_SENDER_NAME_CHARS);
    const senderName = nameParsed.ok ? nameParsed.value : "Client";
    const b = await resolveByToken(token);
    if (!b) return c.json({ message: "Not found" }, 404);
    const t = tdb(b.companyId);
    const [m] = await t.insert(schema.messages, {
      bookingId: b.id,
      senderRole: "client",
      senderName,
      body,
      channel: "app",
    });
    // in-app notify + text the assigned technician so they get a real SMS
    if (b.riderId) {
      const r = await t.selectOne(schema.riders, eq(schema.riders.id, b.riderId));
      if (r) {
        await t.insert(schema.notifications, {
          userId: r.userId,
          bookingId: b.id,
          type: "reminder",
          title: "New message from client",
          body,
        });
        // forward to the tech as an SMS with a link back to the live thread
        const [ru] = await db
          .select()
          .from(schema.user)
          .where(eq(schema.user.id, r.userId));
        const techPhone = r.phone || ru?.phone || "";
        if (techPhone && b.publicToken) {
          const who = m.senderName || "Customer";
          // Only a preview goes into the SMS. The full message is always in the
          // thread the link opens; billing a 15-segment text for a wall of copy
          // (or letting anyone with the link do that on purpose) is not worth it.
          const preview =
            body.length > SMS_PREVIEW_CHARS
              ? `${body.slice(0, SMS_PREVIEW_CHARS)}…`
              : body;
          await sendSms(
            techPhone,
            `NVC360: Message from ${who}: "${preview}" — Reply: ${trackingUrl(b.publicToken)}`,
          ).catch(() => {});
        }
      }
    }

    // The office has to see homeowner replies too. Previously this only ever
    // reached the assigned tech, so a message sent from the public tracking
    // page never surfaced anywhere in admin — it just sat in the thread.
    // Scoped to THIS booking's tenant only; never notify across tenants.
    try {
      const admins = await db
        .select()
        .from(schema.user)
        .where(
          and(
            inArray(schema.user.role, ["admin", "superadmin"]),
            eq(schema.user.companyId, b.companyId),
          ),
        );
      for (const admin of admins) {
        await t.insert(schema.notifications, {
          userId: admin.id,
          bookingId: b.id,
          type: "reminder",
          title: `Customer message on ${b.title || "job"}`,
          body,
        });
      }
    } catch (e) {
      // never fail the customer's message because notifying the office failed
      console.error("[track] office notify failed", e);
    }

    publishMsg("job", b.id).catch(() => {});
    publishMsg("inbox", b.companyId).catch(() => {});
    return c.json({ message: m }, 201);
  });
