/**
 * Double-booking and time-off arithmetic. Every case here was previously
 * unenforced: the dispatch board would send one tech to two addresses at the same
 * hour, and `tech_shifts` was written by the UI and read by nothing.
 */
import { describe, it, expect } from "bun:test";
import {
  DEFAULT_JOB_MINUTES,
  jobMinutes,
  jobWindow,
  windowsOverlap,
  findOverlappingJob,
  findTimeOff,
  overlapMessage,
  timeOffMessage,
  clockLabel,
} from "../availability";

const TZ = "America/Winnipeg";
const RIDER = "r1";
// 2026-08-18 14:00 in Winnipeg (CDT, UTC-5) = 19:00Z
const TWO_PM = Date.UTC(2026, 7, 18, 19, 0, 0);
const HOUR = 3_600_000;

describe("jobMinutes", () => {
  it("falls back to an hour when the service has no duration", () => {
    expect(jobMinutes(null)).toBe(DEFAULT_JOB_MINUTES);
    expect(jobMinutes(undefined)).toBe(DEFAULT_JOB_MINUTES);
  });

  it("never lets bad data shrink the window to nothing", () => {
    // A 0 or negative duration would make every window zero-length and quietly
    // disable double-booking detection entirely.
    expect(jobMinutes(0)).toBe(DEFAULT_JOB_MINUTES);
    expect(jobMinutes(-30)).toBe(DEFAULT_JOB_MINUTES);
    expect(jobMinutes(Number.NaN)).toBe(DEFAULT_JOB_MINUTES);
    expect(jobMinutes("abc" as unknown as number)).toBe(DEFAULT_JOB_MINUTES);
    expect(jobMinutes(5)).toBe(15);
  });

  it("caps a runaway duration at a day", () => {
    expect(jobMinutes(99_999)).toBe(1440);
  });

  it("uses the real duration when it is sane", () => {
    expect(jobMinutes(90)).toBe(90);
  });
});

describe("jobWindow", () => {
  it("is null for a job with no date", () => {
    expect(jobWindow({ scheduledAt: null })).toBeNull();
  });

  it("spans the service duration", () => {
    expect(jobWindow({ scheduledAt: TWO_PM, durationMins: 90 })).toEqual({
      start: TWO_PM,
      end: TWO_PM + 90 * 60_000,
    });
  });

  it("accepts a Date as well as ms", () => {
    expect(jobWindow({ scheduledAt: new Date(TWO_PM), durationMins: 60 })?.start).toBe(TWO_PM);
  });
});

describe("windowsOverlap", () => {
  it("is half-open: back-to-back jobs do not clash", () => {
    const a = { start: TWO_PM, end: TWO_PM + HOUR };
    const b = { start: TWO_PM + HOUR, end: TWO_PM + 2 * HOUR };
    expect(windowsOverlap(a, b)).toBe(false);
  });

  it("catches a partial overlap in both directions", () => {
    const a = { start: TWO_PM, end: TWO_PM + HOUR };
    const b = { start: TWO_PM + HOUR / 2, end: TWO_PM + 2 * HOUR };
    expect(windowsOverlap(a, b)).toBe(true);
    expect(windowsOverlap(b, a)).toBe(true);
  });

  it("catches one job fully inside another", () => {
    const long = { start: TWO_PM, end: TWO_PM + 4 * HOUR };
    const short = { start: TWO_PM + HOUR, end: TWO_PM + 2 * HOUR };
    expect(windowsOverlap(long, short)).toBe(true);
  });
});

describe("findOverlappingJob", () => {
  const candidate = { id: "new", riderId: RIDER, scheduledAt: TWO_PM, durationMins: 60 };

  it("finds the same tech booked at the same time", () => {
    const clash = findOverlappingJob(candidate, [
      { id: "other", riderId: RIDER, scheduledAt: TWO_PM, durationMins: 60, status: "assigned", title: "Furnace swap" },
    ]);
    expect(clash?.id).toBe("other");
  });

  it("ignores another technician's job at the same time", () => {
    expect(
      findOverlappingJob(candidate, [
        { id: "other", riderId: "r2", scheduledAt: TWO_PM, durationMins: 60, status: "assigned" },
      ]),
    ).toBeNull();
  });

  it("ignores the job being moved", () => {
    expect(
      findOverlappingJob(candidate, [
        { id: "new", riderId: RIDER, scheduledAt: TWO_PM, durationMins: 60, status: "assigned" },
      ]),
    ).toBeNull();
  });

  it("ignores completed and cancelled work", () => {
    for (const status of ["completed", "cancelled"]) {
      expect(
        findOverlappingJob(candidate, [
          { id: "old", riderId: RIDER, scheduledAt: TWO_PM, durationMins: 60, status },
        ]),
      ).toBeNull();
    }
  });

  it("ignores jobs that have no date yet", () => {
    expect(
      findOverlappingJob(candidate, [
        { id: "backlog", riderId: RIDER, scheduledAt: null, status: "confirmed" },
      ]),
    ).toBeNull();
  });

  it("is null when the candidate itself has no date", () => {
    expect(
      findOverlappingJob({ riderId: RIDER, scheduledAt: null }, [
        { id: "other", riderId: RIDER, scheduledAt: TWO_PM, status: "assigned" },
      ]),
    ).toBeNull();
  });
});

describe("findTimeOff", () => {
  // The picker stores the chosen day; the day key is resolved in the company zone.
  const dayOff = Date.UTC(2026, 7, 18, 5, 0, 0); // 2026-08-18 00:00 Winnipeg

  it("blocks a job on a day the tech booked off", () => {
    const hit = findTimeOff({ riderId: RIDER, scheduledAt: TWO_PM }, [
      { id: "s1", riderId: RIDER, kind: "timeoff", date: dayOff, note: "Vacation" },
    ], TZ);
    expect(hit?.id).toBe("s1");
  });

  it("ignores a regular shift row", () => {
    expect(
      findTimeOff({ riderId: RIDER, scheduledAt: TWO_PM }, [
        { id: "s1", riderId: RIDER, kind: "shift", date: dayOff, startMin: 540, endMin: 1020 },
      ], TZ),
    ).toBeNull();
  });

  it("ignores time off for a different tech or a different day", () => {
    expect(
      findTimeOff({ riderId: RIDER, scheduledAt: TWO_PM }, [
        { id: "s1", riderId: "r2", kind: "timeoff", date: dayOff },
        { id: "s2", riderId: RIDER, kind: "timeoff", date: dayOff + 24 * HOUR },
      ], TZ),
    ).toBeNull();
  });

  it("uses the company zone, not UTC, for 'which day is this'", () => {
    // 2026-08-19 00:30Z is still Aug 18 in Winnipeg — the evening of the day off.
    const lateEvening = Date.UTC(2026, 7, 19, 0, 30, 0);
    expect(
      findTimeOff({ riderId: RIDER, scheduledAt: lateEvening }, [
        { id: "s1", riderId: RIDER, kind: "timeoff", date: dayOff },
      ], TZ),
    ).not.toBeNull();
  });
});

describe("messages the dispatcher reads", () => {
  it("names the time on the company clock, not the server's", () => {
    expect(clockLabel(TWO_PM, TZ)).toBe("2:00 PM");
  });

  it("says who, when and what for a double booking", () => {
    const msg = overlapMessage(
      "Mike",
      { id: "x", riderId: RIDER, scheduledAt: TWO_PM, status: "assigned", title: "Furnace swap" },
      TZ,
    );
    expect(msg).toBe('Mike is already booked at 2:00 PM — "Furnace swap".');
  });

  it("falls back to the worker noun when the tech has no name", () => {
    const msg = overlapMessage("", { id: "x", riderId: RIDER, scheduledAt: TWO_PM, status: "assigned" }, TZ, "cleaner");
    expect(msg).toContain("This cleaner is already booked");
    expect(msg).toContain("another job");
  });

  it("mentions the time-off note when there is one", () => {
    expect(timeOffMessage("Mike", { id: "s", riderId: RIDER, kind: "timeoff", date: TWO_PM, note: "Vacation" }))
      .toBe("Mike has time off booked that day (Vacation).");
    expect(timeOffMessage("Mike", { id: "s", riderId: RIDER, kind: "timeoff", date: TWO_PM }))
      .toBe("Mike has time off booked that day.");
  });
});
