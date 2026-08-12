// ─── Error classification: what deserves a Sentry issue and what doesn't ─────
//
// Why this file exists: a customer typing too fast into the public tracking
// page's message box hit the write rate-limiter, the page showed them
// "Too many messages just now — please wait a minute and try again." (correct),
// and that same sentence arrived in Sentry as a production ERROR issue and
// emailed the team. The rate limiter working as designed is not a crash.
//
// The root cause was classification by CLASS: the mutation caught the ApiError
// and re-threw `new Error(friendlyText)`, so `error instanceof ApiError` was
// false at the reporting boundary and the 429 was treated as an unknown
// exception. These helpers classify by DATA (status + a handled flag) so
// re-thrown errors keep their meaning.
import { describe, it, expect } from "bun:test";
import {
  ApiError,
  UserFacingError,
  errorStatus,
  isExpectedApiError,
  isHandledLocally,
} from "../api-error";

describe("errorStatus", () => {
  it("reads the status off an ApiError", () => {
    expect(errorStatus(new ApiError({ status: 429, message: "slow down" }))).toBe(429);
  });

  it("reads the status off a bare object (what a fetch call site throws)", () => {
    expect(errorStatus({ status: 404 })).toBe(404);
  });

  it("reads the status off a UserFacingError", () => {
    expect(errorStatus(new UserFacingError("nope", { status: 422 }))).toBe(422);
  });

  it("is undefined for errors that carry no status", () => {
    expect(errorStatus(new Error("boom"))).toBeUndefined();
    expect(errorStatus(null)).toBeUndefined();
    expect(errorStatus(undefined)).toBeUndefined();
    expect(errorStatus("string error")).toBeUndefined();
    expect(errorStatus({ status: "429" })).toBeUndefined();
    expect(errorStatus({ status: NaN })).toBeUndefined();
  });
});

describe("isExpectedApiError", () => {
  it("treats every 4xx as expected — the API refusing correctly", () => {
    for (const s of [400, 401, 403, 404, 409, 410, 413, 422, 429, 499]) {
      expect(isExpectedApiError({ status: s })).toBe(true);
    }
  });

  it("THE BUG: a friendly re-thrown 429 is still classified as expected", () => {
    // Exactly the shape that paged us: user-facing text, no ApiError class.
    const rethrown = new UserFacingError(
      "Too many messages just now — please wait a minute and try again.",
      { status: 429 },
    );
    expect(isExpectedApiError(rethrown)).toBe(true);
  });

  it("does NOT swallow server faults — 5xx is ours", () => {
    for (const s of [500, 502, 503, 504]) {
      expect(isExpectedApiError({ status: s })).toBe(false);
    }
  });

  it("does not swallow real exceptions with no status", () => {
    expect(isExpectedApiError(new TypeError("x is not a function"))).toBe(false);
    expect(isExpectedApiError(new Error("Cannot read properties of undefined"))).toBe(false);
  });
});

describe("UserFacingError / isHandledLocally", () => {
  it("keeps the message the user was shown", () => {
    const e = new UserFacingError("This tracking link is no longer active.");
    expect(e.message).toBe("This tracking link is no longer active.");
    expect(e instanceof Error).toBe(true);
    expect(e.name).toBe("UserFacingError");
  });

  it("is flagged as handled so the screen's inline alert isn't duplicated by a toast", () => {
    expect(isHandledLocally(new UserFacingError("x"))).toBe(true);
  });

  it("keeps the original error as the cause for debugging", () => {
    const cause = new ApiError({ status: 429, message: "rate_limited" });
    const e = new UserFacingError("Too many messages just now", { status: 429, cause });
    expect((e as { cause?: unknown }).cause).toBe(cause);
    expect(e.status).toBe(429);
  });

  it("a plain Error or an ApiError is NOT handled locally — those still toast", () => {
    expect(isHandledLocally(new Error("boom"))).toBe(false);
    expect(isHandledLocally(new ApiError({ status: 500, message: "boom" }))).toBe(false);
    expect(isHandledLocally(null)).toBe(false);
    expect(isHandledLocally({ handledLocally: "yes" })).toBe(false);
  });

  it("a 5xx inside a locally-handled surface keeps its status, so it is still reportable", () => {
    const e = new UserFacingError("The server didn't accept that", { status: 503 });
    expect(isExpectedApiError(e)).toBe(false);
    expect(errorStatus(e)).toBe(503);
  });

  it("drops a non-numeric status instead of pretending it has one", () => {
    const e = new UserFacingError("x", { status: undefined });
    expect(e.status).toBeUndefined();
    expect(isExpectedApiError(e)).toBe(false);
  });
});
