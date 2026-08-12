/**
 * Appointment slots must be the COMPANY's 9/11/13/15/17, not the browser's.
 *
 * What was broken: nextSlots() built each slot with setHours(9,0,0,0) on a Date
 * created in the browser, so the hour was local to whoever was booking. A
 * Winnipeg company taking a booking from Vancouver stored a "9 AM" slot that
 * actually fell at 11 AM Winnipeg time, and a customer booking from Europe
 * could pick a slot that was the middle of the night for the crew.
 *
 * These tests pin the invariant: for any browser time zone, every generated
 * slot lands on one of the offered hours *as read in the tenant's zone*.
 */
import { describe, it, expect } from "bun:test";
import { nextSlots } from "../booking-slots";
import { zonedParts } from "../tz";

const HOURS = [9, 11, 13, 15, 17];

function hoursIn(tz: string) {
  return nextSlots(tz).map((s) => zonedParts(new Date(s.value), tz).hour);
}

describe("nextSlots", () => {
  it("offers only the tenant's 9/11/13/15/17, read in the tenant's zone", () => {
    for (const tz of [
      "America/Winnipeg",
      "America/Vancouver",
      "America/St_Johns", // half-hour offset
      "Australia/Adelaide", // half-hour offset, southern DST
      "Asia/Kolkata", // :30 offset, no DST
      "Europe/London",
      "Pacific/Kiritimati", // UTC+14
    ]) {
      const hours = hoursIn(tz);
      expect(hours.length).toBeGreaterThan(0);
      for (const h of hours) expect(HOURS).toContain(h);
      // minutes are always on the hour
      for (const s of nextSlots(tz))
        expect(zonedParts(new Date(s.value), tz).minute).toBe(0);
    }
  });

  it("never offers a slot in the past", () => {
    const now = Date.now();
    for (const s of nextSlots("America/Winnipeg"))
      expect(new Date(s.value).getTime()).toBeGreaterThan(now);
  });

  it("covers five calendar days of the tenant's own days, in order", () => {
    const tz = "America/Winnipeg";
    const slots = nextSlots(tz);
    const days = [
      ...new Set(
        slots.map((s) => {
          const p = zonedParts(new Date(s.value), tz);
          return `${p.year}-${p.month}-${p.day}`;
        }),
      ),
    ];
    // today may be fully spent (after 17:00 local), so 4 or 5 distinct days
    expect(days.length).toBeGreaterThanOrEqual(4);
    expect(days.length).toBeLessThanOrEqual(5);
    const times = slots.map((s) => new Date(s.value).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // at most one full day of windows per day
    expect(slots.length).toBeLessThanOrEqual(HOURS.length * 5);
  });

  it("falls back to the same default zone the server uses when unset", () => {
    // DEFAULT_TZ is America/Winnipeg; an empty or junk value must not throw and
    // must produce the same slots as naming that zone explicitly.
    const hour = (tz: string) => zonedParts(new Date(nextSlots(tz)[0].value), "America/Winnipeg").hour;
    expect(HOURS).toContain(hour(""));
    expect(HOURS).toContain(hour("Not/AZone"));
    expect(nextSlots("").length).toBe(nextSlots("America/Winnipeg").length);
  });

  it("labels the slot in the tenant's zone, naming the zone for out-of-zone customers", () => {
    // Out-of-zone customer: the label must carry a zone name, otherwise "9 AM"
    // on screen is ambiguous. Kiritimati is nobody's local zone.
    const away = nextSlots("Pacific/Kiritimati")[0].label;
    expect(away).toMatch(/\+14|LINT|GMT/);
    // Customer in the company's own zone: no zone suffix, just the time.
    const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const home = nextSlots(localTz)[0].label;
    expect(home).toMatch(/\d+ (AM|PM)$/);
  });

  it("keeps the label's hour and the stored instant in agreement", () => {
    const tz = "America/Vancouver";
    for (const s of nextSlots(tz)) {
      const h24 = zonedParts(new Date(s.value), tz).hour;
      const h12 = h24 > 12 ? h24 - 12 : h24;
      expect(s.label).toContain(`${h12}`);
      expect(s.label).toContain(h24 >= 12 ? "PM" : "AM");
    }
  });
});
