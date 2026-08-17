import * as schema from "../api/database/schema";
import { eq } from "drizzle-orm";
import { tdb } from "../api/database/tenant";
import { fireEvent } from "./dispatch";
import { recomputeBooking, accrueTechPay } from "./billing";
import { reconcileRiderStatus } from "./presence";
import { publishTrack } from "./realtime";
import { pushLiveActivityJobUpdate } from "./apns";

const EVENT_FOR_STATUS: Record<string, any> = {
  confirmed: "created",
  assigned: "assigned",
  enroute: "enroute",
  arrived: "arrived",
  in_progress: "started",
  completed: "completed",
  cancelled: "cancelled",
};

/**
 * Single authoritative entry point for booking status transitions.
 * Used by the manual status endpoint AND the geofence auto-arrive/clock logic,
 * so notifications, SMS, mileage and on-site time stay consistent no matter
 * what triggered the change.
 *
 * On-site time is accumulated across pause/resume cycles (geofence enter/exit),
 * not just startedAt -> finishedAt, so leaving the site stops the clock.
 */
export async function applyBookingStatus(
  companyId: string,
  id: string,
  status: string,
  opts: { fireNotifications?: boolean } = {},
) {
  const t = tdb(companyId);
  const fireNotifications = opts.fireNotifications ?? true;
  const prevB = await t.selectOne(schema.bookings, eq(schema.bookings.id, id));
  if (!prevB) return null;

  const now = new Date();
  const extra: Record<string, unknown> = { status };

  // mileage begins the moment the tech taps "on my way" (enroute)
  if (status === "enroute" && !prevB.enrouteAt) {
    extra.enrouteAt = now;
    extra.mileageKm = 0;
  }

  // arriving on site = clock STARTS running (first time only)
  if (status === "arrived") {
    if (!prevB.startedAt) {
      extra.startedAt = now;
      // finalize drive time: elapsed from "Start Driving" to this first
      // arrival. One-shot, like onSiteMinutes is finalized once on
      // completion — transit doesn't pause/resume, it's just the drive there.
      if (prevB.enrouteAt) {
        extra.transitMinutes = Math.max(0, Math.round(((now.getTime() - new Date(prevB.enrouteAt).getTime()) / 60000) * 10) / 10);
      }
    }
    // start the geofenced clock if it isn't already running
    if (prevB.clockState !== "running") {
      extra.clockState = "running";
      extra.lastResumeAt = now;
      extra.insideGeofence = true;
    }
  }

  // in_progress kept for compatibility — also ensures the clock is running
  if (status === "in_progress") {
    if (!prevB.startedAt) {
      extra.startedAt = now;
      if (prevB.enrouteAt) {
        extra.transitMinutes = Math.max(0, Math.round(((now.getTime() - new Date(prevB.enrouteAt).getTime()) / 60000) * 10) / 10);
      }
    }
    if (prevB.clockState !== "running") {
      extra.clockState = "running";
      extra.lastResumeAt = now;
    }
  }

  if (status === "completed") {
    extra.finishedAt = now;
    // The tracking link becomes the customer's PERMANENT job record once the
    // work is done — it stops being a live-location link (which is what the
    // expiry was protecting) and becomes their receipt of what was done, by
    // whom, with photos. Clearing the expiry is what makes "one conversation,
    // forever" true instead of a link that dies in 24h.
    extra.tokenExpiresAt = null;
    // finalize banked time: add the currently-running segment, if any
    let totalMs = prevB.accumulatedMs ?? 0;
    if (prevB.clockState === "running" && prevB.lastResumeAt) {
      totalMs += now.getTime() - new Date(prevB.lastResumeAt).getTime();
    }
    extra.accumulatedMs = totalMs;
    extra.clockState = "idle";
    extra.lastResumeAt = null;
    extra.insideGeofence = false;
    extra.onSiteMinutes = Math.max(0, Math.round((totalMs / 60000) * 10) / 10);
  }

  const [b] = await t.update(schema.bookings, extra, eq(schema.bookings.id, id));
  if (!b) return null;

  if (status === "completed") {
    await recomputeBooking(companyId, id);
    await accrueTechPay(companyId, id);
  }

  if (fireNotifications) {
    const dispatchEvent = EVENT_FOR_STATUS[status];
    if (dispatchEvent) await fireEvent(dispatchEvent, id);
  }

  // rider presence + sms timestamp side-effects
  if (status === "enroute") {
    // public tracking link becomes valid now and expires after a bounded
    // window so a leaked SMS link can't expose tech location indefinitely.
    const trackTtlH = Number(process.env.TRACK_LINK_TTL_HOURS ?? 24);
    await t.update(
      schema.bookings,
      { smsSentAt: now, tokenExpiresAt: new Date(Date.now() + trackTtlH * 3600_000) },
      eq(schema.bookings.id, id),
    );
    if (b.riderId) {
      await t.update(schema.riders, { status: "enroute" }, eq(schema.riders.id, b.riderId));
    }
  }
  if ((status === "arrived" || status === "in_progress") && b.riderId) {
    await t.update(schema.riders, { status: "onsite" }, eq(schema.riders.id, b.riderId));
  }
  if (status === "completed" && b.riderId) {
    await t.update(schema.riders, { status: "available" }, eq(schema.riders.id, b.riderId));
  }
  if (b.riderId && !["enroute", "arrived", "in_progress", "assigned"].includes(status)) {
    await reconcileRiderStatus(companyId, b.riderId);
  }

  // push status change to live SSE subscribers on the public tracking page
  if (b.publicToken) {
    void publishTrack({ type: "status", token: b.publicToken, data: { status } });
  }

  // push Live Activity update to driver's Dynamic Island / lock screen (iOS)
  void pushLiveActivityJobUpdate({
    id: b.id,
    fieldData: b.fieldData,
    status,
    etaMins: b.etaMins ?? null,
    customerName: (b as any).customerName ?? null,
    address: b.address ?? null,
  });

  return b;
}

/**
 * Pause the on-site clock without changing job status — fired when the tech
 * physically leaves the geofence. Banks the elapsed running segment.
 */
export async function pauseClock(companyId: string, id: string) {
  const t = tdb(companyId);
  const b = await t.selectOne(schema.bookings, eq(schema.bookings.id, id));
  if (!b || b.clockState !== "running") return b ?? null;
  const now = Date.now();
  const elapsed = b.lastResumeAt ? now - new Date(b.lastResumeAt).getTime() : 0;
  const [updated] = await t.update(
    schema.bookings,
    {
      clockState: "paused",
      accumulatedMs: (b.accumulatedMs ?? 0) + Math.max(0, elapsed),
      lastResumeAt: null,
      insideGeofence: false,
    },
    eq(schema.bookings.id, id),
  );
  return updated;
}

/**
 * Resume the on-site clock when the tech re-enters the geofence after leaving.
 */
export async function resumeClock(companyId: string, id: string) {
  const t = tdb(companyId);
  const b = await t.selectOne(schema.bookings, eq(schema.bookings.id, id));
  if (!b || b.clockState === "running") return b ?? null;
  const [updated] = await t.update(
    schema.bookings,
    { clockState: "running", lastResumeAt: new Date(), insideGeofence: true },
    eq(schema.bookings.id, id),
  );
  return updated;
}

/** Live elapsed on-site minutes including the currently running segment. */
// Re-exported from the pure shared module so callers importing it from here keep
// working; the math itself lives in `shared/clock.ts` (no DB import chain).
export { liveOnSiteMinutes } from "../shared/clock";
