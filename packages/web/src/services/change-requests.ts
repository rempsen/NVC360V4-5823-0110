/**
 * Customer-initiated appointment changes — server side.
 *
 * The decision of what a customer may do lives in shared/change-policy.ts (pure,
 * shared with the portal). This module is the only place that WRITES those
 * changes, so every path — customer portal today, mobile or an SMS reply later —
 * produces the same audit trail and the same notifications.
 *
 * Two rules this module exists to guarantee:
 *  1. A cancellation never touches the booking directly. It becomes a pending
 *     request; only an office decision cancels the job.
 *  2. Nothing is applied that the policy wouldn't allow, even if the caller
 *     hand-crafts the request — the screen and the API agree because they run
 *     the same evaluator.
 */
import { db } from "../api/database";
import { tdb } from "../api/database/tenant";
import * as schema from "../api/database/schema";
import { and, eq, desc, inArray } from "drizzle-orm";
import {
  evaluateChangePolicy,
  DEFAULT_CHANGE_POLICY,
  type ChangeDecision,
  type ChangePolicy,
} from "../shared/change-policy";
import { fireEvent, ensureEventRules } from "./dispatch";
import { logJobEvent } from "./job-events";
import { reconcileRiderStatus } from "./presence";
import { incr } from "../api/lib/metrics";

export type ChangeKind = "cancel" | "reschedule";

/** Statuses a request can be in. "applied" = a self-serve change, already done. */
export const OPEN_STATUS = "pending" as const;

/** Read the tenant's change policy from company_settings, falling back to defaults. */
export async function changePolicyFor(companyId: string): Promise<ChangePolicy> {
  const [row] = await db
    .select({
      allowCustomerReschedule: schema.companySettings.allowCustomerReschedule,
      allowCustomerCancelRequest: schema.companySettings.allowCustomerCancelRequest,
      customerChangeCutoffHours: schema.companySettings.customerChangeCutoffHours,
    })
    .from(schema.companySettings)
    .where(eq(schema.companySettings.companyId, companyId))
    .limit(1);
  if (!row) return { ...DEFAULT_CHANGE_POLICY };
  return {
    allowReschedule: !!row.allowCustomerReschedule,
    allowCancelRequest: !!row.allowCustomerCancelRequest,
    cutoffHours: Number(row.customerChangeCutoffHours ?? DEFAULT_CHANGE_POLICY.cutoffHours),
  };
}

/** The single open (pending) request on a booking, if any. */
export async function openRequestFor(companyId: string, bookingId: string) {
  const rows = await tdb(companyId).select(
    schema.bookingChangeRequests,
    and(
      eq(schema.bookingChangeRequests.bookingId, bookingId),
      eq(schema.bookingChangeRequests.status, OPEN_STATUS),
    ),
  );
  rows.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
  return rows[0] ?? null;
}

/** Policy + live state for one booking, as both the API and the portal see it. */
export async function changeStateFor(
  companyId: string,
  booking: { id: string; status: string; scheduledAt: Date | number | null },
): Promise<{
  decision: ChangeDecision;
  policy: ChangePolicy;
  openRequest: Awaited<ReturnType<typeof openRequestFor>>;
}> {
  const policy = await changePolicyFor(companyId);
  const decision = evaluateChangePolicy({
    status: booking.status,
    scheduledAt: booking.scheduledAt,
    policy,
  });
  const openRequest = await openRequestFor(companyId, booking.id);
  return { decision, policy, openRequest };
}

/** Shape the portal consumes — no Date objects, no internal columns. */
export function serializeState(s: Awaited<ReturnType<typeof changeStateFor>>) {
  return {
    reschedule: s.decision.reschedule,
    cancel: s.decision.cancel,
    withinCutoff: s.decision.withinCutoff,
    cutoffHours: s.decision.cutoffHours,
    blockedReason: s.decision.blockedReason,
    openRequest: s.openRequest
      ? {
          id: s.openRequest.id,
          kind: s.openRequest.kind,
          status: s.openRequest.status,
          reason: s.openRequest.reason,
          proposedAt: s.openRequest.proposedAt ? Number(s.openRequest.proposedAt) : null,
          createdAt: s.openRequest.createdAt ? Number(s.openRequest.createdAt) : null,
        }
      : null,
  };
}

/**
 * Record a request. Kept private-ish: the two public entry points below decide
 * whether a request is even permitted before anything is written.
 */
async function insertRequest(args: {
  companyId: string;
  bookingId: string;
  kind: ChangeKind;
  status: string;
  reason: string;
  requestedBy: string;
  requestedByName: string;
  proposedAt?: Date | null;
  previousAt?: Date | null;
}) {
  const [row] = await tdb(args.companyId).insert(schema.bookingChangeRequests, {
    bookingId: args.bookingId,
    kind: args.kind,
    status: args.status,
    reason: args.reason.slice(0, 2_000),
    requestedBy: args.requestedBy,
    requestedByName: args.requestedByName,
    proposedAt: args.proposedAt ?? null,
    previousAt: args.previousAt ?? null,
  });
  return row;
}

async function fire(companyId: string, event: "change_requested" | "change_declined" | "rescheduled", bookingId: string) {
  // A tenant provisioned before these events existed has no rules for them and
  // would deliver nothing at all. Backfill defaults first, then fire.
  await ensureEventRules(companyId, event);
  await fireEvent(event, bookingId);
}

export type ChangeOutcome =
  | { ok: true; mode: "applied"; request: typeof schema.bookingChangeRequests.$inferSelect; scheduledAt: number }
  | { ok: true; mode: "requested"; request: typeof schema.bookingChangeRequests.$inferSelect }
  | { ok: false; code: "blocked" | "conflict" | "invalid"; message: string };

/**
 * Customer asks to move their appointment.
 * Outside the cutoff (and enabled) it is applied immediately; inside the cutoff
 * it becomes a pending request. Either way it is recorded.
 */
export async function requestReschedule(args: {
  companyId: string;
  booking: typeof schema.bookings.$inferSelect;
  proposedAt: string | number | Date;
  reason: string;
  actorId: string;
  actorName: string;
}): Promise<ChangeOutcome> {
  const { companyId, booking } = args;
  const state = await changeStateFor(companyId, booking);
  if (state.openRequest)
    return {
      ok: false,
      code: "conflict",
      message: "You already have a change request in progress on this appointment.",
    };
  if (state.decision.reschedule === "blocked")
    return {
      ok: false,
      code: "blocked",
      message:
        state.decision.blockedReason ||
        "Rescheduling online isn't available for this appointment — please contact the office.",
    };
  if (!state.decision.isValidTarget(args.proposedAt))
    return { ok: false, code: "invalid", message: "Pick a new appointment time in the future." };

  const proposed = new Date(args.proposedAt);
  const previous = booking.scheduledAt ? new Date(Number(booking.scheduledAt)) : null;

  if (state.decision.reschedule === "request") {
    const row = await insertRequest({
      companyId,
      bookingId: booking.id,
      kind: "reschedule",
      status: "pending",
      reason: args.reason,
      requestedBy: args.actorId,
      requestedByName: args.actorName,
      proposedAt: proposed,
      previousAt: previous,
    });
    await fire(companyId, "change_requested", booking.id);
    incr("change_request_created_total");
    return { ok: true, mode: "requested", request: row };
  }

  // Self-serve: compare-and-set on the time we evaluated against, so a
  // dispatcher moving the job in the same second isn't silently overwritten.
  const [moved] = await tdb(companyId).update(
    schema.bookings,
    { scheduledAt: proposed },
    and(
      eq(schema.bookings.id, booking.id),
      eq(schema.bookings.status, booking.status),
      eq(schema.bookings.scheduledAt, new Date(Number(booking.scheduledAt))),
    ),
  );
  if (!moved)
    return {
      ok: false,
      code: "conflict",
      message: "This appointment just changed — reload and try again.",
    };
  const row = await insertRequest({
    companyId,
    bookingId: booking.id,
    kind: "reschedule",
    status: "applied",
    reason: args.reason,
    requestedBy: args.actorId,
    requestedByName: args.actorName,
    proposedAt: proposed,
    previousAt: previous,
  });
  await fire(companyId, "rescheduled", booking.id);
  incr("change_reschedule_self_serve_total");
  return { ok: true, mode: "applied", request: row, scheduledAt: proposed.getTime() };
}

/**
 * Customer asks to cancel. NEVER applied here — this only ever creates a pending
 * request for the office. That is the whole point: a job cannot leave the
 * dispatch board without someone at the company deciding it should.
 */
export async function requestCancel(args: {
  companyId: string;
  booking: typeof schema.bookings.$inferSelect;
  reason: string;
  actorId: string;
  actorName: string;
}): Promise<ChangeOutcome> {
  const { companyId, booking } = args;
  const state = await changeStateFor(companyId, booking);
  if (state.openRequest)
    return {
      ok: false,
      code: "conflict",
      message: "You already have a change request in progress on this appointment.",
    };
  if (state.decision.cancel === "blocked")
    return {
      ok: false,
      code: "blocked",
      message:
        state.decision.blockedReason ||
        "Please contact the office to cancel this appointment.",
    };
  const row = await insertRequest({
    companyId,
    bookingId: booking.id,
    kind: "cancel",
    status: "pending",
    reason: args.reason,
    requestedBy: args.actorId,
    requestedByName: args.actorName,
    previousAt: booking.scheduledAt ? new Date(Number(booking.scheduledAt)) : null,
  });
  await fire(companyId, "change_requested", booking.id);
  incr("change_request_created_total");
  return { ok: true, mode: "requested", request: row };
}

/** Office approves a pending request: this is where a booking actually changes. */
export async function approveRequest(args: {
  companyId: string;
  requestId: string;
  note: string;
  actorId: string;
  actorName: string;
}): Promise<
  | { ok: true; request: typeof schema.bookingChangeRequests.$inferSelect }
  | { ok: false; code: "not_found" | "conflict" | "invalid"; message: string }
> {
  const { companyId } = args;
  const t = tdb(companyId);
  const req = await t.selectOne(
    schema.bookingChangeRequests,
    eq(schema.bookingChangeRequests.id, args.requestId),
  );
  if (!req) return { ok: false, code: "not_found", message: "Request not found" };
  // Claim the row first (compare-and-set on status): two dispatchers hitting
  // approve at once must not both cancel the job / both move it.
  const [claimed] = await t.update(
    schema.bookingChangeRequests,
    {
      status: "approved",
      decidedBy: args.actorId,
      decidedByName: args.actorName,
      decidedAt: new Date(),
      decisionNote: args.note.slice(0, 2_000),
    },
    and(
      eq(schema.bookingChangeRequests.id, args.requestId),
      eq(schema.bookingChangeRequests.status, "pending"),
    ),
  );
  if (!claimed)
    return { ok: false, code: "conflict", message: "This request was already decided." };

  const booking = await t.selectOne(schema.bookings, eq(schema.bookings.id, req.bookingId));
  if (!booking) return { ok: false, code: "not_found", message: "Work order not found" };

  if (req.kind === "cancel") {
    await t.update(schema.bookings, { status: "cancelled" }, eq(schema.bookings.id, booking.id));
    await fireEvent("cancelled", booking.id);
    // free the tech so they don't stay stuck "busy" on a cancelled job
    if (booking.riderId) await reconcileRiderStatus(companyId, booking.riderId);
    incr("change_request_approved_cancel_total");
  } else {
    if (!req.proposedAt)
      return { ok: false, code: "invalid", message: "This request has no proposed time." };
    await t.update(
      schema.bookings,
      { scheduledAt: new Date(Number(req.proposedAt)) },
      eq(schema.bookings.id, booking.id),
    );
    await fire(companyId, "rescheduled", booking.id);
    incr("change_request_approved_reschedule_total");
  }
  await logJobEvent({
    companyId,
    bookingId: booking.id,
    kind: req.kind === "cancel" ? "cancelled" : "rescheduled",
    actorRole: "dispatch",
    actorName: args.actorName,
    detail: args.note,
    meta: { changeRequestId: req.id, decision: "approved" },
  });
  return { ok: true, request: claimed };
}

/** Office declines: the booking is untouched and the customer is told why. */
export async function declineRequest(args: {
  companyId: string;
  requestId: string;
  note: string;
  actorId: string;
  actorName: string;
}): Promise<
  | { ok: true; request: typeof schema.bookingChangeRequests.$inferSelect }
  | { ok: false; code: "not_found" | "conflict"; message: string }
> {
  const t = tdb(args.companyId);
  const req = await t.selectOne(
    schema.bookingChangeRequests,
    eq(schema.bookingChangeRequests.id, args.requestId),
  );
  if (!req) return { ok: false, code: "not_found", message: "Request not found" };
  const [claimed] = await t.update(
    schema.bookingChangeRequests,
    {
      status: "declined",
      decidedBy: args.actorId,
      decidedByName: args.actorName,
      decidedAt: new Date(),
      decisionNote: args.note.slice(0, 2_000),
    },
    and(
      eq(schema.bookingChangeRequests.id, args.requestId),
      eq(schema.bookingChangeRequests.status, "pending"),
    ),
  );
  if (!claimed)
    return { ok: false, code: "conflict", message: "This request was already decided." };
  await fire(args.companyId, "change_declined", req.bookingId);
  incr("change_request_declined_total");
  return { ok: true, request: claimed };
}

/** Office queue: pending first, newest first, with the job + customer attached. */
export async function listRequests(companyId: string, status?: string) {
  const t = tdb(companyId);
  const rows = await t.select(
    schema.bookingChangeRequests,
    status ? eq(schema.bookingChangeRequests.status, status) : undefined,
  );
  rows.sort((a, b) => {
    const pa = a.status === "pending" ? 0 : 1;
    const pb = b.status === "pending" ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return Number(b.createdAt) - Number(a.createdAt);
  });
  const bookingIds = [...new Set(rows.map((r) => r.bookingId))];
  const bookings = bookingIds.length
    ? await t.select(schema.bookings, inArray(schema.bookings.id, bookingIds))
    : [];
  const bmap = new Map(bookings.map((b) => [b.id, b]));
  const svcIds = [...new Set(bookings.map((b) => b.serviceId).filter(Boolean))];
  const svcs = svcIds.length
    ? await t.select(schema.services, inArray(schema.services.id, svcIds))
    : [];
  const smap = new Map(svcs.map((s) => [s.id, s]));
  const custIds = [...new Set(bookings.map((b) => b.customerId).filter(Boolean))];
  const custs = custIds.length
    ? await db.select().from(schema.user).where(inArray(schema.user.id, custIds))
    : [];
  const cmap = new Map(custs.map((u) => [u.id, u]));
  return rows.map((r) => {
    const b = bmap.get(r.bookingId);
    const cust = b ? cmap.get(b.customerId) : undefined;
    return {
      ...r,
      booking: b
        ? {
            id: b.id,
            shortId: b.id.slice(0, 6).toUpperCase(),
            status: b.status,
            address: b.address,
            scheduledAt: b.scheduledAt ? Number(b.scheduledAt) : null,
            serviceName: (b.serviceId ? smap.get(b.serviceId)?.name : "") || b.title || "",
            riderId: b.riderId,
          }
        : null,
      customer: cust ? { id: cust.id, name: cust.name, email: cust.email } : null,
    };
  });
}

/** Badge count for the admin shell. */
export async function pendingRequestCount(companyId: string): Promise<number> {
  const rows = await tdb(companyId).select(
    schema.bookingChangeRequests,
    eq(schema.bookingChangeRequests.status, OPEN_STATUS),
  );
  return rows.length;
}

/** Newest-first history for one booking (office job view). */
export async function requestsForBooking(companyId: string, bookingId: string) {
  const rows = await db
    .select()
    .from(schema.bookingChangeRequests)
    .where(
      and(
        eq(schema.bookingChangeRequests.companyId, companyId),
        eq(schema.bookingChangeRequests.bookingId, bookingId),
      ),
    )
    .orderBy(desc(schema.bookingChangeRequests.createdAt));
  return rows;
}
