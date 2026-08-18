/**
 * Configuration must be read when it is USED, not when the module is imported.
 *
 * This is the bug that broke CI for six straight commits while every local run
 * was green.
 *
 * `alerts.ts` and `rate-limit.ts` both captured their settings into module-level
 * consts at import time. Three test files set those same env vars at their own
 * module top level, then imported the module — which only works if that file
 * happens to be the FIRST one to pull the module in. Test files are executed in
 * directory-walk order, which is not sorted and differs between machines. In the
 * sandbox the ordering happened to be favourable; on the GitHub runner it was
 * not, so the module was already cached with defaults and:
 *   - alertsEnabled() was false, so every alerting assertion saw zero alerts
 *     (alerts.test.ts:54/71/84, rate-limit-degrade.test.ts:119)
 *   - the public track-write limiter kept its real 10/min budget, so the suite
 *     tripped its own limiter and a 201 came back 429 (track-public-input:249)
 * Four failures, one cause, invisible locally.
 *
 * Reading env at call time fixes it for real, and it is also the correct
 * production behaviour: nothing then depends on import order relative to
 * whatever loads the environment.
 *
 * These tests import both modules FIRST, with none of the env set, exactly the
 * way the runner did it — and then configure.
 */
import { describe, it, expect, afterAll, beforeEach } from "bun:test";
import { Hono } from "hono";

// --- imported BEFORE any of the env below is set. That is the whole point. ---
const { alertsEnabled, _resetAlerts } = await import("../alerts");
const { trackWriteLimiter } = await import("../rate-limit");
const { AppError } = await import("../errors");

const SAVED = {
  ALERT_WEBHOOK_URL: process.env.ALERT_WEBHOOK_URL,
  ALERT_EMAIL: process.env.ALERT_EMAIL,
  RL_TRACK_WRITE_LIMIT: process.env.RL_TRACK_WRITE_LIMIT,
};
afterAll(() => {
  // Config is live now, so leaking these would reconfigure other test files.
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetAlerts();
});

beforeEach(() => {
  delete process.env.ALERT_WEBHOOK_URL;
  delete process.env.ALERT_EMAIL;
  _resetAlerts();
});

describe("alert channels are resolved at call time, not at import", () => {
  it("reports disabled while nothing is configured", () => {
    expect(alertsEnabled()).toBe(false);
  });

  it("picks up a webhook configured AFTER the module was imported", () => {
    process.env.ALERT_WEBHOOK_URL = "https://example.test/hook";
    expect(alertsEnabled()).toBe(true);
  });

  it("picks up an email recipient configured AFTER the module was imported", () => {
    process.env.ALERT_EMAIL = "ops@example.test";
    expect(alertsEnabled()).toBe(true);
  });

  it("goes quiet again when the channel is removed", () => {
    process.env.ALERT_WEBHOOK_URL = "https://example.test/hook";
    expect(alertsEnabled()).toBe(true);
    delete process.env.ALERT_WEBHOOK_URL;
    expect(alertsEnabled()).toBe(false);
  });

  it("treats blank/whitespace config as unconfigured", () => {
    process.env.ALERT_WEBHOOK_URL = "   ";
    process.env.ALERT_EMAIL = " , ,";
    expect(alertsEnabled()).toBe(false);
  });
});

describe("rate-limit budgets are resolved at call time, not at import", () => {
  /** Hit the public track-write limiter n times on one token; collect statuses. */
  async function hits(n: number, token: string): Promise<number[]> {
    const app = new Hono();
    app.post("/track/:token/review", trackWriteLimiter, (c) => c.json({ ok: true }));
    // The limiter refuses by THROWING; without this the 429 surfaces as a 500
    // and the assertion below would be measuring the wrong thing.
    app.onError((err, c) =>
      err instanceof AppError
        ? c.json({ error: err.code }, err.status as 429)
        : c.json({ error: String(err) }, 500),
    );
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const res = await app.request(`/track/${token}/review`, {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.7" },
      });
      out.push(res.status);
    }
    return out;
  }

  it("enforces the real default budget when nothing overrides it", async () => {
    delete process.env.RL_TRACK_WRITE_LIMIT;
    const statuses = await hits(12, `dflt-${Date.now()}`);
    // Default is 10/min per token: the 11th and 12th must be refused.
    expect(statuses.filter((s) => s === 429).length).toBe(2);
  });

  it("honours a budget raised AFTER the module was imported", async () => {
    process.env.RL_TRACK_WRITE_LIMIT = "10000";
    const statuses = await hits(12, `raised-${Date.now()}`);
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it("honours a budget lowered AFTER the module was imported", async () => {
    process.env.RL_TRACK_WRITE_LIMIT = "2";
    const statuses = await hits(4, `lowered-${Date.now()}`);
    expect(statuses).toEqual([200, 200, 429, 429]);
  });

  it("ignores a non-numeric budget instead of refusing every request", async () => {
    // Number("nonsense") is NaN, and `count > NaN` is false — which would have
    // silently disabled the limiter. A bad value must fall back to the default.
    process.env.RL_TRACK_WRITE_LIMIT = "nonsense";
    const statuses = await hits(12, `bad-${Date.now()}`);
    expect(statuses.filter((s) => s === 429).length).toBe(2);
  });
});
