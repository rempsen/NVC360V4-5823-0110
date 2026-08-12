// ─── Public tracking page: live-refresh policy ────────────────────────────────
// /t/:token is our highest-volume surface and the only one with no session at
// all. It is opened from an SMS, it gets forwarded, and once the job is done the
// link is permanent — customers bookmark it as their service record.
//
// That means a single page can sit open for days on a job that will never change
// again. The refresh policy below decides, from the snapshot we already have,
// how hard the page is allowed to talk to the server. Pure functions so the
// policy is unit-testable instead of buried in effect bodies.

/** Statuses after which nothing about the job will ever change again. */
export const TERMINAL_STATUSES = ["completed", "cancelled"] as const;

export function isTerminalStatus(status: unknown): boolean {
  return typeof status === "string" && (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Is this error the link itself being dead (unknown token, or an expired live
 * link)? 404/410 are permanent for a public token — there is no session to
 * refresh and no retry that can fix them.
 *
 * This is the case the page used to miss completely: `apiFetch` throws on a
 * 404, so the snapshot never landed in the cache, the "Not found" body check
 * never ran, and an old link forwarded around a family group chat polled the
 * API at 2.5s and reopened an EventSource every 4s for as long as the tab
 * stayed open. Duck-typed on `status` so this module stays dependency-free.
 */
export function isDeadLinkError(err: unknown): boolean {
  const s = (err as { status?: unknown } | null | undefined)?.status;
  return s === 404 || s === 410;
}

/** What the page knows about the link right now. */
export type TrackLiveState = {
  /** Booking status from the latest snapshot, if we have one. */
  status?: unknown;
  /** True once an SSE snapshot has landed — the poll is only a fallback then. */
  sseUp?: boolean;
  /** True when the token resolved to 404/expired: there is nothing to poll. */
  invalid?: boolean;
};

/** Snapshot poll: 2.5s live, 20s when SSE carries the updates, off otherwise. */
export const TRACK_POLL_LIVE_MS = 2_500;
export const TRACK_POLL_SSE_MS = 20_000;
/** Message thread poll: 4s during the job, 60s once it can no longer change. */
export const MSGS_POLL_LIVE_MS = 4_000;
export const MSGS_POLL_DONE_MS = 60_000;

/**
 * Interval for the tracking snapshot, or false to stop polling.
 *
 * A dead or finished link used to keep polling at 2.5s forever — a bookmarked
 * completed job hammered the API ~34k times a day per open tab, for a snapshot
 * that is frozen by definition, and burned the customer's battery doing it.
 */
export function trackPollMs(s: TrackLiveState): number | false {
  if (s.invalid) return false;
  if (isTerminalStatus(s.status)) return false;
  return s.sseUp ? TRACK_POLL_SSE_MS : TRACK_POLL_LIVE_MS;
}

/**
 * Interval for the message thread, or false to stop polling.
 *
 * Unlike the snapshot, messages do NOT stop at completion: the customer can
 * still write ("you left a tool behind") and the office can still reply. So it
 * slows down instead of stopping.
 */
export function messagesPollMs(s: TrackLiveState): number | false {
  if (s.invalid) return false;
  return isTerminalStatus(s.status) ? MSGS_POLL_DONE_MS : MSGS_POLL_LIVE_MS;
}

/** Should the page hold an SSE stream open at all? */
export function shouldStreamLive(s: TrackLiveState): boolean {
  return !s.invalid && !isTerminalStatus(s.status);
}

/**
 * Customer-facing text for a failed message send from the public page.
 *
 * The send used to be fire-and-forget: the response was never checked, so a
 * rejected POST still cleared the input and the customer walked away believing
 * their "there's a dog in the yard" note reached the technician. Now every
 * failure gets plain language a homeowner can act on — no status codes, no
 * "[object Object]".
 */
export function publicSendErrorMessage(err: unknown): string {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  if (status === 429)
    return "Too many messages just now — please wait a minute and try again.";
  if (isDeadLinkError(err))
    return "This tracking link is no longer active — please contact the company directly.";
  if (typeof status === "number" && status >= 500)
    return "The server didn't accept that — your message was not sent. Please try again.";
  const msg = (err as { message?: unknown } | null | undefined)?.message;
  if (typeof msg === "string" && msg.trim() && !/^\s*failed to fetch/i.test(msg)) return msg;
  return "Couldn't send your message. Please try again.";
}

export const SSE_RETRY_BASE_MS = 2_000;
export const SSE_RETRY_MAX_MS = 60_000;

/**
 * Reconnect delay after `attempt` consecutive failures (1 = first failure).
 *
 * A flat 4s retry meant a phone that lost signal, or an expired link, opened a
 * new EventSource every 4 seconds indefinitely. Exponential with a 60s ceiling
 * keeps a real reconnect fast while a hopeless one costs almost nothing.
 */
export function sseRetryDelayMs(attempt: number): number {
  const n = Number.isFinite(attempt) && attempt > 1 ? Math.floor(attempt) : 1;
  return Math.min(SSE_RETRY_BASE_MS * 2 ** (n - 1), SSE_RETRY_MAX_MS);
}
