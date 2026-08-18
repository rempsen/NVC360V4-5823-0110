/**
 * Can this technician actually take this job at this time?
 *
 * Two things the dispatch board never checked:
 *
 * 1. DOUBLE BOOKING. `POST /bookings/:id/assign`, `POST /bookings` (created with a
 *    tech on it) and `POST /bookings/:id/schedule` looked at the JOB's status and
 *    nothing else. Sending the same tech to two addresses at 2:00 PM was a silent,
 *    one-click mistake — the board showed both cards, the tech's phone showed both
 *    jobs, and the second customer found out by waiting.
 *
 * 2. TIME OFF. `tech_shifts` (shifts and time-off, written from the technician's
 *    profile) was read by the UI that wrote it and by nothing else. A tech marked
 *    off for Friday could be dispatched on Friday with no warning at all.
 *
 * Everything here is pure — no DB, no clock, explicit time zone — so the arithmetic
 * is unit-testable and the same rules can be shown in the UI later.
 *
 * These are WARNINGS, not laws: real dispatch overrides them every day (a job runs
 * long, a tech agrees to come in on a day off). The routes surface them as a
 * forceable 409 so the office confirms, exactly like pulling a tech off a live job.
 */
import { isTerminalStatus } from "./job-status";
import { zonedDayKey } from "./tz";

/** A job with no service duration is assumed to take an hour. */
export const DEFAULT_JOB_MINUTES = 60;

/** The shortest window we will reason about, so a 0/garbage duration still clashes. */
const MIN_JOB_MINUTES = 15;

export interface JobSlot {
  id: string;
  riderId: string | null;
  scheduledAt: number | Date | null;
  /** From the service (`services.duration_mins`); bookings have no duration column. */
  durationMins?: number | null;
  status?: string | null;
  title?: string | null;
}

export interface ShiftRow {
  id: string;
  riderId: string;
  kind: string; // "shift" | "timeoff"
  date: number | Date;
  startMin?: number | null;
  endMin?: number | null;
  note?: string | null;
}

export interface TimeWindow {
  start: number;
  end: number;
}

function ms(v: number | Date | null | undefined): number | null {
  if (v == null) return null;
  const n = v instanceof Date ? v.getTime() : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Minutes a job is expected to occupy, clamped so bad data can't disable the check. */
export function jobMinutes(durationMins?: number | null): number {
  const n = Number(durationMins);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_JOB_MINUTES;
  return Math.max(MIN_JOB_MINUTES, Math.min(n, 24 * 60));
}

/** The clock window a job occupies. Returns null when it has no date yet. */
export function jobWindow(slot: Pick<JobSlot, "scheduledAt" | "durationMins">): TimeWindow | null {
  const start = ms(slot.scheduledAt);
  if (start === null) return null;
  return { start, end: start + jobMinutes(slot.durationMins) * 60_000 };
}

/** Half-open overlap: a job ending at 2:00 and one starting at 2:00 do NOT clash. */
export function windowsOverlap(a: TimeWindow, b: TimeWindow): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * The first of `others` that this tech is already booked on at the same time.
 * Ignores the job being moved, other technicians, completed/cancelled work and
 * anything without a date.
 */
export function findOverlappingJob(
  candidate: { id?: string | null; riderId: string; scheduledAt: number | Date | null; durationMins?: number | null },
  others: JobSlot[],
): JobSlot | null {
  const win = jobWindow(candidate);
  if (!win || !candidate.riderId) return null;
  for (const other of others) {
    if (!other.riderId || other.riderId !== candidate.riderId) continue;
    if (candidate.id && other.id === candidate.id) continue;
    if (isTerminalStatus(other.status)) continue;
    const otherWin = jobWindow(other);
    if (!otherWin) continue;
    if (windowsOverlap(win, otherWin)) return other;
  }
  return null;
}

/**
 * Time off booked on the calendar day the job starts on, in the company's zone.
 *
 * Time off is treated as covering the whole day: that is what the office sees in
 * the technician's profile ("Time off", no hours), so enforcing a 9-to-5 slice of
 * it would refuse and allow the same day for reasons nobody can see. Regular
 * `shift` rows are NOT enforced — a company that never fills its shift calendar
 * would otherwise be unable to dispatch anything.
 */
export function findTimeOff(
  candidate: { riderId: string; scheduledAt: number | Date | null },
  shifts: ShiftRow[],
  timeZone: string,
): ShiftRow | null {
  const start = ms(candidate.scheduledAt);
  if (start === null || !candidate.riderId) return null;
  const day = zonedDayKey(new Date(start), timeZone);
  for (const s of shifts) {
    if (s.kind !== "timeoff" || s.riderId !== candidate.riderId) continue;
    const d = ms(s.date);
    if (d === null) continue;
    if (zonedDayKey(new Date(d), timeZone) === day) return s;
  }
  return null;
}

/** "2:00 PM" on the company's clock — for the message the dispatcher reads. */
export function clockLabel(at: number | Date, timeZone: string): string {
  const d = at instanceof Date ? at : new Date(at);
  try {
    return d
      .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone })
      .replace(/[  ]/g, " ");
  } catch {
    return d.toISOString().slice(11, 16);
  }
}

/** Plain-English refusal for a double booking. */
export function overlapMessage(
  techName: string,
  clash: JobSlot,
  timeZone: string,
  workerNoun = "technician",
): string {
  const at = ms(clash.scheduledAt);
  const when = at === null ? "the same time" : clockLabel(at, timeZone);
  const what = clash.title?.trim() || "another job";
  return `${techName || `This ${workerNoun}`} is already booked at ${when} — "${what}".`;
}

/** Plain-English refusal for dispatching onto booked time off. */
export function timeOffMessage(
  techName: string,
  shift: ShiftRow,
  workerNoun = "technician",
): string {
  const note = shift.note?.trim();
  return `${techName || `This ${workerNoun}`} has time off booked that day${note ? ` (${note})` : ""}.`;
}
