import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * RDS Postgres over a pooled connection can still drop a socket mid-request
 * (a failover, a maintenance blip, a cold start racing the pool's first
 * connect). A bare pool has no retry, so a single dropped connection turns
 * into a 500 on every downstream read (e.g. /api/auth/get-session), which
 * intermittently strips the superadmin role off the session and hides
 * superadmin-only UI.
 *
 * This is especially visible right after a cold start (server restart / host
 * resume): the very first statements race the pool's first connection coming up.
 *
 * We wrap the pool so transient connection errors are retried with an
 * exponential backoff + jitter. Retries are safe here: the failures we catch
 * happen at the transport layer before the statement is applied.
 */
const TRANSIENT = [
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN", // transient DNS failure during cold start
  "Connection terminated",
  "connection terminated unexpectedly",
  "57P03", // Postgres: cannot connect now (starting up / in recovery)
  "and 503",
  "502",
  "503",
  "504",
];

function isTransient(err: unknown): boolean {
  const msg =
    (err as { message?: string })?.message ??
    (err as { code?: string })?.code ??
    String(err);
  const code = String((err as any)?.code ?? "");
  return TRANSIENT.some((t) => msg.includes(t) || code.includes(t));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Exponential backoff with jitter. Total worst-case wait is roughly
 * 100 + 250 + 600 + 1200 + 2000 ≈ 4.15s across 5 retries — enough to ride out a
 * cold reconnect without ever surfacing a 500 to the user, while still failing
 * fast on a genuinely-down database.
 */
const BASE_DELAYS = [100, 250, 600, 1200, 2000];

function nextDelay(attempt: number): number {
  const base = BASE_DELAYS[Math.min(attempt, BASE_DELAYS.length - 1)];
  // +/- 25% jitter to avoid thundering-herd reconnects across nodes
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const maxRetries = BASE_DELAYS.length; // 5 retries (6 total attempts)
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries && isTransient(err)) {
        const delay = nextDelay(attempt);
        console.warn(
          `[db] transient ${label} failure (attempt ${attempt + 1}/${maxRetries}); retrying in ${delay}ms`,
        );
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

const rawPool = new Pool({ connectionString: process.env.DATABASE_URL! });

/**
 * Proxy the pool so `query` transparently retries transient connection
 * failures. Everything else (connect, end, event emitter methods drizzle
 * doesn't use directly) passes through untouched.
 */
const pool = new Proxy(rawPool, {
  get(target, prop, receiver) {
    if (prop === "query") {
      return (...a: unknown[]) =>
        withRetry(
          () => (target.query as (...x: unknown[]) => Promise<unknown>)(...a),
          "query",
        );
    }
    return Reflect.get(target, prop, receiver);
  },
}) as Pool;

export const db = drizzle(pool, { schema });

/**
 * Warm-up / liveness ping. Called on server boot so the very first real user
 * request never races a cold connection. Also reusable by the /ready probe.
 * Returns true if the DB answered, false otherwise (never throws).
 */
export async function pingDb(): Promise<boolean> {
  try {
    await pool.query("select 1");
    return true;
  } catch (err) {
    console.warn("[db] warm-up ping failed:", (err as Error)?.message ?? err);
    return false;
  }
}

/**
 * Boot-time warm-up: retry the ping a few times so a host-resume cold start
 * settles the connection before traffic arrives. Fire-and-forget from server.ts.
 */
export async function warmUpDb(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    if (await pingDb()) {
      if (i > 0) console.log(`[db] connection warmed up after ${i + 1} tries`);
      return;
    }
    await sleep(nextDelay(i));
  }
  console.warn("[db] warm-up did not confirm a connection (will retry on first request)");
}
