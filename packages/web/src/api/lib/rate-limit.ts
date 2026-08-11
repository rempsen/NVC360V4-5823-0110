/**
 * Rate limiting middleware (token-bucket / fixed-window hybrid).
 *
 * Default store is in-process (works for single node now). The store is an
 * interface so a Redis-backed store can be dropped in for multi-node fan-out
 * without touching call sites — see `setRateLimitStore`.
 */
import { createMiddleware } from "hono/factory";
import { Err } from "./errors";
import { getRedis, redisEnabled } from "./redis";
import { log } from "./logger";

export interface RateLimitStore {
  /** increment the counter for `key`, return current count + ms until reset */
  hit(key: string, windowMs: number): Promise<{ count: number; resetMs: number }>;
}

// ---- in-memory fixed-window store (default) -------------------------------
class MemoryStore implements RateLimitStore {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  constructor() {
    // periodic sweep so the map doesn't grow unbounded
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.buckets) if (v.resetAt <= now) this.buckets.delete(k);
    }, 60_000).unref?.();
  }
  async hit(key: string, windowMs: number) {
    const now = Date.now();
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      const resetAt = now + windowMs;
      this.buckets.set(key, { count: 1, resetAt });
      return { count: 1, resetMs: windowMs };
    }
    b.count += 1;
    return { count: b.count, resetMs: b.resetAt - now };
  }
}

// ---- Redis fixed-window store (multi-node) --------------------------------
/**
 * Shared rate-limit window across all nodes. Uses an atomic INCR; on the first
 * hit in a window it sets PEXPIRE so the key self-clears. Done in a single Lua
 * script so the INCR + expiry can't race (which would otherwise leak a key
 * that never resets). Falls back to allowing the request if Redis is briefly
 * unreachable — availability over strictness for the limiter.
 */
const FIXED_WINDOW_LUA = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
return { current, ttl }
`;

class RedisStore implements RateLimitStore {
  async hit(key: string, windowMs: number) {
    const r = getRedis();
    if (!r) return { count: 1, resetMs: windowMs };
    try {
      const res = (await r.eval(FIXED_WINDOW_LUA, 1, key, String(windowMs))) as [
        number,
        number,
      ];
      const count = Number(res[0]) || 1;
      let ttl = Number(res[1]);
      // PTTL returns -1 (no expire) / -2 (no key) defensively → reset full window
      if (!Number.isFinite(ttl) || ttl < 0) ttl = windowMs;
      return { count, resetMs: ttl };
    } catch (e) {
      log.error("rate-limit: redis hit failed (allowing request)", {
        err: (e as Error).message,
      });
      // Fail open: don't lock everyone out if Redis hiccups.
      return { count: 1, resetMs: windowMs };
    }
  }
}

let store: RateLimitStore = new MemoryStore();
/** Swap in a Redis-backed store at boot for multi-node deployments. */
export function setRateLimitStore(s: RateLimitStore) {
  store = s;
}

/** Pick the store based on environment. Call once at boot. */
export function initRateLimitStore() {
  if (redisEnabled()) {
    store = new RedisStore();
    log.info("rate-limit: using Redis store (multi-node)");
  } else {
    log.info("rate-limit: using in-memory store (single-node)");
  }
}

type KeyFn = (c: any) => string;

function clientIp(c: any): string {
  const xf =
    c.req.header("x-forwarded-for") ||
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-real-ip");
  if (xf) return xf.split(",")[0].trim();
  return "unknown";
}

/**
 * Build a rate-limit middleware.
 * @param limit   max requests per window
 * @param windowMs window length in ms
 * @param keyFn   how to bucket (default: per-IP). Use perUser / perToken below.
 * @param name    label for the bucket namespace (so different limiters don't collide)
 */
export function rateLimit(opts: {
  limit: number;
  windowMs: number;
  keyFn?: KeyFn;
  name?: string;
}) {
  const { limit, windowMs, name = "rl" } = opts;
  const keyFn = opts.keyFn ?? ((c) => clientIp(c));
  return createMiddleware(async (c, next) => {
    const key = `${name}:${keyFn(c)}`;
    const { count, resetMs } = await store.hit(key, windowMs);
    const remaining = Math.max(0, limit - count);
    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(Math.ceil(resetMs / 1000)));
    if (count > limit) {
      c.header("Retry-After", String(Math.ceil(resetMs / 1000)));
      throw Err.tooMany();
    }
    return next();
  });
}

// ---- common key strategies ------------------------------------------------
export const keyByUser: KeyFn = (c) => {
  const u = c.get("user") as { id?: string } | null;
  return u?.id ? `u:${u.id}` : `ip:${clientIp(c)}`;
};
export const keyByToken: KeyFn = (c) => {
  const t = c.req.param?.("token");
  return t ? `t:${t}` : `ip:${clientIp(c)}`;
};
export const keyByIp: KeyFn = (c) => `ip:${clientIp(c)}`;

// ---- presets --------------------------------------------------------------
/**
 * Tight limiter for CREDENTIAL-VERIFYING auth surfaces (brute-force defense):
 * sign-in, sign-up, password reset, email verification. Keyed by IP on purpose
 * — the attacker has no account yet, so per-user keying would be useless.
 *
 * This must NOT be applied to the whole of /api/auth/*. `get-session` lives
 * under that prefix and is called on EVERY page load, so a 20/min IP budget
 * meant an admin clicking through ~20 pages in a minute started getting 429s
 * on their own session read. The frontend saw no session and bounced them to
 * /sign-in mid-work. Because the key is the IP, a whole office behind one NAT
 * shared the 20/min budget and logged each other out. See sessionLimiter.
 */
export const authLimiter = rateLimit({
  name: "auth",
  limit: Number(process.env.RL_AUTH_LIMIT ?? 20),
  windowMs: 60_000,
  keyFn: keyByIp,
});

/**
 * Session reads (`get-session`, token refresh, sign-out). These are already
 * authenticated, cheap, and called constantly by the SPA, so they get a
 * generous per-user budget — brute force is not a threat model for reading
 * your own session. Falls back to per-IP for anonymous callers.
 */
export const sessionLimiter = rateLimit({
  name: "authsession",
  limit: Number(process.env.RL_SESSION_LIMIT ?? 600),
  windowMs: 60_000,
  keyFn: keyByUser,
});

/**
 * Paths under /api/auth/* that actually verify or change credentials. Matched
 * as a substring of the pathname so better-auth's sub-routes
 * (e.g. /api/auth/sign-in/email) are covered.
 */
const SENSITIVE_AUTH_PATHS = [
  "/sign-in",
  "/sign-up",
  "/forget-password",
  "/forgot-password",
  "/reset-password",
  "/change-password",
  "/change-email",
  "/send-verification-email",
  "/verify-email",
  "/two-factor",
  "/magic-link",
  "/callback",
];

/**
 * Applies the tight brute-force limiter to credential endpoints and the
 * generous one to everything else under /api/auth/* (session reads).
 * Fail-closed by default: an unrecognised auth path is treated as sensitive,
 * so a future better-auth route can't silently land in the generous bucket.
 */
export const authSurfaceLimiter = createMiddleware(async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const sensitive = SENSITIVE_AUTH_PATHS.some((p) => path.includes(p));
  const isSessionRead =
    path.endsWith("/get-session") ||
    path.endsWith("/session") ||
    path.endsWith("/sign-out") ||
    path.endsWith("/refresh-token") ||
    path.endsWith("/list-sessions");
  if (sensitive || !isSessionRead) return authLimiter(c, next);
  return sessionLimiter(c, next);
});
/** General API limiter, per-user when logged in else per-IP. */
export const apiLimiter = rateLimit({
  name: "api",
  limit: Number(process.env.RL_API_LIMIT ?? 600),
  windowMs: 60_000,
  keyFn: keyByUser,
});
/** Per-token limiter for public tracking polls. */
export const trackLimiter = rateLimit({
  name: "track",
  limit: Number(process.env.RL_TRACK_LIMIT ?? 120),
  windowMs: 60_000,
  keyFn: keyByToken,
});
/** Per-user/IP limiter for high-frequency driver location pings. */
export const pingLimiter = rateLimit({
  name: "ping",
  limit: Number(process.env.RL_PING_LIMIT ?? 60),
  windowMs: 60_000,
  keyFn: keyByUser,
});
