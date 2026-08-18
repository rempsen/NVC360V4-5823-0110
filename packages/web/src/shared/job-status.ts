/**
 * The one place that knows how a job's status progresses.
 *
 * Every customer-facing surface had its own hand-written copy of this list, and
 * every copy was missing something. The public tracking page's stepper omitted
 * "confirmed", "onsite" and "paused" (fixed once already); the signed-in
 * customer portal still omits "onsite" and "paused" in two more places. The
 * failure mode is always the same and always visible to the paying customer:
 * an unlisted status falls through to index -1 / step 0, so the progress bar
 * snaps backwards and the "your tech is here" card disappears at the exact
 * moment the technician clocks in at their door.
 *
 * Pure and dependency-free so both the client and the server can use it and it
 * can be tested without a DB.
 */

/** Ordered customer-facing stages. Several statuses can map to one stage. */
export const JOB_STEPS = [
  { key: "confirmed", label: "Confirmed" },
  { key: "assigned", label: "Assigned" },
  { key: "enroute", label: "En route" },
  { key: "arrived", label: "Arrived" },
  { key: "in_progress", label: "In progress" },
  { key: "completed", label: "Completed" },
] as const;

/**
 * Stage index for every booking status the API can return.
 *
 * "onsite" (tech clocked in) sits with "arrived"; "paused" (clocked out
 * mid-job) sits with "in_progress" — work has started either way, so the bar
 * must never move backwards. "released" is an assign_status, not a status: a
 * released job goes back to "confirmed" and is covered by that.
 */
const STEP_INDEX: Record<string, number> = {
  pending: 0,
  confirmed: 0,
  assigned: 1,
  enroute: 2,
  arrived: 3,
  onsite: 3,
  in_progress: 4,
  paused: 4,
  completed: 5,
};

/** Stage index, or 0 for anything unrecognised (never -1: that reads as "before the start"). */
export function statusStepIndex(status: unknown): number {
  return typeof status === "string" && status in STEP_INDEX ? STEP_INDEX[status] : 0;
}

/** Is this a status we actually know about? */
export function isKnownStatus(status: unknown): boolean {
  return (
    (typeof status === "string" && status in STEP_INDEX) ||
    status === "cancelled"
  );
}

/** Nothing about the job will change again. */
export const TERMINAL_STATUSES = ["completed", "cancelled"] as const;

export function isTerminalStatus(status: unknown): boolean {
  return typeof status === "string" && (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * A technician is engaged on this job right now — so the customer should see the
 * live map, the tech card and the call button.
 *
 * Includes "onsite" and "paused": a tech standing in the customer's kitchen is
 * the most engaged they will ever be, and that is precisely when the two
 * customer-portal screens used to hide the tech's phone number.
 */
export const ACTIVE_STATUSES = [
  "assigned",
  "enroute",
  "arrived",
  "onsite",
  "in_progress",
  "paused",
] as const;

export function isActiveStatus(status: unknown): boolean {
  return typeof status === "string" && (ACTIVE_STATUSES as readonly string[]).includes(status);
}

/**
 * Statuses that make a booking the customer's "current" job — what the home
 * screen banner points at. Wider than ACTIVE_STATUSES: a confirmed job with no
 * tech yet is still the job they care about.
 */
export const OPEN_STATUSES = ["pending", "confirmed", ...ACTIVE_STATUSES] as const;

export function isOpenStatus(status: unknown): boolean {
  return typeof status === "string" && (OPEN_STATUSES as readonly string[]).includes(status);
}

/* -------------------------------------------------------------------------- */
/*  Legal transitions                                                          */
/* -------------------------------------------------------------------------- */
/**
 * What a job may become next, from where it is now.
 *
 * `POST /bookings/:id/status` used to accept any status string, which is how a
 * job could go straight from "enroute" to "completed": arrival is skipped, so
 * transit time is never finalised, the on-site clock never runs, and the
 * customer never gets the "your technician is here" notification — the job
 * simply gets billed as done from the van. The same gap let a completed job be
 * pushed back to "enroute", re-firing the on-my-way SMS on work already
 * invoiced.
 *
 * Cancellation is legal from any live stage and is therefore added to every
 * non-terminal entry. Re-sending the CURRENT status is always allowed: a
 * retried request on flaky signal must not come back as an error the driver has
 * to interpret.
 */
export const NEXT_STATUSES: Record<string, readonly string[]> = {
  pending: ["confirmed", "assigned"],
  confirmed: ["assigned", "enroute"],
  assigned: ["enroute"],
  enroute: ["arrived", "onsite"],
  arrived: ["onsite", "in_progress", "paused", "completed"],
  onsite: ["in_progress", "paused", "completed"],
  in_progress: ["paused", "completed"],
  paused: ["in_progress", "onsite", "completed"],
  completed: [],
  cancelled: [],
};

/** Live stages a job can be cancelled out of. */
const CANCELLABLE_FROM = ["pending", "confirmed", "assigned", "enroute", "arrived", "onsite", "in_progress", "paused"];

/** Is moving `from` -> `to` a legal step in the job flow? */
export function canTransition(from: unknown, to: unknown): boolean {
  if (typeof from !== "string" || typeof to !== "string") return false;
  if (!isKnownStatus(from) || !isKnownStatus(to)) return false;
  if (from === to) return true;
  if (to === "cancelled") return CANCELLABLE_FROM.includes(from);
  return (NEXT_STATUSES[from] ?? []).includes(to);
}

/**
 * Null when the move is legal, otherwise a message written for the person who
 * pressed the button — not a stack trace and not "invalid transition".
 */
export function transitionError(from: unknown, to: unknown): string | null {
  if (canTransition(from, to)) return null;
  if (to === "completed" && (from === "enroute" || from === "assigned" || from === "confirmed"))
    return "Check in on site before completing this job — tap \"I've Arrived\" first.";
  if (from === "completed") return "This job is already completed. The office can reopen it if something changed.";
  if (from === "cancelled") return "This job was cancelled. The office has to restore it before work can continue.";
  if (!isKnownStatus(to)) return "That isn't a job stage this app knows about.";
  return "This job has already moved on — pull it up again to see where it is now.";
}
