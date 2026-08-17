/**
 * Turn the flat appointment-slot list into days a customer can actually read.
 *
 * `nextSlots()` returns up to 25 slots as one list, each labelled with its own
 * date ("Mon, Aug 18, 9 AM"). Rendered flat that is a wall of near-identical
 * buttons where the important difference — the DAY — sits in the middle of the
 * label. Customers pick the right time on the wrong day, and that mistake costs
 * a dispatched truck.
 *
 * So both places a customer picks a time (the booking page and the reschedule
 * modal) group by day and show the times for one day at a time. That grouping
 * lives here, as pure functions, for two reasons:
 *  - it has to happen on the COMPANY's clock. A customer in Vancouver looking at
 *    a Winnipeg company's 7 PM slot must see it under the same day the crew has
 *    it on their board, not rolled into tomorrow by the browser's zone.
 *  - the modal already had a private copy. Two copies of "which day is this
 *    slot on" is exactly the kind of thing that drifts silently.
 */
import { safeTimeZone, zonedDayKey } from "./tz";

export type Slot = { label: string; value: string };

export type SlotDay = {
  /** Stable YYYY-MM-DD on the company's clock. Sorts chronologically as text. */
  key: string;
  /** Full label for a heading: "Tuesday, Aug 18". */
  label: string;
  /** Short weekday for a compact day chip: "Tue". */
  weekday: string;
  /** Day of month for a compact day chip: "18". */
  dayNum: string;
  /** "Today" / "Tomorrow" when it applies, otherwise "" — never a guess. */
  relative: string;
  /** Times on this day, labelled without the date: "9:00 AM". */
  times: Slot[];
};

/** Shift a YYYY-MM-DD key by whole days without touching a time zone. */
function addDays(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/**
 * Group slots by calendar day in `timezone`.
 *
 * `now` is injectable so "Today"/"Tomorrow" is testable; it defaults to the
 * real clock.
 */
export function groupSlotsByDay(slots: Slot[], timezone: string, now: Date = new Date()): SlotDay[] {
  const tz = safeTimeZone(timezone);
  const dayFmt = new Intl.DateTimeFormat("en-US", {
    weekday: "long", month: "short", day: "numeric", timeZone: tz,
  });
  const shortFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz });
  const numFmt = new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: tz });
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: tz,
  });

  const todayKey = zonedDayKey(now, tz);
  const tomorrowKey = addDays(todayKey, 1);

  const byKey = new Map<string, SlotDay>();
  for (const s of slots) {
    const at = new Date(s.value);
    // A malformed value would otherwise produce an "Invalid Date" day heading
    // and a bucket no slot can ever be selected out of.
    if (Number.isNaN(at.getTime())) continue;
    const key = zonedDayKey(at, tz);
    let day = byKey.get(key);
    if (!day) {
      day = {
        key,
        label: dayFmt.format(at),
        weekday: shortFmt.format(at),
        dayNum: numFmt.format(at),
        relative: key === todayKey ? "Today" : key === tomorrowKey ? "Tomorrow" : "",
        times: [],
      };
      byKey.set(key, day);
    }
    day.times.push({ label: timeFmt.format(at), value: s.value });
  }

  const days = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const d of days) d.times.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  return days;
}

/**
 * Which day tab should be showing.
 *
 * Precedence, in this order, and the order is the whole point:
 *  1. the day the customer tapped — browsing has to work even after they have
 *     already picked a time. An earlier version let the picked slot win here,
 *     and the day row went dead: tapping Thursday snapped straight back to
 *     Tuesday because Tuesday still owned the selection. Caught in the browser,
 *     not in a unit test.
 *  2. the day their picked slot is on — the right opening state, and the right
 *     recovery if the day they were browsing expired out from under them.
 *  3. the first day with anything open.
 *
 * The result always names a day that exists, so the picker can never go blank.
 */
export function resolveSelectedDay(days: SlotDay[], selectedKey: string, selectedSlot: string): string {
  if (days.length === 0) return "";
  if (selectedKey && days.some((d) => d.key === selectedKey)) return selectedKey;
  if (selectedSlot) {
    const owning = days.find((d) => d.times.some((t) => t.value === selectedSlot));
    if (owning) return owning.key;
  }
  return days[0].key;
}
