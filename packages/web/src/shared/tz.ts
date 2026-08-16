/**
 * Tenant time zones.
 *
 * company_settings.timezone has existed (and been editable in Settings →
 * Company) since the beginning, and NOTHING read it. Every server-side
 * "what time is it" and "which day is this" decision used the process time
 * zone instead, and the server runs UTC — so for a Winnipeg tenant (UTC-5 in
 * summer) every local-time decision was five hours out:
 *
 *   - Quiet hours configured 21:00-08:00 suppressed SMS/email from 16:00 to
 *     02:00 LOCAL — silence through the busiest part of the afternoon, and
 *     notifications sent at 3 AM.
 *   - A technician's "today" stats window was UTC midnight to UTC midnight, so
 *     at 19:00 local the counter rolled over: this morning's completed jobs and
 *     earnings vanished, and an evening job counted toward tomorrow.
 *   - Report day buckets used UTC dates, so a job finished at 21:00 local
 *     landed on the NEXT day's revenue bar.
 *
 * Everything here is pure and takes an explicit time zone, so it can be tested
 * without touching the DB and used on the client too.
 */

/** Used when a tenant has no time zone set, or an unusable one. */
export const DEFAULT_TZ = "America/Winnipeg";

/** Is this string a time zone Intl actually accepts? (Bad values throw.) */
export function isValidTimeZone(tz: string | null | undefined): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** Fall back rather than throw: a bad setting must not 500 a request. */
export function safeTimeZone(tz: string | null | undefined): string {
  return isValidTimeZone(tz) ? (tz as string) : DEFAULT_TZ;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
}

/** Wall-clock parts of `instant` as seen in `tz`. */
export function zonedParts(instant: Date, tz: string): ZonedParts {
  const p = partsFormatter(safeTimeZone(tz)).formatToParts(instant);
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  // en-US renders midnight as hour "24" in some ICU versions.
  const hour = get("hour") % 24;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset of `tz` from UTC at `instant`, in ms (positive = ahead of UTC). */
export function zoneOffsetMs(instant: Date, tz: string): number {
  const p = zonedParts(instant, tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Drop sub-second noise: formatToParts has no ms.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `tz` reads the given local time.
 * Two passes so a time near a DST boundary uses the offset in force at the
 * result, not at the guess.
 */
export function zonedTimeToInstant(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  let offset = zoneOffsetMs(new Date(wall), tz);
  offset = zoneOffsetMs(new Date(wall - offset), tz);
  return new Date(wall - offset);
}

/** "YYYY-MM-DD" for the calendar day `instant` falls on in `tz`. */
export function zonedDayKey(instant: Date, tz: string): string {
  const p = zonedParts(instant, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Minutes since local midnight — what quiet hours actually means. */
export function zonedMinutesOfDay(instant: Date, tz: string): number {
  const p = zonedParts(instant, tz);
  return p.hour * 60 + p.minute;
}

/**
 * First and last instant of the calendar day `instant` falls on in `tz`.
 * Inclusive `end` (…23:59:59.999 local), so it can be used with `<=` the way
 * the old setHours(23,59,59,999) code was.
 */
export function zonedDayBounds(instant: Date, tz: string): { start: Date; end: Date } {
  const p = zonedParts(instant, tz);
  const start = zonedTimeToInstant(tz, p.year, p.month, p.day, 0, 0, 0, 0);
  const end = zonedTimeToInstant(tz, p.year, p.month, p.day, 23, 59, 59, 999);
  return { start, end };
}

/**
 * Day bounds for a date the user *named* ("2026-08-01" from a date picker, or
 * any parseable date string). A bare YYYY-MM-DD parses as UTC midnight, which
 * in a negative-offset zone is the previous local day — so the calendar date is
 * taken from the string when it looks like a plain date, and from `tz`
 * otherwise.
 */
export function namedDayBounds(input: string | Date, tz: string): { start: Date; end: Date } {
  if (typeof input === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
    if (m) {
      const [, y, mo, d] = m;
      return {
        start: zonedTimeToInstant(tz, Number(y), Number(mo), Number(d), 0, 0, 0, 0),
        end: zonedTimeToInstant(tz, Number(y), Number(mo), Number(d), 23, 59, 59, 999),
      };
    }
  }
  const dt = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(dt.getTime())) return zonedDayBounds(new Date(), tz);
  return zonedDayBounds(dt, tz);
}

/**
 * Format an instant on a GIVEN zone's clock — the only date formatter the
 * server should ever use.
 *
 * `new Date(x).toLocaleDateString("en-US", ...)` on the server formats in the
 * process zone, and the server runs UTC. For a Winnipeg tenant (UTC-5 in
 * summer) every instant after 19:00 local is already tomorrow in UTC, so a
 * maintenance reminder for a job due Aug 17 at 8pm went out by SMS reading
 * "due Aug 18". Same class of bug as the quiet-hours and today-stats ones:
 * the tenant's zone existed in settings and nothing read it.
 *
 * Also normalises the narrow no-break space newer ICU builds put before AM/PM,
 * so the same string comes out of every runtime and lands cleanly in an SMS.
 */
export function fmtInZone(
  d: string | number | Date | null | undefined,
  tz: string | null | undefined,
  opts: Intl.DateTimeFormatOptions,
  locale = "en-US",
  /** Shown instead of "Invalid Date" — never put that in a customer message. */
  fallback = "—",
): string {
  if (d == null || d === "") return fallback;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return fallback;
  try {
    return dt
      .toLocaleString(locale, { ...opts, timeZone: safeTimeZone(tz) })
      .replace(/[  ]/g, " ");
  } catch {
    // A bad locale must not 500 a request or lose a notification.
    return dt
      .toLocaleString("en-US", { ...opts, timeZone: safeTimeZone(tz) })
      .replace(/[  ]/g, " ");
  }
}
