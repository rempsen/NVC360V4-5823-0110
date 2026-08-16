/**
 * fmtInZone() — the one server-side date formatter.
 *
 * Why this exists: `new Date(x).toLocaleDateString("en-US", {...})` on a server
 * running UTC renders the UTC calendar day. For a Winnipeg tenant (UTC-5 in
 * summer) every instant after 19:00 local is already TOMORROW in UTC, so a
 * maintenance reminder SMS for a job due Aug 17 at 8pm went out saying
 * "due Aug 18" — the wrong day, in a text to a paying customer.
 *
 * Pure: no DB, no clock, explicit zone in every call.
 */
import { describe, it, expect } from "bun:test";
import { fmtInZone } from "../tz";

// 2026-08-18T02:00Z is Aug 17, 9:00 PM in Winnipeg (UTC-5 in August).
const EVENING = new Date("2026-08-18T02:00:00.000Z");

describe("fmtInZone", () => {
  it("renders the calendar day of the tenant's zone, not the server's", () => {
    expect(fmtInZone(EVENING, "America/Winnipeg", { month: "short", day: "numeric" })).toBe(
      "Aug 17",
    );
    // The bug: same instant formatted on a UTC server.
    expect(fmtInZone(EVENING, "UTC", { month: "short", day: "numeric" })).toBe("Aug 18");
  });

  it("renders the wall-clock time of the tenant's zone", () => {
    const s = fmtInZone(EVENING, "America/Winnipeg", {
      hour: "numeric",
      minute: "2-digit",
    });
    expect(s).toBe("9:00 PM");
  });

  it("handles a zone ahead of UTC too", () => {
    // Same instant is Aug 18, 12:00 PM in Sydney (UTC+10).
    expect(
      fmtInZone(EVENING, "Australia/Sydney", { month: "short", day: "numeric" }),
    ).toBe("Aug 18");
  });

  it("accepts ms numbers and ISO strings, not just Date", () => {
    const opts = { month: "short", day: "numeric" } as const;
    expect(fmtInZone(EVENING.getTime(), "America/Winnipeg", opts)).toBe("Aug 17");
    expect(fmtInZone(EVENING.toISOString(), "America/Winnipeg", opts)).toBe("Aug 17");
  });

  it("falls back to the default zone rather than throwing on a junk zone", () => {
    // DEFAULT_TZ is America/Winnipeg, so this must match the Winnipeg answer.
    expect(fmtInZone(EVENING, "Not/AZone", { month: "short", day: "numeric" })).toBe("Aug 17");
    expect(fmtInZone(EVENING, null, { month: "short", day: "numeric" })).toBe("Aug 17");
  });

  it("never renders 'Invalid Date' into a customer message", () => {
    expect(fmtInZone(null, "America/Winnipeg", { month: "short" })).toBe("—");
    expect(fmtInZone("not a date", "America/Winnipeg", { month: "short" })).toBe("—");
    expect(fmtInZone(NaN, "America/Winnipeg", { month: "short" })).toBe("—");
  });

  it("takes an explicit fallback for callers that want a word instead of a dash", () => {
    expect(fmtInZone(null, "America/Winnipeg", { month: "short" }, "en-US", "soon")).toBe(
      "soon",
    );
  });

  it("honours a non-US locale", () => {
    const s = fmtInZone(
      EVENING,
      "America/Winnipeg",
      { dateStyle: "medium", timeStyle: "short" },
      "en-CA",
    );
    expect(s).toContain("2026");
    expect(s).toContain("17");
  });
});
