/**
 * Re-entrancy guard for the once-a-minute sweeps.
 *
 * setInterval does not wait for the previous run to finish. Every sweep this
 * server runs (running-late notices, automation time triggers, the email-domain
 * poll, presence reconcile) walks the same rows and writes to them, and each
 * one is a chain of round trips to a remote Turso. One slow minute — a cold
 * socket, a big tenant, a retry — and two passes are inside the same rows at
 * the same time. For the running-late sweep that is two "we're running late"
 * texts about one job; for automation it is the same rule firing twice.
 *
 * Skipping is deliberately preferred to queueing: a backlog of stale sweeps is
 * worse than a missed one, and the next tick is only 60 seconds away.
 */
import { incr } from "../api/lib/metrics";

const running = new Set<string>();

export interface TickResult<T = unknown> {
  /** False when a previous run of the same name was still in flight. */
  ran: boolean;
  reason?: "already-running";
  value?: T;
  /** The job threw; the lock was released anyway. */
  error?: unknown;
}

/**
 * Run `fn` unless a job of the same name is already running.
 *
 * Never rejects: a sweep that throws must not become an unhandled rejection in
 * a setInterval callback, and must never leave its own lock held.
 */
export async function oncePerTick<T>(
  name: string,
  fn: () => Promise<T> | T,
): Promise<TickResult<T>> {
  if (running.has(name)) {
    incr(`tick_skipped_total.${name}`);
    return { ran: false, reason: "already-running" };
  }
  running.add(name);
  try {
    const value = await fn();
    return { ran: true, value };
  } catch (error) {
    console.error(`[tick] ${name} failed`, error);
    incr(`tick_failed_total.${name}`);
    return { ran: true, error };
  } finally {
    running.delete(name);
  }
}

/** Is a named job in flight right now? */
export function isTickRunning(name: string): boolean {
  return running.has(name);
}

/** Test-only: drop every held lock. */
export function _resetTicksForTests(): void {
  running.clear();
}
