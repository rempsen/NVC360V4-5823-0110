import { describe, expect, it } from "bun:test";
import {
  isTerminalStatus,
  isDeadLinkError,
  publicSendErrorMessage,
  trackPollMs,
  messagesPollMs,
  shouldStreamLive,
  sseRetryDelayMs,
  TRACK_POLL_LIVE_MS,
  TRACK_POLL_SSE_MS,
  MSGS_POLL_LIVE_MS,
  MSGS_POLL_DONE_MS,
  SSE_RETRY_MAX_MS,
} from "../track-live";

describe("isTerminalStatus", () => {
  it("is true only for completed and cancelled", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
    for (const s of ["pending", "confirmed", "assigned", "enroute", "arrived", "onsite", "in_progress", "paused"])
      expect(isTerminalStatus(s)).toBe(false);
  });
  it("never throws on junk", () => {
    for (const v of [undefined, null, 0, {}, [], NaN]) expect(isTerminalStatus(v)).toBe(false);
  });
});

describe("isDeadLinkError", () => {
  it("treats 404 and 410 as a permanently dead public link", () => {
    expect(isDeadLinkError({ status: 404 })).toBe(true);
    expect(isDeadLinkError({ status: 410 })).toBe(true);
  });
  it("does not treat a recoverable failure as dead", () => {
    for (const s of [0, 401, 403, 429, 500, 502, 503])
      expect(isDeadLinkError({ status: s })).toBe(false);
  });
  it("never throws on a non-ApiError value", () => {
    for (const v of [undefined, null, new Error("offline"), "404", {}, 404])
      expect(isDeadLinkError(v)).toBe(false);
  });
});

describe("trackPollMs", () => {
  it("polls fast while the job is live and SSE is down", () => {
    expect(trackPollMs({ status: "enroute", sseUp: false })).toBe(TRACK_POLL_LIVE_MS);
  });
  it("backs off to a safety poll once SSE is carrying updates", () => {
    expect(trackPollMs({ status: "enroute", sseUp: true })).toBe(TRACK_POLL_SSE_MS);
  });
  it("stops entirely on a finished job — the snapshot can never change again", () => {
    expect(trackPollMs({ status: "completed", sseUp: false })).toBe(false);
    expect(trackPollMs({ status: "cancelled", sseUp: true })).toBe(false);
  });
  it("stops entirely on an invalid or expired link", () => {
    expect(trackPollMs({ invalid: true })).toBe(false);
    expect(trackPollMs({ invalid: true, status: "enroute" })).toBe(false);
  });
  it("polls while we still know nothing (first load)", () => {
    expect(trackPollMs({})).toBe(TRACK_POLL_LIVE_MS);
  });
});

describe("messagesPollMs", () => {
  it("polls fast during the job", () => {
    expect(messagesPollMs({ status: "in_progress" })).toBe(MSGS_POLL_LIVE_MS);
  });
  it("keeps polling slowly after completion — the thread stays open", () => {
    expect(messagesPollMs({ status: "completed" })).toBe(MSGS_POLL_DONE_MS);
    expect(messagesPollMs({ status: "cancelled" })).toBe(MSGS_POLL_DONE_MS);
  });
  it("stops on an invalid link", () => {
    expect(messagesPollMs({ invalid: true, status: "completed" })).toBe(false);
  });
});

describe("shouldStreamLive", () => {
  it("streams only for a live, valid job", () => {
    expect(shouldStreamLive({ status: "enroute" })).toBe(true);
    expect(shouldStreamLive({})).toBe(true);
    expect(shouldStreamLive({ status: "completed" })).toBe(false);
    expect(shouldStreamLive({ status: "cancelled" })).toBe(false);
    expect(shouldStreamLive({ invalid: true })).toBe(false);
  });
});

describe("sseRetryDelayMs", () => {
  it("backs off exponentially from 2s", () => {
    expect(sseRetryDelayMs(1)).toBe(2_000);
    expect(sseRetryDelayMs(2)).toBe(4_000);
    expect(sseRetryDelayMs(3)).toBe(8_000);
    expect(sseRetryDelayMs(4)).toBe(16_000);
    expect(sseRetryDelayMs(5)).toBe(32_000);
  });
  it("caps so a hopeless link costs almost nothing", () => {
    expect(sseRetryDelayMs(6)).toBe(SSE_RETRY_MAX_MS);
    expect(sseRetryDelayMs(50)).toBe(SSE_RETRY_MAX_MS);
  });
  it("treats junk attempt numbers as the first failure", () => {
    expect(sseRetryDelayMs(0)).toBe(2_000);
    expect(sseRetryDelayMs(-3)).toBe(2_000);
    expect(sseRetryDelayMs(NaN)).toBe(2_000);
  });
});

describe("publicSendErrorMessage", () => {
  it("explains a rate-limited send in plain language", () => {
    expect(publicSendErrorMessage({ status: 429 })).toMatch(/wait a minute/i);
  });
  it("tells the customer to phone the company when the link is dead", () => {
    expect(publicSendErrorMessage({ status: 404 })).toMatch(/contact the company/i);
    expect(publicSendErrorMessage({ status: 410 })).toMatch(/contact the company/i);
  });
  it("says the message was not sent on a server error", () => {
    expect(publicSendErrorMessage({ status: 500 })).toMatch(/was not sent/i);
  });
  it("passes a useful server message through (e.g. too long)", () => {
    expect(
      publicSendErrorMessage({ status: 400, message: "Message is too long (max 2000 characters)" }),
    ).toBe("Message is too long (max 2000 characters)");
  });
  it("never leaks a raw fetch failure or an empty message", () => {
    expect(publicSendErrorMessage(new TypeError("Failed to fetch"))).toBe(
      "Couldn't send your message. Please try again.",
    );
    expect(publicSendErrorMessage({ status: 400, message: "  " })).toBe(
      "Couldn't send your message. Please try again.",
    );
    expect(publicSendErrorMessage(undefined)).toBe("Couldn't send your message. Please try again.");
  });
});
