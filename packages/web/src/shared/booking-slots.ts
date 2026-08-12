/**
 * Customer-facing appointment slots.
 *
 * Kept out of the page component so it can be tested as a pure function: the
 * whole point of this module is that "9 AM" has to mean the same instant no
 * matter where the customer's browser is.
 */
import { safeTimeZone, zonedParts, zonedTimeToInstant } from "./tz";

/** The appointment windows offered, as hours on the company's own clock. */
const SLOT_HOURS = [9, 11, 13, 15, 17];

/**
 * The next five days of appointment slots, in the COMPANY's time zone.
 *
 * setHours()/getDate() work on the *browser's* clock, so 9 AM meant 9 AM
 * wherever the customer happened to be. A Winnipeg company taking a booking
 * from someone in Vancouver wrote a 9 AM slot that landed at 11 AM Winnipeg
 * time — on the dispatch board, in the tech's day, and in the confirmation the
 * customer got. Someone booking from Europe could pick a slot that was the
 * middle of the night for the crew.
 *
 * The hours themselves are unchanged (9/11/13/15/17); they now mean 9 AM on the
 * company's clock. The label is rendered in that zone too, with the zone name
 * appended when the customer isn't in it so the time on screen is never
 * ambiguous.
 */
export function nextSlots(timezone: string) {
  const tz = safeTimeZone(timezone);
  const slots: { label: string; value: string }[] = [];
  const now = new Date();
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const showZone = safeTimeZone(localTz) !== tz;
  // Today's calendar date as the COMPANY sees it — not as the browser sees it.
  const today = zonedParts(now, tz);
  for (let d = 0; d < 5; d++) {
    // Day arithmetic in UTC on a date-only value: no DST, no month-end bugs.
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + d));
    for (const h of SLOT_HOURS) {
      const dt = zonedTimeToInstant(
        tz,
        day.getUTCFullYear(),
        day.getUTCMonth() + 1,
        day.getUTCDate(),
        h,
      );
      if (dt > now)
        slots.push({
          label: dt.toLocaleString("en-US", {
            weekday: "short", month: "short", day: "numeric", hour: "numeric",
            timeZone: tz,
            ...(showZone ? { timeZoneName: "short" as const } : {}),
          }),
          value: dt.toISOString(),
        });
    }
  }
  return slots;
}
