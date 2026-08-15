/**
 * Customer-initiated appointment changes.
 *
 * The rules here are a corporate decision, not a UI detail: an SMB dispatch
 * board cannot have jobs vanishing out of it on their own. Reschedule is the
 * safe release valve (the job is kept, only the time moves); cancelling is
 * always a REQUEST the office approves. Both are per-tenant switchable, and
 * both hard-stop once a technician is actually on the move.
 */
import { describe, it, expect } from "bun:test";
import { evaluateChangePolicy, DEFAULT_CHANGE_POLICY } from "../change-policy";

const NOW = new Date("2026-08-14T15:00:00.000Z");
const H = 3_600_000;
const at = (hoursFromNow: number) => new Date(NOW.getTime() + hoursFromNow * H);

describe("evaluateChangePolicy", () => {
  it("lets a customer self-serve reschedule well outside the cutoff", () => {
    const d = evaluateChangePolicy({
      status: "confirmed",
      scheduledAt: at(48),
      now: NOW,
      policy: DEFAULT_CHANGE_POLICY,
    });
    expect(d.reschedule).toBe("self_serve");
    expect(d.cancel).toBe("request");
    expect(d.withinCutoff).toBe(false);
  });

  it("downgrades reschedule to an approval request inside the cutoff", () => {
    const d = evaluateChangePolicy({
      status: "confirmed",
      scheduledAt: at(6), // default cutoff is 12h
      now: NOW,
      policy: DEFAULT_CHANGE_POLICY,
    });
    expect(d.withinCutoff).toBe(true);
    expect(d.reschedule).toBe("request");
    expect(d.cancel).toBe("request");
  });

  it("NEVER lets a customer cancel outright — cancel is always a request", () => {
    for (const hrs of [72, 24, 13, 12, 2, 0.5]) {
      const d = evaluateChangePolicy({
        status: "confirmed",
        scheduledAt: at(hrs),
        now: NOW,
        policy: DEFAULT_CHANGE_POLICY,
      });
      expect(d.cancel).not.toBe("self_serve");
    }
  });

  it("hard-blocks both once the tech is on the move or on site", () => {
    for (const status of ["enroute", "arrived", "in_progress", "onsite", "paused"]) {
      const d = evaluateChangePolicy({
        status,
        scheduledAt: at(1),
        now: NOW,
        policy: DEFAULT_CHANGE_POLICY,
      });
      expect(d.reschedule).toBe("blocked");
      expect(d.cancel).toBe("blocked");
      expect(d.blockedReason).toBeTruthy();
    }
  });

  it("hard-blocks a finished or already-cancelled job", () => {
    for (const status of ["completed", "cancelled"]) {
      const d = evaluateChangePolicy({
        status,
        scheduledAt: at(-4),
        now: NOW,
        policy: DEFAULT_CHANGE_POLICY,
      });
      expect(d.reschedule).toBe("blocked");
      expect(d.cancel).toBe("blocked");
    }
  });

  it("respects the per-tenant switches independently", () => {
    const noResched = evaluateChangePolicy({
      status: "confirmed",
      scheduledAt: at(48),
      now: NOW,
      policy: { ...DEFAULT_CHANGE_POLICY, allowReschedule: false },
    });
    expect(noResched.reschedule).toBe("blocked");
    expect(noResched.cancel).toBe("request");

    const noCancel = evaluateChangePolicy({
      status: "confirmed",
      scheduledAt: at(48),
      now: NOW,
      policy: { ...DEFAULT_CHANGE_POLICY, allowCancelRequest: false },
    });
    expect(noCancel.reschedule).toBe("self_serve");
    expect(noCancel.cancel).toBe("blocked");
  });

  it("honours a custom cutoff, including 0 = no cutoff", () => {
    const tight = evaluateChangePolicy({
      status: "confirmed",
      scheduledAt: at(3),
      now: NOW,
      policy: { ...DEFAULT_CHANGE_POLICY, cutoffHours: 2 },
    });
    expect(tight.withinCutoff).toBe(false);
    expect(tight.reschedule).toBe("self_serve");

    const none = evaluateChangePolicy({
      status: "confirmed",
      scheduledAt: at(0.25),
      now: NOW,
      policy: { ...DEFAULT_CHANGE_POLICY, cutoffHours: 0 },
    });
    expect(none.withinCutoff).toBe(false);
    expect(none.reschedule).toBe("self_serve");
  });

  it("treats an appointment already in the past as inside the cutoff", () => {
    const d = evaluateChangePolicy({
      status: "confirmed",
      scheduledAt: at(-2),
      now: NOW,
      policy: DEFAULT_CHANGE_POLICY,
    });
    expect(d.withinCutoff).toBe(true);
    expect(d.reschedule).toBe("request");
  });

  it("accepts a ms timestamp as well as a Date", () => {
    const d = evaluateChangePolicy({
      status: "pending",
      scheduledAt: at(48).getTime(),
      now: NOW,
      policy: DEFAULT_CHANGE_POLICY,
    });
    expect(d.reschedule).toBe("self_serve");
  });

  it("blocks rather than guesses when the schedule is unusable", () => {
    const d = evaluateChangePolicy({
      status: "confirmed",
      scheduledAt: null,
      now: NOW,
      policy: DEFAULT_CHANGE_POLICY,
    });
    expect(d.reschedule).toBe("blocked");
    expect(d.cancel).toBe("blocked");
  });

  it("rejects a proposed new time that is in the past or unparseable", () => {
    const d = evaluateChangePolicy({
      status: "confirmed",
      scheduledAt: at(48),
      now: NOW,
      policy: DEFAULT_CHANGE_POLICY,
    });
    expect(d.reschedule).toBe("self_serve");
    // the evaluator also owns validating the requested target time
    expect(d.isValidTarget(at(72))).toBe(true);
    expect(d.isValidTarget(at(-1))).toBe(false);
    expect(d.isValidTarget(new Date("nope"))).toBe(false);
  });
});
