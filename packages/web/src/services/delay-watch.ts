/**
 * Running-late watch — server side.
 *
 * The decision of whether a job is late lives in shared/delay-policy.ts (pure,
 * shared with the admin screen). This module is the only place that writes the
 * flag or sends the notice, so a dispatcher pressing "Send now" and the
 * automatic sweep produce exactly the same message and the same audit trail.
 *
 * Runs once a minute against every tenant with the feature on. Cheap by
 * construction: it only looks at bookings in a live status whose promised time
 * is inside a bounded window, not the whole table.
 */
import { db } from "../api/database";
import { tdb } from "../api/database/tenant";
import * as schema from "../api/database/schema";
import { and, eq, gte, lte, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  evaluateDelay,
  roundedSlip,
  DEFAULT_DELAY_POLICY,
  type DelayPolicy,
  type DelayDecision,
} from "../shared/delay-policy";
import { fireEvent, ensureEventRules } from "./dispatch";
import { incr } from "../api/lib/metrics";

/** Statuses worth loading at all — mirrors WATCHED_STATUSES in the evaluator. */
const LIVE_STATUSES = ["pending", "confirmed", "assigned", "accepted", "enroute"];

/**
 * How far back to keep watching. A job eight hours past its slot is not a
 * "running late" text, it's a conversation — and re-texting yesterday's
 * forgotten job at 3am is exactly the kind of thing that loses a customer.
 */
const LOOKBACK_MS = 8 * 60 * 60_000;
/** How far ahead to look, so an ETA overrun is caught before the slot passes. */
const LOOKAHEAD_MS = 2 * 60 * 60_000;

export async function delayPolicyFor(companyId: string): Promise<DelayPolicy> {
  const [row] = await db
    .select({
      enabled: schema.companySettings.delayNoticeEnabled,
      thresholdMins: schema.companySettings.delayNoticeThresholdMins,
      autoSendAfterMins: schema.companySettings.delayNoticeAutoSendAfterMins,
    })
    .from(schema.companySettings)
    .where(eq(schema.companySettings.companyId, companyId))
    .limit(1);
  if (!row) return { ...DEFAULT_DELAY_POLICY };
  return {
    enabled: !!row.enabled,
    thresholdMins: Number(row.thresholdMins ?? DEFAULT_DELAY_POLICY.thresholdMins),
    autoSendAfterMins: Number(row.autoSendAfterMins ?? DEFAULT_DELAY_POLICY.autoSendAfterMins),
  };
}

type BookingRow = typeof schema.bookings.$inferSelect;

/** Run the evaluator against one already-loaded booking row. */
export function decideFor(b: BookingRow, policy: DelayPolicy, now = Date.now()): DelayDecision {
  return evaluateDelay({
    now,
    scheduledAt: b.scheduledAt ? Number(b.scheduledAt) : null,
    status: b.status,
    etaMins: b.etaMins ?? null,
    policy,
    flaggedAt: b.delayFlaggedAt ? Number(b.delayFlaggedAt) : null,
    notifiedAt: b.delayNotifiedAt ? Number(b.delayNotifiedAt) : null,
    notifiedMins: b.delayNotifiedMins ?? null,
    muted: !!b.delayMuted,
  });
}

/**
 * Send the notice for one booking and record that we did.
 *
 * The slip is written to the row BEFORE firing, because the message copy reads
 * it back off the booking (dispatch context()) to quote a revised arrival time.
 * Rounded on the way in so the number the customer was told and the number we
 * logged are the same one.
 *
 * COMPARE-AND-SET, and this matters more than it looks. The minute sweep and a
 * dispatcher pressing "Send now" are independent writers: both read the
 * booking, both see delay_notified_at empty, both decide to send — and the
 * customer gets two "we're running late" texts about one job. So the caller
 * passes the delay_notified_at it READ, and the write only lands while the row
 * still says that. The loser returns ok:false and never fires. The claim and
 * the send are in that order on purpose: a duplicate text is a support call, a
 * missed one is caught by the next sweep 60 seconds later.
 */
export async function sendDelayNotice(opts: {
  companyId: string;
  bookingId: string;
  slipMins: number;
  actor?: string;
  /**
   * The row's delay_notified_at as the caller read it (null = never told).
   * Omit only from a context where no other writer can exist.
   */
  expectNotifiedAt?: number | null;
}): Promise<{ ok: boolean; notifiedMins: number; reason?: "already-sent" }> {
  const rounded = roundedSlip(opts.slipMins);
  const now = new Date();

  const guard =
    opts.expectNotifiedAt === undefined
      ? undefined
      : opts.expectNotifiedAt === null
        ? isNull(schema.bookings.delayNotifiedAt)
        : eq(schema.bookings.delayNotifiedAt, new Date(opts.expectNotifiedAt));
  const where = guard
    ? and(eq(schema.bookings.id, opts.bookingId), guard)
    : eq(schema.bookings.id, opts.bookingId);

  const claimed = await tdb(opts.companyId).update(
    schema.bookings,
    {
      delayNotifiedAt: now,
      delayNotifiedMins: rounded,
      delayFlaggedAt: now, // keep the board showing it, with a fresh clock
      delayFlaggedMins: rounded,
    },
    where,
  );
  // Nothing matched: another writer got there first (or it isn't our tenant's
  // booking). Either way, say nothing to the customer.
  if (!claimed.length) {
    incr("delay_notice_raced_total");
    return { ok: false, notifiedMins: 0, reason: "already-sent" };
  }

  // A tenant provisioned before this event existed has no rules for it, and
  // would silently notify nobody.
  await ensureEventRules(opts.companyId, "delayed");
  await fireEvent("delayed", opts.bookingId);
  incr("delay_notice_sent_total");
  return { ok: true, notifiedMins: rounded };
}

/** Dispatch handled it themselves — stop the automatic notice, keep watching. */
export async function muteDelay(companyId: string, bookingId: string, muted: boolean) {
  await tdb(companyId).update(
    schema.bookings,
    { delayMuted: muted },
    eq(schema.bookings.id, bookingId),
  );
  incr(muted ? "delay_muted_total" : "delay_unmuted_total");
}

/** Everything currently flagged as running late, newest slip first. */
export async function listDelays(companyId: string) {
  const rows = await tdb(companyId).select(
    schema.bookings,
    and(
      isNotNull(schema.bookings.delayFlaggedAt),
      inArray(schema.bookings.status, LIVE_STATUSES),
    ),
  );
  const policy = await delayPolicyFor(companyId);
  const now = Date.now();
  const out = rows.map((b) => {
    const d = decideFor(b, policy, now);
    return {
      bookingId: b.id,
      shortId: b.id.slice(0, 6).toUpperCase(),
      title: b.title,
      address: b.address,
      status: b.status,
      scheduledAt: b.scheduledAt ? Number(b.scheduledAt) : null,
      riderId: b.riderId,
      etaMins: b.etaMins ?? null,
      slipMins: d.slipMins,
      reason: d.reason,
      muted: !!b.delayMuted,
      flaggedAt: b.delayFlaggedAt ? Number(b.delayFlaggedAt) : null,
      notifiedAt: b.delayNotifiedAt ? Number(b.delayNotifiedAt) : null,
      notifiedMins: b.delayNotifiedMins ?? null,
      autoSendAt: d.autoSendAt,
    };
  });
  out.sort((a, b) => b.slipMins - a.slipMins);
  return out;
}

/** How many flagged jobs the customer hasn't been told about yet. */
export async function pendingDelayCount(companyId: string): Promise<number> {
  const rows = await listDelays(companyId);
  return rows.filter((r) => !r.notifiedAt && !r.muted).length;
}

/**
 * One pass over every tenant. Returns what it did, for the log and for tests.
 *
 * Deliberately tolerant: one tenant's bad row must never stop the sweep for
 * everyone else, because the failure mode of this feature is silence — exactly
 * the thing it exists to prevent.
 */
export async function sweepDelays(now: Date = new Date()): Promise<{
  flagged: number;
  notified: number;
  cleared: number;
}> {
  const result = { flagged: 0, notified: 0, cleared: 0 };
  const nowMs = now.getTime();
  try {
    const companies = await db
      .select({
        companyId: schema.companySettings.companyId,
        enabled: schema.companySettings.delayNoticeEnabled,
        thresholdMins: schema.companySettings.delayNoticeThresholdMins,
        autoSendAfterMins: schema.companySettings.delayNoticeAutoSendAfterMins,
      })
      .from(schema.companySettings);

    for (const co of companies) {
      if (!co.enabled) continue;
      const policy: DelayPolicy = {
        enabled: true,
        thresholdMins: Number(co.thresholdMins ?? DEFAULT_DELAY_POLICY.thresholdMins),
        autoSendAfterMins: Number(
          co.autoSendAfterMins ?? DEFAULT_DELAY_POLICY.autoSendAfterMins,
        ),
      };
      try {
        const rows = await tdb(co.companyId).select(
          schema.bookings,
          and(
            inArray(schema.bookings.status, LIVE_STATUSES),
            gte(schema.bookings.scheduledAt, new Date(nowMs - LOOKBACK_MS)),
            lte(schema.bookings.scheduledAt, new Date(nowMs + LOOKAHEAD_MS)),
          ),
        );

        for (const b of rows) {
          const d = decideFor(b, policy, nowMs);
          if (d.action === "flag") {
            await tdb(co.companyId).update(
              schema.bookings,
              { delayFlaggedAt: new Date(nowMs), delayFlaggedMins: d.slipMins },
              eq(schema.bookings.id, b.id),
            );
            result.flagged++;
            incr("delay_flagged_total");
          } else if (d.action === "clear") {
            await tdb(co.companyId).update(
              schema.bookings,
              { delayFlaggedAt: null, delayFlaggedMins: null, delayMuted: false },
              eq(schema.bookings.id, b.id),
            );
            result.cleared++;
          } else if (d.action === "notify") {
            const sent = await sendDelayNotice({
              companyId: co.companyId,
              bookingId: b.id,
              slipMins: d.slipMins,
              // The row as this pass read it — an overlapping sweep or a
              // dispatcher's click since then wins, and we stay quiet.
              expectNotifiedAt: b.delayNotifiedAt ? Number(b.delayNotifiedAt) : null,
            });
            if (sent.ok) result.notified++;
          }
        }
      } catch (e) {
        console.error(`[delay-watch] sweep failed for ${co.companyId}`, e);
      }
    }
  } catch (e) {
    console.error("[delay-watch] sweep failed", e);
  }
  return result;
}
