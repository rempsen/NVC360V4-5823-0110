/**
 * "Running late" detection — the single source of truth.
 *
 * The expensive moment in field service isn't the delay, it's the silence
 * around it. A customer who took the morning off and hears nothing at 9:20 for
 * a 9:00 appointment phones the office, and that call costs more than the slip
 * did. This decides, from facts already on the booking, whether a job is
 * running late and who gets to tell the customer.
 *
 * Product shape (Dan's call, Aug 2026):
 *  - Auto-DETECT always. The sweep flags the job the moment it slips past the
 *    tenant's threshold, so the board shows it before the phone rings.
 *  - A human gets first refusal. Dispatch knows things the data doesn't ("he's
 *    two minutes out", "I already called her"), so a flagged job waits a grace
 *    period for someone to send it, adjust, or mute it.
 *  - If nobody acts, it sends itself. A notice that depends on a busy
 *    dispatcher remembering is a notice that doesn't go out on the worst days.
 *
 * Pure on purpose: the sweep, the API, and the admin screen all run this same
 * function, so the board and the outgoing SMS can never disagree about whether
 * a job is late.
 */

export interface DelayPolicy {
  /** Master switch for the tenant. */
  enabled: boolean;
  /** Minutes past the promised time before a job counts as late. */
  thresholdMins: number;
  /** Minutes a flagged job waits for a human before it sends itself. 0 = never auto-send. */
  autoSendAfterMins: number;
}

export const DEFAULT_DELAY_POLICY: DelayPolicy = {
  enabled: true,
  thresholdMins: 15,
  autoSendAfterMins: 10,
};

export interface DelayInputs {
  now: number;
  scheduledAt: number | null;
  status: string;
  /** Live traffic ETA in minutes from the tech's position, when enroute. */
  etaMins: number | null;
  policy: DelayPolicy;
  /** When the sweep first noticed this slip. */
  flaggedAt: number | null;
  /** When the customer was last told. */
  notifiedAt: number | null;
  /** The slip we told them about, so we only speak up again if it got worse. */
  notifiedMins: number | null;
  /** Dispatch said "don't tell them" — usually because they already called. */
  muted: boolean;
}

export type DelayReason = "not_started" | "eta_overrun" | "";
/**
 * - flag:   newly late, start the dispatcher's grace clock
 * - notify: tell the customer now
 * - clear:  it caught back up, drop the flag
 */
export type DelayAction = "none" | "flag" | "notify" | "clear";

export interface DelayDecision {
  late: boolean;
  /** Projected minutes past the promised arrival. Never negative. */
  slipMins: number;
  reason: DelayReason;
  action: DelayAction;
  /** When this will send itself if nobody acts. null = never. */
  autoSendAt: number | null;
}

/**
 * Statuses worth watching. Once the tech has actually arrived, the customer can
 * see the van — a "running late" text at that point is noise, not service.
 */
const WATCHED_STATUSES = new Set(["pending", "confirmed", "assigned", "accepted", "enroute"]);

/** Never send two notices closer together than this, however bad it gets. */
const MIN_GAP_BETWEEN_NOTICES_MS = 30 * 60_000;

const MIN = 60_000;

function quiet(over: Partial<DelayDecision> = {}): DelayDecision {
  return { late: false, slipMins: 0, reason: "", action: "none", autoSendAt: null, ...over };
}

export function evaluateDelay(args: DelayInputs): DelayDecision {
  const { policy } = args;
  if (!policy.enabled) return quiet();
  if (!WATCHED_STATUSES.has(args.status)) return quiet();
  // No promised time means there is nothing to be late for. Never guess one.
  if (!args.scheduledAt) return quiet();

  const threshold = Math.max(1, policy.thresholdMins);

  // Two ways a job runs late, and they need different arithmetic. A tech who
  // hasn't left yet is late by the clock; a tech already driving is late by
  // where the traffic actually puts them, which is knowable before the
  // customer's appointment time has even passed.
  const enrouteWithEta = args.status === "enroute" && args.etaMins != null && args.etaMins >= 0;
  const projectedArrival = enrouteWithEta ? args.now + (args.etaMins as number) * MIN : args.now;
  const slipMs = projectedArrival - args.scheduledAt;
  const slipMins = Math.max(0, Math.round(slipMs / MIN));
  const reason: DelayReason = slipMins > 0 ? (enrouteWithEta ? "eta_overrun" : "not_started") : "";

  if (slipMins < threshold) {
    // Traffic cleared or the tech made up the time — take the flag back down so
    // the board stops shouting about a job that's fine.
    return quiet({ action: args.flaggedAt ? "clear" : "none", slipMins });
  }

  const autoSendAt =
    policy.autoSendAfterMins > 0 && args.flaggedAt
      ? args.flaggedAt + policy.autoSendAfterMins * MIN
      : null;
  const late = { late: true, slipMins, reason, autoSendAt };

  // Newly late: put it on the board and start the grace clock. Deliberately
  // never notifies on the same pass it flags — the human gets first refusal.
  if (!args.flaggedAt) return { ...late, action: "flag", autoSendAt: null };

  if (args.muted) return { ...late, action: "none" };

  if (args.notifiedAt) {
    // Already told them. Only speak up again if the situation genuinely got
    // worse by another full threshold, and never inside the quiet gap: a
    // customer watching a slip grow in 5-minute texts is worse off than one
    // who got two honest updates.
    const grew = slipMins - (args.notifiedMins ?? 0) >= threshold;
    const spaced = args.now - args.notifiedAt >= MIN_GAP_BETWEEN_NOTICES_MS;
    return { ...late, action: grew && spaced ? "notify" : "none" };
  }

  if (autoSendAt && args.now >= autoSendAt) return { ...late, action: "notify" };
  return { ...late, action: "none" };
}

/**
 * What the customer reads. Field service delays are estimates, so quoting "17
 * minutes" is false precision that turns into a complaint at minute 18. Round
 * to 5 minutes under an hour and to a quarter hour beyond it, and never round
 * down to nothing.
 */
export function roundedSlip(mins: number): number {
  const step = mins >= 60 ? 15 : 5;
  return Math.max(step, Math.round(mins / step) * step);
}
