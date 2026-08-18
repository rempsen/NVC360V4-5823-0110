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
import { recordInfraDegraded } from "./alerts";
import { incr } from "./metrics";

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
 * that never resets).
 *
 * When Redis is unreachable it DEGRADES to the in-process counter — it does not
 * fail open. This used to return `{count: 1}` on any failure, which reads to
 * the middleware as "first request in the window", so every limiter in the app
 * became unlimited for the duration of a Redis outage: sign-in brute-force
 * protection, the public intake form, the paid-SMS tracking writes, all of it.
 * And because those requests still succeeded, no 5xx was recorded and nothing
 * alerted — the guarantee disappeared silently, at the exact moment
 * infrastructure was already unhealthy.
 *
 * Per-node counting is imperfect across a fleet (each node allows the budget
 * independently, so the effective ceiling is limit × nodes) but it is BOUNDED,
 * which unlimited is not. The degradation raises one debounced ops alert.
 */
const FIXED_WINDOW_LUA = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
return { current, ttl }
`;

export class RedisStore implements RateLimitStore {
  /** Local counter used only while Redis is unavailable. */
  private fallback = new MemoryStore();

  /** Log + page once per outage, not once per request. */
  private degrade(reason: string) {
    if (!degraded) {
      degraded = true;
      log.error("rate-limit: Redis unavailable — counting per-node instead", { reason });
      recordInfraDegraded(
        "rate limit store",
        `Redis is unreachable (${reason}). Rate limiting has degraded to per-node ` +
          `in-process counters: limits still apply but the effective ceiling is ` +
          `limit x node count. Restore Redis to regain a shared window.`,
      );
    }
    incr("rate_limit_degraded_hits");
  }

  async hit(key: string, windowMs: number) {
    const r = getRedis();
    if (!r) {
      this.degrade("no client");
      return this.fallback.hit(key, windowMs);
    }
    try {
      const res = (await r.eval(FIXED_WINDOW_LUA, 1, key, String(windowMs))) as [
        number,
        number,
      ];
      const count = Number(res[0]) || 1;
      let ttl = Number(res[1]);
      // PTTL returns -1 (no expire) / -2 (no key) defensively → reset full window
      if (!Number.isFinite(ttl) || ttl < 0) ttl = windowMs;
      if (degraded) {
        degraded = false;
        log.info("rate-limit: Redis recovered — shared window restored");
      }
      return { count, resetMs: ttl };
    } catch (e) {
      this.degrade((e as Error).message);
      return this.fallback.hit(key, windowMs);
    }
  }
}

/** True while Redis is known-unreachable; gates the alert to once per outage. */
let degraded = false;

/** Test/util: forget that an outage was already reported. */
export function _resetRateLimitDegradeState(): void {
  degraded = false;
}

let store: RateLimitStore = new MemoryStore();
/** Swap in a Redis-backed store at boot for multi-node deployments. */
export function setRateLimitStore(s: RateLimitStore) {
  store = s;
}

/**
 * Test-only: put the default in-process store back.
 *
 * `store` is module-level singleton state, so a test that installs a stub store
 * keeps it installed for every test file that runs later in the same bun
 * process. One test installed a stub returning `{ count: 1 }` for every key —
 * i.e. "always the first request in the window" — which silently DISABLED every
 * limiter in the app for the rest of the suite. Locally that file happened to
 * run last so nothing noticed; on CI the file order differed and the tests
 * asserting a 429 got a 200. Any test that calls setRateLimitStore must call
 * this in afterAll.
 */
export function _resetRateLimitStore(): void {
  store = new MemoryStore();
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
  /**
   * Max requests per window — a number, or a function evaluated per request.
   *
   * The presets below pass a function so the env var is read when a request
   * arrives rather than when this module is imported. Capturing it at import
   * made the limit depend on load order relative to whoever set the
   * environment: it broke CI for six commits (a test that raises the public
   * write budget lost the import race, so the suite tripped the real 10/min
   * budget and a 201 came back 429) while every local run stayed green.
   * See __tests__/env-config-load-order.test.ts.
   */
  limit: number | (() => number);
  windowMs: number;
  keyFn?: KeyFn;
  name?: string;
}) {
  const { windowMs, name = "rl" } = opts;
  const limitOf = typeof opts.limit === "function" ? opts.limit : () => opts.limit as number;
  const keyFn = opts.keyFn ?? ((c) => clientIp(c));
  return createMiddleware(async (c, next) => {
    const limit = limitOf();
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

/**
 * Bucket by the caller's session credential rather than their user id.
 *
 * Why not keyByUser: this runs on /api/auth/* which is mounted BEFORE
 * authMiddleware, so `c.get("user")` is always null there and keyByUser
 * silently degrades to per-IP. Per-IP is exactly the failure mode we're
 * fixing — one office behind a single NAT shares one budget.
 *
 * The session token is available without any auth middleware: mobile sends it
 * as a bearer token (better-auth's bearer plugin), the web app as a cookie. We
 * hash it so a raw session token is never used as a map key or written to a
 * log line. Anonymous callers (no credential yet) fall back to per-IP, which is
 * correct — there's no session to bucket by.
 */
export const keyBySession: KeyFn = (c) => {
  const auth = c.req.header("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const cookie = c.req.header("cookie") || "";
  // matches better-auth's session cookie under any prefix (__Secure-, __Host-)
  const m = cookie.match(/(?:^|;\s*)(?:__Secure-|__Host-)?[\w.-]*session_token=([^;]+)/);
  const cred = bearer || (m ? m[1] : "");
  if (!cred) return `ip:${clientIp(c)}`;
  return `s:${hashCred(cred)}`;
};

/** Short, stable, non-reversible fingerprint of a credential (FNV-1a 32-bit). */
function hashCred(v: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < v.length; i++) {
    h ^= v.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

// ---- presets --------------------------------------------------------------
/**
 * Read a limit from the environment at CALL time.
 *
 * `Number(undefined)` and `Number("nonsense")` are both NaN, and `count > NaN`
 * is always false — so a typo'd env var would not have loosened the limiter, it
 * would have DISABLED it, silently, on whichever surface was misconfigured.
 * Anything that isn't a positive finite number falls back to the documented
 * default instead.
 */
function envLimit(name: string, dflt: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

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
  limit: () => envLimit("RL_AUTH_LIMIT", 20),
  windowMs: 60_000,
  keyFn: keyByIp,
});

/**
 * Session reads (`get-session`, token refresh, sign-out). These are already
 * authenticated, cheap, and called constantly by the SPA, so they get a
 * generous budget — brute force is not a threat model for reading your own
 * session.
 *
 * Keyed by session credential (see keyBySession), NOT by IP and NOT by user id:
 * this middleware runs before authMiddleware so no user is resolved yet, and
 * per-IP keying is the original bug (one NAT = one shared budget). One admin
 * hammering their own tab can therefore never throttle a colleague.
 */
export const sessionLimiter = rateLimit({
  name: "authsession",
  limit: () => envLimit("RL_SESSION_LIMIT", 600),
  windowMs: 60_000,
  keyFn: keyBySession,
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
  limit: () => envLimit("RL_API_LIMIT", 600),
  windowMs: 60_000,
  keyFn: keyByUser,
});
/** Per-token limiter for public tracking polls. */
export const trackLimiter = rateLimit({
  name: "track",
  limit: () => envLimit("RL_TRACK_LIMIT", 120),
  windowMs: 60_000,
  keyFn: keyByToken,
});
/**
 * Per-token limiter for public tracking WRITES (customer messages, review).
 *
 * The read limiter is sized for a 2.5s poll (120/min). Writes must not share
 * that budget: every message posted from the public page forwards a real SMS to
 * the technician, so 120/min per link is 120 paid texts a minute from anyone
 * holding the URL. A human types a handful of messages, never dozens.
 */
export const trackWriteLimiter = rateLimit({
  name: "track-write",
  limit: () => envLimit("RL_TRACK_WRITE_LIMIT", 10),
  windowMs: 60_000,
  keyFn: keyByToken,
});
/** Per-user/IP limiter for high-frequency driver location pings. */
export const pingLimiter = rateLimit({
  name: "ping",
  limit: () => envLimit("RL_PING_LIMIT", 60),
  windowMs: 60_000,
  keyFn: keyByUser,
});
