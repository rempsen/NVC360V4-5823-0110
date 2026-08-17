/**
 * Slot grouping for the customer's "choose a time" step.
 *
 * What was broken: the booking page rendered `nextSlots()` as one flat wrap of
 * up to 25 buttons labelled "Mon, Aug 18, 9 AM". On a phone that is a wall of
 * near-identical text where the day is buried mid-label, and customers pick the
 * wrong DAY (right time, wrong date) — the most expensive kind of booking
 * mistake, because the truck rolls.
 *
 * The reschedule modal already grouped by day with a private helper. Rather
 * than write that logic a second time, it moves here as a tested pure function
 * both screens use, so the two can never disagree about which day a slot is on.
 *
 * Every case below pins the grouping to the COMPANY's clock, not the browser's.
 */
import { describe, it, expect } from "bun:test";
import { groupSlotsByDay, resolveSelectedDay } from "../slot-days";

/** 9 AM and 5 PM Winnipeg (CDT, UTC-5) on Aug 18 2026, plus 9 AM Aug 19. */
const AUG18_9AM = "2026-08-18T14:00:00.000Z";
const AUG18_5PM = "2026-08-18T22:00:00.000Z";
const AUG19_9AM = "2026-08-19T14:00:00.000Z";
const WPG = "America/Winnipeg";

const slot = (value: string) => ({ label: "ignored", value });

describe("groupSlotsByDay", () => {
  it("buckets slots into calendar days on the company's clock", () => {
    const days = groupSlotsByDay([slot(AUG18_9AM), slot(AUG18_5PM), slot(AUG19_9AM)], WPG);
    expect(days.map((d) => d.key)).toEqual(["2026-08-18", "2026-08-19"]);
    expect(days[0].times.map((t) => t.value)).toEqual([AUG18_9AM, AUG18_5PM]);
    expect(days[1].times).toHaveLength(1);
  });

  it("groups by the COMPANY's day, not UTC — a 5 PM Winnipeg slot is not tomorrow", () => {
    // 10 PM UTC on Aug 18 is still Aug 18 in Winnipeg but Aug 18 in UTC too;
    // 7 PM Winnipeg (Aug 19 00:00Z) is the case that used to roll over.
    const evening = "2026-08-19T00:00:00.000Z"; // 7 PM Aug 18 in Winnipeg
    const wpg = groupSlotsByDay([slot(AUG18_9AM), slot(evening)], WPG);
    expect(wpg).toHaveLength(1);
    expect(wpg[0].key).toBe("2026-08-18");

    const utc = groupSlotsByDay([slot(AUG18_9AM), slot(evening)], "UTC");
    expect(utc).toHaveLength(2);
  });

  it("labels the day for humans and the time without repeating the date", () => {
    const [d] = groupSlotsByDay([slot(AUG18_9AM)], WPG);
    expect(d.label).toBe("Tuesday, Aug 18");
    expect(d.weekday).toBe("Tue");
    expect(d.dayNum).toBe("18");
    expect(d.times[0].label).toBe("9:00 AM");
  });

  it("marks today and tomorrow relative to the company's clock", () => {
    const now = new Date(AUG18_9AM); // Tue Aug 18, mid-morning Winnipeg
    const days = groupSlotsByDay([slot(AUG18_5PM), slot(AUG19_9AM)], WPG, now);
    expect(days[0].relative).toBe("Today");
    expect(days[1].relative).toBe("Tomorrow");
  });

  it("leaves later days unlabelled rather than inventing a relative name", () => {
    const days = groupSlotsByDay([slot(AUG18_9AM)], WPG, new Date("2026-08-10T14:00:00.000Z"));
    expect(days[0].relative).toBe("");
  });

  it("returns nothing for an empty slot list instead of an empty day", () => {
    expect(groupSlotsByDay([], WPG)).toEqual([]);
  });

  it("orders days chronologically even if the input is not", () => {
    const days = groupSlotsByDay([slot(AUG19_9AM), slot(AUG18_9AM)], WPG);
    expect(days.map((d) => d.key)).toEqual(["2026-08-18", "2026-08-19"]);
  });
});

describe("resolveSelectedDay", () => {
  const days = groupSlotsByDay([slot(AUG18_9AM), slot(AUG19_9AM)], WPG);

  it("defaults to the first day with an open slot", () => {
    expect(resolveSelectedDay(days, "", "")).toBe("2026-08-18");
  });

  it("keeps the customer's chosen day", () => {
    expect(resolveSelectedDay(days, "2026-08-19", "")).toBe("2026-08-19");
  });

  it("opens on the day of an already-picked slot when no day was tapped", () => {
    expect(resolveSelectedDay(days, "", AUG19_9AM)).toBe("2026-08-19");
  });

  it("lets the tapped day win over the picked slot — browsing must still work", () => {
    // Regression: with the slot winning, the day row went dead once a time was
    // picked. Tapping Wednesday snapped straight back to Tuesday, because
    // Tuesday still owned the selection.
    expect(resolveSelectedDay(days, "2026-08-19", AUG18_9AM)).toBe("2026-08-19");
  });

  it("falls back to the first day when the chosen day has expired", () => {
    expect(resolveSelectedDay(days, "2026-08-01", "")).toBe("2026-08-18");
  });

  it("falls back to the picked slot's day when the browsed day has expired", () => {
    expect(resolveSelectedDay(days, "2026-08-01", AUG19_9AM)).toBe("2026-08-19");
  });

  it("returns an empty key when there are no days at all", () => {
    expect(resolveSelectedDay([], "2026-08-18", AUG18_9AM)).toBe("");
  });
});
