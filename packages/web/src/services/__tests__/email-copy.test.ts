/**
 * Customer-facing email copy.
 *
 * Three bugs this pins, all found reading the templates against what actually
 * goes out to a paying customer:
 *
 * 1. TIME ZONE. `fmt()` was a bare toLocaleString with no timeZone, so the
 *    "When" row rendered the SERVER's UTC clock. Same bug class as fd8d497 —
 *    missed then because it lives in services/email.ts, not in a route. For a
 *    Winnipeg tenant any appointment after 19:00 local printed tomorrow's date.
 *    It also printed no year and no zone name, in an email a customer may open
 *    on a plane.
 *
 * 2. MONEY. The Total / Amount rows were `${d.price.toFixed(2)}` — a template
 *    literal that lost its dollar sign. The receipt SMS says "$149.00", the
 *    receipt EMAIL said "149.00". On a payment receipt that is not cosmetic.
 *
 * 3. LINKS. `${appUrl}track/${id}` only produced a valid URL because the local
 *    .env happens to end WEBSITE_URL in a slash. Without one it yields
 *    "https://uberize.aitrack/xxx" — every CTA button in every email dead.
 *
 * All three are pure-function bugs, so this file pins the exact rendered words.
 */
import { describe, it, expect } from "bun:test";

// These modules construct the DB client at import time; keep it ephemeral so a
// pure copy test never reaches for real credentials.
process.env.DATABASE_URL = "postgresql://placeholder:placeholder@localhost:5432/placeholder"; // never queried by this pure-logic test

const { emailTemplates, money, emailLink } = await import("../email");

// Mon Aug 17 2026, 8:00 PM in Winnipeg (CDT, UTC-5) = Aug 18 01:00 UTC.
// Any UTC-clock formatter calls this "Aug 18".
const EVENING = new Date("2026-08-18T01:00:00.000Z");
const WPG = "America/Winnipeg";

const brand = { company: "BMD Materials", brandColor: "#0ea5e9" };

const data = {
  customerName: "Dan",
  serviceName: "Furnace tune-up",
  scheduledAt: EVENING,
  address: "123 Main St, Winnipeg",
  price: 149,
  bookingId: "bk_1",
  riderName: "Alex",
  invoiceNumber: "INV-1042",
};

describe("appointment times are rendered on the company's clock, not the server's", () => {
  it("booking confirmation prints the tenant's calendar day for an evening job", () => {
    const html = emailTemplates.bookingConfirmed(data, brand, WPG).html;
    expect(html).toContain("Aug 17, 2026");
    expect(html).not.toContain("Aug 18");
  });

  it("reminder prints the tenant's calendar day for an evening job", () => {
    const html = emailTemplates.reminder(data, brand, WPG).html;
    expect(html).toContain("Aug 17, 2026");
    expect(html).not.toContain("Aug 18");
  });

  it("assignment notice prints the tenant's calendar day for an evening job", () => {
    const html = emailTemplates.riderAssigned(data, brand, WPG).html;
    expect(html).toContain("Aug 17, 2026");
    expect(html).not.toContain("Aug 18");
  });

  it("the same instant renders a different day for a tenant one zone over", () => {
    // Aug 18 01:00 UTC is still Aug 17 in Winnipeg but already Aug 18 in London.
    const wpg = emailTemplates.bookingConfirmed(data, brand, WPG).html;
    const ldn = emailTemplates.bookingConfirmed(data, brand, "Europe/London").html;
    expect(wpg).toContain("Aug 17, 2026");
    expect(ldn).toContain("Aug 18, 2026");
  });

  it("includes the year and a zone label so a travelling customer is never misled", () => {
    const html = emailTemplates.reminder(data, brand, WPG).html;
    expect(html).toContain("2026");
    expect(html).toMatch(/CDT|GMT-5/);
  });

  it("falls back to a dash rather than printing Invalid Date", () => {
    const bad = { ...data, scheduledAt: new Date(NaN) };
    const html = emailTemplates.reminder(bad, brand, WPG).html;
    expect(html).not.toContain("Invalid Date");
    expect(html).toContain("—");
  });
});

describe("money always carries a currency symbol", () => {
  it("formats a plain number as dollars and cents", () => {
    expect(money(149)).toBe("$149.00");
    expect(money(0)).toBe("$0.00");
    expect(money(1234.5)).toBe("$1,234.50");
  });

  it("the receipt Amount row is not a bare number", () => {
    const html = emailTemplates.receipt(data, brand, WPG).html;
    expect(html).toContain("$149.00");
  });

  it("the booking confirmation Total row is not a bare number", () => {
    const html = emailTemplates.bookingConfirmed(data, brand, WPG).html;
    expect(html).toContain("$149.00");
  });
});

describe("CTA links survive a WEBSITE_URL with no trailing slash", () => {
  it("joins with exactly one slash whatever the origin looks like", () => {
    expect(emailLink("https://uberize.ai", "track/bk_1")).toBe("https://uberize.ai/track/bk_1");
    expect(emailLink("https://uberize.ai/", "track/bk_1")).toBe("https://uberize.ai/track/bk_1");
    expect(emailLink("https://uberize.ai", "/track/bk_1")).toBe("https://uberize.ai/track/bk_1");
  });

  it("never emits the origin glued straight onto the path", () => {
    expect(emailLink("https://uberize.ai", "bookings")).not.toContain("aibookings");
  });
});
