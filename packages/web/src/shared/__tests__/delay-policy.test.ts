import { describe, it, expect } from "bun:test";
import {
  evaluateDelay,
  roundedSlip,
  DEFAULT_DELAY_POLICY,
  type DelayInputs,
} from "../delay-policy";

const MIN = 60_000;
const NOW = Date.parse("2026-08-15T14:00:00.000Z");

function inputs(over: Partial<DelayInputs> = {}): DelayInputs {
  return {
    now: NOW,
    scheduledAt: NOW - 20 * MIN, // 20 minutes past the promised time
    status: "assigned",
    etaMins: null,
    policy: DEFAULT_DELAY_POLICY,
    flaggedAt: null,
    notifiedAt: null,
    notifiedMins: null,
    muted: false,
    ...over,
  };
}

describe("delay policy — defaults", () => {
  it("defaults to a 15 minute threshold and a 10 minute dispatcher grace", () => {
    expect(DEFAULT_DELAY_POLICY.thresholdMins).toBe(15);
    expect(DEFAULT_DELAY_POLICY.autoSendAfterMins).toBe(10);
    expect(DEFAULT_DELAY_POLICY.enabled).toBe(true);
  });
});

describe("delay policy — detection", () => {
  it("flags a job whose tech never started the drive", () => {
    const d = evaluateDelay(inputs());
    expect(d.late).toBe(true);
    expect(d.slipMins).toBe(20);
    expect(d.reason).toBe("not_started");
    expect(d.action).toBe("flag");
  });

  it("stays quiet inside the threshold", () => {
    const d = evaluateDelay(inputs({ scheduledAt: NOW - 9 * MIN }));
    expect(d.late).toBe(false);
    expect(d.action).toBe("none");
  });

  it("is quiet before the appointment time", () => {
    const d = evaluateDelay(inputs({ scheduledAt: NOW + 60 * MIN }));
    expect(d.late).toBe(false);
    expect(d.slipMins).toBe(0);
  });

  it("projects arrival from the live ETA once the tech is enroute", () => {
    // On time by the clock, but the ETA says arrival is 25 min past the promise.
    const d = evaluateDelay(
      inputs({ status: "enroute", scheduledAt: NOW + 5 * MIN, etaMins: 30 }),
    );
    expect(d.late).toBe(true);
    expect(d.slipMins).toBe(25);
    expect(d.reason).toBe("eta_overrun");
  });

  it("an enroute tech arriving on time is not late", () => {
    const d = evaluateDelay(
      inputs({ status: "enroute", scheduledAt: NOW + 30 * MIN, etaMins: 10 }),
    );
    expect(d.late).toBe(false);
  });

  it("falls back to the clock when an enroute tech has no ETA yet", () => {
    const d = evaluateDelay(inputs({ status: "enroute", etaMins: null }));
    expect(d.late).toBe(true);
    expect(d.reason).toBe("not_started");
  });

  it("never guesses without a scheduled time", () => {
    const d = evaluateDelay(inputs({ scheduledAt: null }));
    expect(d.late).toBe(false);
    expect(d.action).toBe("none");
  });

  it("stops watching once the tech is on site or the job is done", () => {
    for (const status of ["arrived", "onsite", "in_progress", "paused", "completed", "cancelled"]) {
      const d = evaluateDelay(inputs({ status }));
      expect(d.action).toBe("none");
      expect(d.late).toBe(false);
    }
  });

  it("does nothing at all when the tenant turned the feature off", () => {
    const d = evaluateDelay(
      inputs({ policy: { ...DEFAULT_DELAY_POLICY, enabled: false } }),
    );
    expect(d.late).toBe(false);
    expect(d.action).toBe("none");
  });
});

describe("delay policy — who sends, and when", () => {
  it("waits for the dispatcher during the grace period", () => {
    const d = evaluateDelay(inputs({ flaggedAt: NOW - 4 * MIN }));
    expect(d.action).toBe("none");
    expect(d.autoSendAt).toBe(NOW - 4 * MIN + 10 * MIN);
  });

  it("auto-sends once the grace period lapses with nobody acting", () => {
    const d = evaluateDelay(inputs({ flaggedAt: NOW - 11 * MIN }));
    expect(d.action).toBe("notify");
  });

  it("never auto-sends when the tenant set the grace to 0 (dispatcher only)", () => {
    const d = evaluateDelay(
      inputs({
        flaggedAt: NOW - 600 * MIN,
        policy: { ...DEFAULT_DELAY_POLICY, autoSendAfterMins: 0 },
      }),
    );
    expect(d.action).toBe("none");
    expect(d.autoSendAt).toBe(null);
  });

  it("a muted job is never auto-sent", () => {
    const d = evaluateDelay(inputs({ flaggedAt: NOW - 60 * MIN, muted: true }));
    expect(d.action).toBe("none");
    expect(d.late).toBe(true);
  });
});

describe("delay policy — not nagging", () => {
  it("does not repeat the same notice", () => {
    const d = evaluateDelay(
      inputs({ flaggedAt: NOW - 60 * MIN, notifiedAt: NOW - 40 * MIN, notifiedMins: 20 }),
    );
    expect(d.action).toBe("none");
  });

  it("re-notifies when the slip grows by another full threshold", () => {
    const d = evaluateDelay(
      inputs({
        scheduledAt: NOW - 50 * MIN,
        flaggedAt: NOW - 60 * MIN,
        notifiedAt: NOW - 40 * MIN,
        notifiedMins: 20,
      }),
    );
    expect(d.slipMins).toBe(50);
    expect(d.action).toBe("notify");
  });

  it("holds a second notice back until at least 30 minutes have passed", () => {
    const d = evaluateDelay(
      inputs({
        scheduledAt: NOW - 50 * MIN,
        flaggedAt: NOW - 20 * MIN,
        notifiedAt: NOW - 10 * MIN,
        notifiedMins: 20,
      }),
    );
    expect(d.action).toBe("none");
  });

  it("clears the flag when the job catches back up", () => {
    const d = evaluateDelay(
      inputs({ status: "enroute", scheduledAt: NOW + 20 * MIN, etaMins: 5, flaggedAt: NOW - 5 * MIN }),
    );
    expect(d.late).toBe(false);
    expect(d.action).toBe("clear");
  });
});

describe("roundedSlip — what the customer actually reads", () => {
  it("rounds to a human 5 minutes so nobody reads '17 minutes late'", () => {
    expect(roundedSlip(17)).toBe(15);
    expect(roundedSlip(23)).toBe(25);
  });

  it("never rounds down to zero", () => {
    expect(roundedSlip(2)).toBe(5);
  });

  it("rounds long slips to a quarter hour", () => {
    expect(roundedSlip(94)).toBe(90);
  });
});
