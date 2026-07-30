import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq } from "drizzle-orm";
import { requireAuth, tx, tenantId } from "../middleware/auth";
import { computeEta, computeRoute } from "./geo";
import { haversineKm, isInsideGeofence } from "../../shared/geo-distance";
import { applyBookingStatus, pauseClock, resumeClock } from "../../services/booking-status";
import { pingLimiter } from "../lib/rate-limit";
import { publishTrack } from "../../services/realtime";
import { isAdminRole } from "../lib/permissions";

// throttle ETA recomputation per booking (avoid hammering Distance Matrix)
const ETA_THROTTLE_MS = 30_000;
const lastEtaAt = new Map<string, number>();

// road-route cache for the authed customer track view (mirror of public route)
const AUTH_ROUTE_TTL_MS = 12_000;
const authRouteCache = new Map<
  string,
  { at: number; oLat: number; oLng: number; route: Awaited<ReturnType<typeof computeRoute>> }
>();
async function cachedAuthRoute(id: string, oLat: number, oLng: number, dLat: number, dLng: number) {
  const now = Date.now();
  const c = authRouteCache.get(id);
  if (c) {
    const moved = Math.abs(c.oLat - oLat) > 0.0011 || Math.abs(c.oLng - oLng) > 0.0011;
    if (now - c.at < AUTH_ROUTE_TTL_MS && !moved) return c.route;
  }
  const route = await computeRoute(oLat, oLng, dLat, dLng);
  authRouteCache.set(id, { at: now, oLat, oLng, route });
  return route;
}

export const trackingRoutes = new Hono()
  // rider posts a live location ping for a booking
  .post("/:bookingId/ping", pingLimiter, requireAuth, async (c) => {
    const bookingId = c.req.param("bookingId");
    const { lat, lng } = await c.req.json();
    const t = tx(c);

    // ping = tech's live location. The booking's lat/lng is the JOB destination
    // and must NOT be overwritten. Live location lives on rider + pings.
    const b = await t.selectOne(schema.bookings, eq(schema.bookings.id, bookingId));

    // phase for mileage segmentation: enroute / onsite / return
    const phase = b?.status === "completed" ? "return" : b?.status === "in_progress" || b?.status === "arrived" ? "onsite" : "enroute";

    // accumulate mileage from the previous ping (great-circle, jitter-filtered)
    const prevRows = await t.select(
      schema.trackingPings,
      eq(schema.trackingPings.bookingId, bookingId),
    );
    prevRows.sort((a, z) => Number(z.createdAt) - Number(a.createdAt));
    const prev = prevRows[0];
    await t.insert(schema.trackingPings, { bookingId, lat, lng, phase });

    if (b && prev && b.enrouteAt) {
      // count distance for the whole active trip: enroute -> onsite -> return,
      // starting the moment the tech tapped "on my way" (enrouteAt is set).
      const seg = haversineKm(prev.lat, prev.lng, lat, lng);
      if (seg > 0.005 && seg < 5) {
        await t.update(
          schema.bookings,
          { mileageKm: Math.round((b.mileageKm + seg) * 100) / 100 },
          eq(schema.bookings.id, bookingId),
        );
      }
    }

    if (b?.riderId) {
      await t.update(
        schema.riders,
        { lat, lng, locationUpdatedAt: new Date() },
        eq(schema.riders.id, b.riderId),
      );
    }

    // --- GEOFENCE: auto-arrive + clock pause/resume -------------------------
    // Authoritative on the server. Once the tech is enroute (or already on a
    // job), entering the radius around the job address auto-arrives them and
    // starts the clock; leaving the radius pauses the clock; re-entering
    // resumes it. Completion stays manual.
    if (b && b.lat != null && b.lng != null && b.enrouteAt && b.status !== "completed" && b.status !== "cancelled") {
      // configured radius (meters) -> km, default 20m
      const settings = await t.selectOne(schema.companySettings);
      const radiusM = (settings?.geofenceRadiusM ?? 20) || 20;
      const inside = isInsideGeofence(lat, lng, b.lat, b.lng, radiusM);

      if (inside && !b.insideGeofence) {
        // entered the job site
        if (b.status === "enroute") {
          // first arrival → auto-arrive + start the job clock
          await applyBookingStatus(tenantId(c), bookingId, "arrived");
        } else {
          // came back after stepping away → resume the clock
          await resumeClock(tenantId(c), bookingId);
        }
      } else if (!inside && b.insideGeofence) {
        // left the job site → stop (pause) the clock
        await pauseClock(tenantId(c), bookingId);
      }
    }
    // -----------------------------------------------------------------------

    // recompute traffic-aware ETA from tech -> destination, throttled
    if (b) {
      const now = Date.now();
      const last = lastEtaAt.get(bookingId) ?? 0;
      if (now - last >= ETA_THROTTLE_MS) {
        lastEtaAt.set(bookingId, now);
        const eta = await computeEta(lat, lng, b.lat, b.lng);
        if (eta) {
          await t.update(
            schema.bookings,
            { etaMins: eta.etaMins, etaDistanceKm: eta.distanceKm },
            eq(schema.bookings.id, bookingId),
          );
        }
      }
    }

    // push to live SSE subscribers (public tracking page) — fire and forget
    if (b?.publicToken) {
      void publishTrack({ type: "location", token: b.publicToken, data: { lat, lng } });
    }

    // Return current etaMins so the mobile app can update Live Activity countdown
    const freshEta = (await t.selectOne(schema.bookings, eq(schema.bookings.id, bookingId)))?.etaMins ?? null;
    return c.json({ success: true, etaMins: freshEta }, 200);
  })
  // driver registers/refreshes Live Activity push token so server can send APNs updates
  .post("/:bookingId/live-activity-token", requireAuth, async (c) => {
    const bookingId = c.req.param("bookingId");
    const { token, type } = await c.req.json<{ token: string; type: "update" | "start" }>();
    if (!token) return c.json({ ok: false }, 400);
    const t = tx(c);
    // Store on the booking row (live_activity_token + push_to_start_token columns)
    // We use JSON extra field pattern (stored in bookings.customFields) to avoid migration
    const b = await t.selectOne(schema.bookings, eq(schema.bookings.id, bookingId));
    if (!b) return c.json({ ok: false, message: "Not found" }, 404);
    const cf = (b.customFields as Record<string, any>) ?? {};
    if (type === "start") {
      cf.__la_push_start_token = token;
    } else {
      cf.__la_push_update_token = token;
    }
    await t.update(schema.bookings, eq(schema.bookings.id, bookingId), { customFields: cf });
    return c.json({ ok: true });
  })
  // customer fetches latest rider location for a booking
  .get("/:bookingId", requireAuth, async (c) => {
    const bookingId = c.req.param("bookingId");
    const t = tx(c);
    const b = await t.selectOne(schema.bookings, eq(schema.bookings.id, bookingId));
    if (!b) return c.json({ message: "Not found" }, 404);

    let rider: any = null;
    if (b.riderId) {
      const r = await t.selectOne(schema.riders, eq(schema.riders.id, b.riderId));
      if (r) {
        const [ru] = await db
          .select()
          .from(schema.user)
          .where(eq(schema.user.id, r.userId));
        rider = {
          id: r.id,
          name: ru?.name,
          phone: ru?.phone,
          vehicle: r.vehicle,
          rating: r.rating,
          lat: r.lat,
          lng: r.lng,
        };
      }
    }
    const latestRows = await t.select(
      schema.trackingPings,
      eq(schema.trackingPings.bookingId, bookingId),
    );
    latestRows.sort((a, z) => Number(z.createdAt) - Number(a.createdAt));
    const latest = latestRows[0];

    const riderLocation = latest
      ? { lat: latest.lat, lng: latest.lng }
      : rider?.lat
        ? { lat: rider.lat, lng: rider.lng }
        : null;

    // road-following route + live ETA while en route
    let route: { lat: number; lng: number }[] | null = null;
    let etaMins = b.etaMins;
    if (riderLocation && ["assigned", "enroute"].includes(b.status) && b.lat != null && b.lng != null) {
      const r = await cachedAuthRoute(b.id, riderLocation.lat, riderLocation.lng, b.lat, b.lng);
      if (r) {
        route = r.path.map(([lat, lng]) => ({ lat, lng }));
        etaMins = r.etaMins;
      }
    }

    return c.json(
      {
        status: b.status,
        destination: { lat: b.lat, lng: b.lng },
        rider,
        riderLocation,
        route,
        etaMins,
      },
      200,
    );
  })

  // Full historical GPS breadcrumb trail for a booking — powers the route
  // map on the completed-job report. Distinct from the GET /:bookingId
  // above, which only returns the LATEST ping (for live tracking while a
  // job is still en route). Staff-only: this is an internal ops view, not
  // the customer-facing live-tracking page.
  .get("/:bookingId/route-history", requireAuth, async (c) => {
    const u = c.get("user") as { role?: string };
    if (!isAdminRole(u?.role) && u?.role !== "dispatcher") return c.json({ message: "Forbidden" }, 403);
    const bookingId = c.req.param("bookingId");
    const t = tx(c);
    const b = await t.selectOne(schema.bookings, eq(schema.bookings.id, bookingId));
    if (!b) return c.json({ message: "Not found" }, 404);
    const rows = await t.select(schema.trackingPings, eq(schema.trackingPings.bookingId, bookingId));
    rows.sort((a, z) => Number(a.createdAt) - Number(z.createdAt));
    return c.json(
      {
        pings: rows.map((r) => ({ lat: r.lat, lng: r.lng, phase: r.phase, createdAt: r.createdAt })),
        destination: b.lat != null && b.lng != null ? { lat: b.lat, lng: b.lng } : null,
      },
      200,
    );
  });
