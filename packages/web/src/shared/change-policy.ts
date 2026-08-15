/**
 * Customer-initiated appointment changes — the single source of truth.
 *
 * Shared deliberately: the customer portal uses it to decide which buttons to
 * show, and the API uses it to decide what it will actually accept. A pure
 * function means the screen and the server can never disagree about whether a
 * change was allowed.
 *
 * Policy shape (a corporate decision for SMB field service, not a UI detail):
 *  - RESCHEDULE is the safe release valve. The job stays on the board, only the
 *    time moves. Outside the cutoff the customer does it themselves; inside the
 *    cutoff it becomes a request, because the office may already have routed the
 *    day around it.
 *  - CANCEL is never self-serve. It is always a request the office approves, so
 *    nothing disappears from a dispatch board on its own and there is an audit
 *    trail with a reason attached.
 *  - Both hard-stop once a technician is actually moving or on site — at that
 *    point a truck roll has been spent and it is a phone conversation.
 */

export type ChangeMode = "self_serve" | "request" | "blocked";

export interface ChangePolicy {
  /** Customer may move their own appointment (outside the cutoff). */
  allowReschedule: boolean;
  /** Customer may ASK to cancel (office decides). */
  allowCancelRequest: boolean;
  /** Hours before the appointment where self-serve stops. 0 = no cutoff. */
  cutoffHours: number;
}

export const DEFAULT_CHANGE_POLICY: ChangePolicy = {
  allowReschedule: true,
  allowCancelRequest: true,
  cutoffHours: 12,
};

export interface ChangeDecision {
  reschedule: ChangeMode;
  cancel: ChangeMode;
  /** True when the appointment is nearer than the cutoff (or already past). */
  withinCutoff: boolean;
  cutoffHours: number;
  /** Set only when something is blocked outright — safe to show a customer. */
  blockedReason: string;
  /** Is a proposed new appointment time acceptable? */
  isValidTarget: (target: Date | number | string | null | undefined) => boolean;
}

/**
 * Statuses where the job is still just a plan on the calendar. Anything else is
 * either in flight (a tech is committed to it right now) or finished.
 */
const CHANGEABLE_STATUSES = new Set(["pending", "confirmed", "assigned"]);

/** A tech is physically on the move / on site — changes go through the office. */
const IN_FLIGHT_STATUSES = new Set([
  "enroute",
  "arrived",
  "onsite",
  "in_progress",
  "paused",
]);

const IN_FLIGHT_REASON =
  "Your technician is already on the way — please call the office so we can help right away.";
const TERMINAL_REASON = "This appointment is closed, so it can no longer be changed.";
const UNKNOWN_REASON = "We can't change this appointment online — please contact the office.";

function toMs(v: Date | number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const ms = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function evaluateChangePolicy(args: {
  status: string;
  scheduledAt: Date | number | string | null | undefined;
  now?: Date;
  policy?: Partial<ChangePolicy> | null;
}): ChangeDecision {
  const policy: ChangePolicy = { ...DEFAULT_CHANGE_POLICY, ...args.policy };
  const cutoffHours = Math.max(0, Number(policy.cutoffHours) || 0);
  const nowMs = (args.now ?? new Date()).getTime();
  const schedMs = toMs(args.scheduledAt);

  const isValidTarget = (target: Date | number | string | null | undefined) => {
    const ms = toMs(target);
    return ms !== null && ms > nowMs;
  };

  // No usable appointment time: block instead of guessing. A missing time means
  // we cannot reason about the cutoff at all, and silently treating it as "far
  // away" would hand out self-serve changes we can't justify.
  if (schedMs === null) {
    return {
      reschedule: "blocked",
      cancel: "blocked",
      withinCutoff: true,
      cutoffHours,
      blockedReason: UNKNOWN_REASON,
      isValidTarget,
    };
  }

  // Past appointments count as inside the cutoff — never outside it.
  const withinCutoff = schedMs - nowMs < cutoffHours * 3_600_000 || schedMs <= nowMs;

  if (IN_FLIGHT_STATUSES.has(args.status)) {
    return {
      reschedule: "blocked",
      cancel: "blocked",
      withinCutoff,
      cutoffHours,
      blockedReason: IN_FLIGHT_REASON,
      isValidTarget,
    };
  }
  if (!CHANGEABLE_STATUSES.has(args.status)) {
    return {
      reschedule: "blocked",
      cancel: "blocked",
      withinCutoff,
      cutoffHours,
      blockedReason: TERMINAL_REASON,
      isValidTarget,
    };
  }

  const reschedule: ChangeMode = !policy.allowReschedule
    ? "blocked"
    : withinCutoff
      ? "request"
      : "self_serve";
  // Deliberately no self_serve branch: the office always decides a cancellation.
  const cancel: ChangeMode = policy.allowCancelRequest ? "request" : "blocked";

  return { reschedule, cancel, withinCutoff, cutoffHours, blockedReason: "", isValidTarget };
}

/** Copy for why a change needs approval rather than going through immediately. */
export function approvalNoteFor(cutoffHours: number): string {
  return cutoffHours > 0
    ? `Your appointment is within ${cutoffHours} hour${cutoffHours === 1 ? "" : "s"}, so the office will confirm this change.`
    : "The office will confirm this change.";
}
