/**
 * Regression tests for the auth-surface rate limiter.
 *
 * The bug these lock down: /api/auth/* was covered by a single 20/min per-IP
 * limiter. better-auth's `get-session` lives under that prefix and the SPA
 * calls it on EVERY page load, so an admin clicking through ~20 pages in a
 * minute got a 429 on their own session read, the frontend saw no session, and
 * ProtectedRoute redirected them to /sign-in mid-work. Because the key was the
 * IP, everyone in one office behind a single NAT shared the budget and logged
 * each other out.
 *
 * The fix has three properties that must all hold, and each is asserted here:
 *   1. session reads get a generous budget (page loads never 429)
 *   2. credential endpoints stay tightly throttled (brute force still blocked)
 *   3. session reads are bucketed per SESSION, not per IP (no collateral
 *      lockout between colleagues on one connection)
 * Plus the fail-closed property: an unrecognised /api/auth/* path must land in
 * the tight bucket, so a future better-auth route can't silently get 600/min.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { authSurfaceLimiter, setRateLimitStore, type RateLimitStore } from "../rate-limit";

/**
 * Fresh in-process fixed-window store per test, so counts from one test can't
 * leak into the next (the module default is a long-lived singleton).
 */
function freshStore(): RateLimitStore {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    async hit(key: string, windowMs: number) {
      const now = Date.now();
      const b = buckets.get(key);
      if (!b || b.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return { count: 1, resetMs: windowMs };
      }
      b.count += 1;
      return { count: b.count, resetMs: b.resetAt - now };
    },
  };
}

const app = new Hono()
  // The limiter signals refusal by throwing an AppError; the real app's error
  // handler turns that into the HTTP status. Mirror that here so these tests
  // assert on status codes exactly as a browser would see them.
  .onError((err, c) => {
    const status = (err as { status?: number }).status ?? 500;
    return c.json({ error: (err as Error).message }, status as 429);
  })
  .use("/api/auth/*", authSurfaceLimiter)
  .all("/api/auth/*", (c) => c.json({ ok: true }));

/** Hit a path n times, return the list of status codes in order. */
async function hitMany(path: string, n: number, headers: Record<string, string> = {}) {
  const codes: number[] = [];
  for (let i = 0; i < n; i++) {
    const res = await app.request(path, { method: "GET", headers });
    codes.push(res.status);
  }
  return codes;
}

const IP = (ip: string) => ({ "x-forwarded-for": ip });
const SESSION = (token: string, ip = "203.0.113.9") => ({
  ...IP(ip),
  cookie: `better-auth.session_token=${token}`,
});

beforeEach(() => setRateLimitStore(freshStore()));

describe("session reads are not throttled like logins", () => {
  it("survives 30 consecutive get-session calls (the exact reported repro)", async () => {
    // Before the fix: 200 for 1-19, then 429 from request 20 onward.
    const codes = await hitMany("/api/auth/get-session", 30, SESSION("tok-admin"));
    expect(codes.every((c) => c === 200)).toBe(true);
    expect(codes).toHaveLength(30);
  });

  it("still allows a page-load burst well past the old 20/min ceiling", async () => {
    const codes = await hitMany("/api/auth/get-session", 120, SESSION("tok-busy"));
    expect(codes.filter((c) => c === 429)).toHaveLength(0);
  });

  it("applies the generous budget to the other session-shaped routes too", async () => {
    for (const p of ["/api/auth/session", "/api/auth/list-sessions", "/api/auth/refresh-token"]) {
      const codes = await hitMany(p, 25, SESSION(`tok-${p}`));
      expect(codes.filter((c) => c === 429)).toHaveLength(0);
    }
  });

  it("does not throttle sign-out (a person signing out must always succeed)", async () => {
    const codes = await hitMany("/api/auth/sign-out", 25, SESSION("tok-out"));
    expect(codes.filter((c) => c === 429)).toHaveLength(0);
  });
});

describe("credential endpoints stay tightly throttled", () => {
  it("throttles sign-in at 20/min per IP (brute-force defense intact)", async () => {
    const codes = await hitMany("/api/auth/sign-in/email", 25, IP("198.51.100.7"));
    // first 20 allowed, everything after is refused
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
    expect(codes.slice(20).every((c) => c === 429)).toBe(true);
  });

  it("throttles every credential-verifying surface, not just sign-in", async () => {
    const paths = [
      "/api/auth/sign-up/email",
      "/api/auth/forget-password",
      "/api/auth/reset-password",
      "/api/auth/change-password",
      "/api/auth/verify-email",
      "/api/auth/two-factor/verify",
    ];
    for (const [i, p] of paths.entries()) {
      const codes = await hitMany(p, 25, IP(`198.51.100.${20 + i}`));
      expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    }
  });

  it("keys credential throttling by IP, so an attacker cannot rotate cookies to reset it", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await app.request("/api/auth/sign-in/email", {
        method: "GET",
        // a new session cookie every attempt — must not buy a fresh budget
        headers: SESSION(`rotating-${i}`, "198.51.100.99"),
      });
      codes.push(res.status);
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
  });

  it("fails closed: an unknown /api/auth/* route gets the TIGHT limiter", async () => {
    // A future better-auth route must never silently land in the 600/min bucket.
    const codes = await hitMany("/api/auth/some-future-route", 25, SESSION("tok-future"));
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
  });
});

describe("session reads bucket per session, not per IP", () => {
  it("one admin exhausting their budget does not throttle a colleague on the same IP", async () => {
    // This is the collateral-damage half of the original bug: same office, same
    // public IP, two people. Burn a large budget as admin A...
    const a = await hitMany("/api/auth/get-session", 700, SESSION("tok-A", "192.0.2.50"));
    expect(a.filter((c) => c === 429).length).toBeGreaterThan(0); // A hit their own ceiling

    // ...B, on the SAME IP but a different session, must still be served.
    const b = await hitMany("/api/auth/get-session", 30, SESSION("tok-B", "192.0.2.50"));
    expect(b.every((c) => c === 200)).toBe(true);
  });

  it("bearer-token callers (mobile) are bucketed separately from cookie callers", async () => {
    const mobile = { ...IP("192.0.2.77"), authorization: "Bearer mobile-token-1" };
    const other = { ...IP("192.0.2.77"), authorization: "Bearer mobile-token-2" };
    const first = await hitMany("/api/auth/get-session", 700, mobile);
    expect(first.filter((c) => c === 429).length).toBeGreaterThan(0);
    const second = await hitMany("/api/auth/get-session", 30, other);
    expect(second.every((c) => c === 200)).toBe(true);
  });

  it("anonymous session reads (no credential) still fall back to per-IP", async () => {
    // Nothing to bucket by, so per-IP is the correct behaviour — and it must
    // not accidentally share a bucket with a real session on the same IP.
    const anon = await hitMany("/api/auth/get-session", 700, IP("192.0.2.90"));
    expect(anon.filter((c) => c === 429).length).toBeGreaterThan(0);
    const real = await hitMany("/api/auth/get-session", 30, SESSION("tok-real", "192.0.2.90"));
    expect(real.every((c) => c === 200)).toBe(true);
  });

  it("does not use the raw session token as the bucket key", async () => {
    // Tokens must never be stored verbatim in limiter keys (they end up in
    // memory dumps and, with a Redis store, on the wire).
    const seen: string[] = [];
    setRateLimitStore({
      async hit(key: string, windowMs: number) {
        seen.push(key);
        return { count: 1, resetMs: windowMs };
      },
    });
    await app.request("/api/auth/get-session", {
      headers: SESSION("super-secret-session-token"),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain("super-secret-session-token");
  });
});
