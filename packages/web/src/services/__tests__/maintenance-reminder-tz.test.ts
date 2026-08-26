/**
 * The maintenance reminder SMS must quote the DUE DATE on the tenant's clock.
 *
 * The bug: the copy was built with `new Date(nextDueAt).toLocaleDateString(
 * "en-US", {...})`, which on this server (UTC) renders the UTC calendar day.
 * For a Winnipeg tenant, anything due after 19:00 local is already tomorrow in
 * UTC — so a plan due Aug 17 at 8pm texted the customer "due Aug 18". Wrong
 * day, in a message the customer acts on.
 *
 * Pure copy builder, so this pins the words that actually go out.
 */
import { describe, it, expect } from "bun:test";

// The module pulls in the DB client at import time; keep it ephemeral so this
// pure-copy test never reaches for real credentials.
process.env.DATABASE_URL = "postgresql://placeholder:placeholder@localhost:5432/placeholder"; // never queried by this pure-logic test
const { maintenanceReminderCopy } = await import("../maintenance");

// Due Aug 17, 2026 at 8:00 PM Winnipeg = Aug 18, 01:00 UTC.
const DUE = Date.parse("2026-08-18T01:00:00.000Z");

const base = {
  company: "NVC360",
  what: "Furnace tune-up",
  dueAt: DUE,
  address: "123 Main St",
  hubUrl: "https://nvc360.com/p/abc",
};

describe("maintenanceReminderCopy", () => {
  it("quotes the due date on the tenant's clock", () => {
    const c = maintenanceReminderCopy({ ...base, tz: "America/Winnipeg" });
    expect(c.due).toBe("Aug 17");
    expect(c.sms).toContain("due Aug 17");
  });

  it("is the bug when formatted on the server's UTC clock", () => {
    expect(maintenanceReminderCopy({ ...base, tz: "UTC" }).due).toBe("Aug 18");
  });

  it("keeps the rest of the SMS intact", () => {
    const c = maintenanceReminderCopy({ ...base, tz: "America/Winnipeg" });
    expect(c.sms).toBe(
      "NVC360: Furnace tune-up is due Aug 17 at 123 Main St. Reply to book a time. Service history: https://nvc360.com/p/abc",
    );
  });

  it("drops the address and hub link when there aren't any", () => {
    const c = maintenanceReminderCopy({
      company: "NVC360",
      what: "Furnace tune-up",
      dueAt: DUE,
      address: "",
      hubUrl: "",
      tz: "America/Winnipeg",
    });
    expect(c.sms).toBe("NVC360: Furnace tune-up is due Aug 17. Reply to book a time.");
  });

  it("says 'soon' rather than a dash when a plan has no due date", () => {
    const c = maintenanceReminderCopy({ ...base, dueAt: null, tz: "America/Winnipeg" });
    expect(c.due).toBe("soon");
    expect(c.sms).toContain("is due soon");
  });

  it("titles the office notification with the same date the customer was texted", () => {
    const c = maintenanceReminderCopy({ ...base, tz: "America/Winnipeg" });
    expect(c.officeTitle).toBe("Furnace tune-up due Aug 17");
  });

  it("falls back to the default zone on a junk tenant timezone", () => {
    expect(maintenanceReminderCopy({ ...base, tz: "Not/AZone" }).due).toBe("Aug 17");
  });
});
