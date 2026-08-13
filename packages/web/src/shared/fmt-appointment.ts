/**
 * Format an appointment instant on the COMPANY's clock.
 *
 * The customer-facing read screens (home, bookings list, tracking, the booking
 * confirmation) all used `fmtDate()` — a bare `toLocaleString("en-US")`, which
 * formats on the *browser's* clock with no zone name. Meanwhile the slot picker
 * (`nextSlots()`) had already been fixed to offer and label slots in the
 * company's zone. So the two halves disagreed: pick "9 AM CDT", get confirmed
 * "2:00 PM" (verified live from a UTC browser against a Winnipeg tenant).
 *
 * Rule, matching the slot picker: render in the company's zone, and append the
 * short zone name only when the viewer is on a different clock — so a local
 * customer sees clean times and a remote one is never misled.
 */
import { safeTimeZone, zoneOffsetMs } from "./tz";

/** Shown instead of "Invalid Date" when a row carries an unusable value. */
const DASH = "—";

/**
 * Are these two zones the same clock *right now*? Comparing IANA strings would
 * label a Winnipeg customer's time "CDT" just because their phone reports
 * America/Chicago, which is noise, not clarity.
 */
function sameClock(a: string, b: string, at: Date): boolean {
  if (a === b) return true;
  try {
    return zoneOffsetMs(at, a) === zoneOffsetMs(at, b);
  } catch {
    return false;
  }
}

export function fmtAppointment(
  d: string | number | Date,
  companyTz: string | null | undefined,
  /** Viewer's zone. Defaults to the runtime's, which is what we want in a browser. */
  viewerTz?: string,
): string {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return DASH;

  const tz = safeTimeZone(companyTz);
  const viewer = safeTimeZone(
    viewerTz || Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const showZone = !sameClock(tz, viewer, dt);

  return dt.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
    ...(showZone ? { timeZoneName: "short" as const } : {}),
  });
}
