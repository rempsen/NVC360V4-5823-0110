/**
 * The customer picks a slot in the COMPANY's time zone and then every later
 * screen showed it in the BROWSER's.
 *
 * Found live, end to end, on Aug 13 2026: signed up as a customer, clicked the
 * slot labelled "Fri, Aug 14, 9 AM CDT", and the confirmation, /app/bookings
 * and /app/track/:id all read "Fri, Aug 14, 2:00 PM" — with no zone name to
 * explain the difference. The stored instant was correct (9 AM Winnipeg);
 * `nextSlots()` had already been fixed to work in the company zone, but the
 * read side still went through `fmtDate()`, which is a bare
 * `toLocaleString("en-US")` on the browser clock.
 *
 * Who this hurts: anyone whose device is not on the company's clock — a
 * snowbird booking service for their Winnipeg property from Arizona, a property
 * manager in another province, a phone with the wrong zone. They pick 9 AM and
 * the app confirms 2 PM, so either they call the office or they miss the
 * appointment.
 *
 * `fmtAppointment()` formats in the company's zone and appends the zone name
 * only when the viewer isn't in it — same rule the slot picker already uses, so
 * the two halves of the flow finally agree.
 */
import { describe, it, expect } from "bun:test";
import { fmtAppointment } from "../fmt-appointment";

// 2026-08-14T14:00:00Z === 9:00 AM in Winnipeg (CDT, UTC-5). This is the exact
// instant the live probe booking was stored at.
const INSTANT = new Date("2026-08-14T14:00:00.000Z");
const WPG = "America/Winnipeg";

describe("fmtAppointment", () => {
  it("renders the company's clock, not the viewer's", () => {
    // Viewer in UTC — the sandbox/browser case that produced "2:00 PM".
    const s = fmtAppointment(INSTANT, WPG, "UTC");
    expect(s).toContain("9:00 AM");
    expect(s).not.toContain("2:00 PM");
    expect(s).toContain("Fri");
    expect(s).toContain("Aug 14");
  });

  it("names the zone when the viewer is somewhere else", () => {
    expect(fmtAppointment(INSTANT, WPG, "America/Vancouver")).toContain("CDT");
    expect(fmtAppointment(INSTANT, WPG, "Europe/London")).toContain("CDT");
  });

  it("omits the zone name when the viewer is already on that clock", () => {
    const s = fmtAppointment(INSTANT, WPG, WPG);
    expect(s).toContain("9:00 AM");
    expect(s).not.toContain("CDT");
  });

  it("treats an equivalent zone as the same clock, not a foreign one", () => {
    // Same offset and same DST rules — telling a Winnipeg customer "CDT"
    // because their phone says America/Chicago would be noise.
    expect(fmtAppointment(INSTANT, WPG, "America/Chicago")).not.toContain("CDT");
  });

  it("falls back instead of throwing on a junk company zone", () => {
    // company_settings.timezone is free text in the DB; a bad value must not
    // blank out the customer's appointment time.
    expect(fmtAppointment(INSTANT, "Not/AZone", "UTC")).toContain("Aug 14");
  });

  it("handles a string or epoch input like fmtDate did", () => {
    expect(fmtAppointment(INSTANT.toISOString(), WPG, "UTC")).toContain("9:00 AM");
    expect(fmtAppointment(INSTANT.getTime(), WPG, "UTC")).toContain("9:00 AM");
  });

  it("survives an unparseable date without rendering 'Invalid Date'", () => {
    expect(fmtAppointment("not a date", WPG, "UTC")).toBe("—");
  });
});
