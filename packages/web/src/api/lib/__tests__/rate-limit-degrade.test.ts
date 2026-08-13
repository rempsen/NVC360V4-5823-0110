/**
 * Rate limiter behavior when Redis is unavailable.
 *
 * The limiter's Redis store used to FAIL OPEN: a null client or a thrown eval
 * returned `{count: 1}`, which is indistinguishable from "first request in the
 * window". Every limiter in the app — including the ones in front of sign-in
 * and the unauthenticated public intake form — silently became unlimited for
 * as long as Redis was down, and nothing paged anyone. A brute-force window
 * that opens exactly when infrastructure is already unhealthy is the worst
 * possible time for it to open.
 *
 * Required behavior: DEGRADE, don't disable. Fall back to the in-process
 * counter (per-node, so imperfect across a fleet, but bounded) and raise one
 * debounced ops alert saying enforcement is degraded.
 *
 * These tests drive the store directly rather than through HTTP so a fake
 * Redis can be injected without a live server.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

process.env.REDIS_URL = "redis://localhost:1/fake"; // make redisEnabled() true
process.env.ALERT_WEBHOOK_URL = "https://example.test/hook";
process.env.ALERT_EMAIL = "";
process.env.ALERT_COOLDOWN_MS = "100000";

// The real redis module is replaced before rate-limit imports it, so no live
// Redis (and no ioredis reconnect loop) is involved anywhere in this file.
let stub: unknown = null;
mock.module("../redis", () => ({
  getRedis: () => stub,
  redisEnabled: () => true,
}));

const { RedisStore, _resetRateLimitDegradeState } = await import("../rate-limit");
const { _resetAlerts } = await import("../alerts");

// Capture ops alert deliveries (webhook channel only — no network, no Resend).
let hits: Array<{ text: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
  try {
    hits.push({ text: String(JSON.parse(String(init?.body ?? "{}")).text ?? "") });
  } catch {
    /* ignore */
  }
  return new Response("ok", { status: 200 });
}) as typeof fetch;

const flush = () => new Promise((r) => setTimeout(r, 30));

/** Point the stubbed getRedis() at `impl`. Returns a restore fn. */
function stubRedis(impl: unknown) {
  stub = impl;
  return () => {
    stub = null;
  };
}

const WINDOW = 60_000;

describe("rate limiter degrades instead of failing open", () => {
  beforeEach(() => {
    hits = [];
    _resetAlerts();
    _resetRateLimitDegradeState();
  });

  it("counts locally when the Redis client is missing", async () => {
    const restore = stubRedis(null);
    try {
      const store = new RedisStore();
      const a = await store.hit("ip:1.2.3.4", WINDOW);
      const b = await store.hit("ip:1.2.3.4", WINDOW);
      const c = await store.hit("ip:1.2.3.4", WINDOW);
      // Fail-open returned 1 every time, so a limit of 2 was never reached.
      expect([a.count, b.count, c.count]).toEqual([1, 2, 3]);
    } finally {
      restore();
    }
  });

  it("counts locally when the Redis eval throws", async () => {
    const restore = stubRedis({
      eval: async () => {
        throw new Error("ECONNRESET");
      },
    });
    try {
      const store = new RedisStore();
      const first = await store.hit("ip:9.9.9.9", WINDOW);
      const second = await store.hit("ip:9.9.9.9", WINDOW);
      expect(second.count).toBe(first.count + 1);
      expect(second.count).toBe(2);
    } finally {
      restore();
    }
  });

  it("keeps separate keys separate while degraded", async () => {
    const restore = stubRedis(null);
    try {
      const store = new RedisStore();
      await store.hit("ip:a", WINDOW);
      await store.hit("ip:a", WINDOW);
      const other = await store.hit("ip:b", WINDOW);
      // One IP exhausting its budget must not throttle a different IP.
      expect(other.count).toBe(1);
    } finally {
      restore();
    }
  });

  it("raises one debounced ops alert saying enforcement is degraded", async () => {
    const restore = stubRedis(null);
    try {
      const store = new RedisStore();
      for (let i = 0; i < 5; i++) await store.hit("ip:5.5.5.5", WINDOW);
      await flush();
      expect(hits.length).toBe(1);
      expect(hits[0]!.text.toLowerCase()).toContain("rate limit");
    } finally {
      restore();
    }
  });

  it("returns to Redis counting once it recovers", async () => {
    let broken = true;
    const restore = stubRedis({
      eval: async () => {
        if (broken) throw new Error("down");
        return [42, 1234];
      },
    });
    try {
      const store = new RedisStore();
      const degraded = await store.hit("ip:7.7.7.7", WINDOW);
      expect(degraded.count).toBe(1); // local counter
      broken = false;
      const healthy = await store.hit("ip:7.7.7.7", WINDOW);
      // Redis is authoritative again — its count wins, not the local one.
      expect(healthy.count).toBe(42);
      expect(healthy.resetMs).toBe(1234);
    } finally {
      restore();
      globalThis.fetch = realFetch;
    }
  });
});
