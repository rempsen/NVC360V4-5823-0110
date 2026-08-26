/**
 * A verified sending domain can go BAD after the fact, and nothing noticed.
 *
 * Found live on 2026-08-16: tenant_email_domains said nvc360.com was
 * "verified" (last checked Jul 2026) while Resend's own API said "failed" —
 * the DKIM TXT record had drifted. Every email from the default tenant was
 * quietly failing its first send and falling back, and the platform had no
 * idea, because rowsNeedingPoll() only ever returned rows in "pending" or
 * "verifying". Once a row reached "verified" it was never polled again, so a
 * DNS regression was permanently invisible.
 *
 * Fix: verified and failed rows get re-checked too, just on a slow cadence, so
 * a broken domain surfaces within hours instead of never.
 */
import { describe, it, expect } from "bun:test";

process.env.DATABASE_URL = "postgresql://placeholder:placeholder@localhost:5432/placeholder"; // never queried by this pure-logic test

const { needsPoll, RECHECK_MS } = await import("../email-domains");

const NOW = Date.parse("2026-08-16T22:00:00.000Z");
const ago = (ms: number) => NOW - ms;
const HOUR = 3_600_000;

describe("needsPoll — which sending domains get re-checked", () => {
  it("polls a domain still waiting on DNS, every tick", () => {
    expect(needsPoll({ status: "verifying", lastCheckedAt: ago(1000) }, NOW)).toBe(true);
    expect(needsPoll({ status: "pending", lastCheckedAt: ago(1000) }, NOW)).toBe(true);
  });

  it("re-checks a VERIFIED domain once the recheck window has passed", () => {
    // This is the case that was missing entirely.
    expect(needsPoll({ status: "verified", lastCheckedAt: ago(RECHECK_MS + HOUR) }, NOW)).toBe(true);
  });

  it("does not hammer Resend for a domain verified moments ago", () => {
    expect(needsPoll({ status: "verified", lastCheckedAt: ago(60_000) }, NOW)).toBe(false);
  });

  it("re-checks a FAILED domain too, so a DNS repair is picked up on its own", () => {
    expect(needsPoll({ status: "failed", lastCheckedAt: ago(RECHECK_MS + HOUR) }, NOW)).toBe(true);
    expect(needsPoll({ status: "failed", lastCheckedAt: ago(60_000) }, NOW)).toBe(false);
  });

  it("polls a row that has never been checked, whatever its status says", () => {
    expect(needsPoll({ status: "verified", lastCheckedAt: null }, NOW)).toBe(true);
    expect(needsPoll({ status: "failed", lastCheckedAt: undefined }, NOW)).toBe(true);
  });

  it("accepts a Date as well as an epoch, since the column round-trips as both", () => {
    expect(needsPoll({ status: "verified", lastCheckedAt: new Date(ago(RECHECK_MS + HOUR)) }, NOW)).toBe(true);
    expect(needsPoll({ status: "verified", lastCheckedAt: new Date(ago(60_000)) }, NOW)).toBe(false);
  });

  it("leaves an unknown status alone rather than guessing", () => {
    expect(needsPoll({ status: "draft", lastCheckedAt: null }, NOW)).toBe(false);
  });

  it("re-checks slowly enough to be cheap but often enough to matter", () => {
    // The bug went unseen for weeks. Anything from an hour to a day is sane;
    // the poller runs every 2 minutes, so this is what stops it stampeding.
    expect(RECHECK_MS).toBeGreaterThanOrEqual(HOUR);
    expect(RECHECK_MS).toBeLessThanOrEqual(24 * HOUR);
  });
});
