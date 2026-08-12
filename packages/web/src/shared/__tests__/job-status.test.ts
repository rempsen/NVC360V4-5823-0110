import { describe, expect, it } from "bun:test";
import {
  JOB_STEPS,
  statusStepIndex,
  isKnownStatus,
  isTerminalStatus,
  isActiveStatus,
  isOpenStatus,
  ACTIVE_STATUSES,
  OPEN_STATUSES,
} from "../job-status";

/** Every status value the bookings API can put on a row. */
const ALL_STATUSES = [
  "pending", "confirmed", "assigned", "enroute", "arrived", "onsite",
  "in_progress", "paused", "completed", "cancelled",
];

describe("statusStepIndex", () => {
  it("knows every status the API can return", () => {
    for (const s of ALL_STATUSES) expect(isKnownStatus(s)).toBe(true);
  });

  it("never moves backwards as a job progresses", () => {
    const order = ["confirmed", "assigned", "enroute", "arrived", "onsite", "in_progress", "paused", "completed"];
    let prev = -1;
    for (const s of order) {
      const i = statusStepIndex(s);
      expect(i).toBeGreaterThanOrEqual(prev);
      prev = i;
    }
  });

  it("keeps onsite at the arrived stage and paused at the in-progress stage", () => {
    expect(statusStepIndex("onsite")).toBe(statusStepIndex("arrived"));
    expect(statusStepIndex("paused")).toBe(statusStepIndex("in_progress"));
  });

  it("puts completed at the last stage", () => {
    expect(statusStepIndex("completed")).toBe(JOB_STEPS.length - 1);
  });

  it("falls back to the first stage, never -1, on junk", () => {
    for (const v of ["nonsense", "", undefined, null, 3, {}])
      expect(statusStepIndex(v)).toBe(0);
  });
});

describe("isActiveStatus", () => {
  it("is true while a tech is engaged, including on site and paused", () => {
    for (const s of ACTIVE_STATUSES) expect(isActiveStatus(s)).toBe(true);
    expect(isActiveStatus("onsite")).toBe(true);
    expect(isActiveStatus("paused")).toBe(true);
  });
  it("is false before assignment and after the job ends", () => {
    for (const s of ["pending", "confirmed", "completed", "cancelled", "junk", undefined])
      expect(isActiveStatus(s)).toBe(false);
  });
});

describe("isOpenStatus", () => {
  it("covers everything a customer would call their current booking", () => {
    for (const s of OPEN_STATUSES) expect(isOpenStatus(s)).toBe(true);
    for (const s of ["onsite", "paused"]) expect(isOpenStatus(s)).toBe(true);
  });
  it("excludes finished jobs", () => {
    expect(isOpenStatus("completed")).toBe(false);
    expect(isOpenStatus("cancelled")).toBe(false);
  });
});

describe("isTerminalStatus", () => {
  it("is only completed and cancelled", () => {
    for (const s of ALL_STATUSES)
      expect(isTerminalStatus(s)).toBe(s === "completed" || s === "cancelled");
  });
});
