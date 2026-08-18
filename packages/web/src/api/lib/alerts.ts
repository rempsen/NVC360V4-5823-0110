/**
 * Per-tenant error alerting.
 *
 * Detects bursts of server errors (5xx) and unhandled exceptions and fires a
 * single, debounced alert per tenant to ops — by email (Resend, already wired)
 * and/or a generic webhook (Slack-compatible incoming webhook, PagerDuty
 * Events, Discord, etc.).
 *
 * Why per-tenant: in a multi-tenant SaaS one company's outage (a bad
 * integration token, a corrupt config row) shouldn't be drowned out by
 * healthy traffic — and noisy global counts make it impossible to tell WHO is
 * affected. Keying the sliding window by companyId means each tenant's error
 * burst alerts on its own, with the tenant id right in the subject line.
 *
 * Design:
 *  - Sliding window counter per `companyId`. When >= THRESHOLD errors land
 *    within WINDOW_MS, an alert fires.
 *  - After firing, that tenant enters a COOLDOWN so we never spam (one page,
 *    not a hundred). A compact "still failing" summary is included on the next
 *    alert after cooldown lapses.
 *  - Counting is Redis-backed when REDIS_URL is set (accurate across nodes via
 *    an atomic INCR+PEXPIRE Lua script — same pattern as the rate limiter) and
 *    in-memory otherwise. Cooldown de-dupe is also Redis-backed (SET NX PX) so
 *    only ONE node sends the alert in a multi-node deploy.
 *  - Fully fire-and-forget and exception-safe: alerting must NEVER throw into
 *    or slow down the request path. Failures are logged, never propagated.
 *
 * Configuration (all optional — alerting is a no-op until a channel is set):
 *  - ALERT_EMAIL              comma-separated ops recipients (e.g. ops@nvc360.com)
 *  - ALERT_WEBHOOK_URL        Slack/Discord/generic incoming webhook URL
 *  - ALERT_ERROR_THRESHOLD    errors per window to trip an alert   (default 5)
 *  - ALERT_WINDOW_MS          sliding window length in ms          (default 60000)
 *  - ALERT_COOLDOWN_MS        min gap between alerts per tenant     (default 900000 = 15m)
 *  - APP_URL                  used to deep-link the metrics dashboard in alerts
 */
import { getRedis, redisEnabled } from "./redis";
import { log } from "./logger";

/**
 * Settings are read on every USE, not captured at import.
 *
 * They used to be module-level consts. That made behaviour depend on WHEN this
 * module was first imported relative to whoever set the environment — which is
 * invisible in production but broke CI for six commits straight while every
 * local run stayed green: three test files configure alerting at their own
 * module top level, and on the GitHub runner one of them lost the import race,
 * so alerting silently ran with defaults and no channel at all. See
 * __tests__/env-config-load-order.test.ts.
 *
 * Reading process.env per call costs nothing next to sending an alert, and it
 * means nothing here cares about module load order ever again.
 */
function num(name: string, dflt: number, min: number): number {
  // A malformed value must fall back to the default, never to NaN — NaN
  // comparisons are all false, which would quietly disable the threshold.
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.max(min, n) : dflt;
}

function cfg() {
  return {
    threshold: num("ALERT_ERROR_THRESHOLD", 5, 1),
    windowMs: num("ALERT_WINDOW_MS", 60_000, 1_000),
    cooldownMs: num("ALERT_COOLDOWN_MS", 900_000, 0),
    emailTo: (process.env.ALERT_EMAIL ?? "")
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean),
    webhookUrl: process.env.ALERT_WEBHOOK_URL?.trim() || undefined,
    appUrl: (process.env.APP_URL ?? "").replace(/\/$/, ""),
    env: process.env.NODE_ENV ?? "development",
    service: process.env.SERVICE_NAME ?? "nvc360-api",
  };
}

/** Is any alert channel configured at all? */
export function alertsEnabled(): boolean {
  const c = cfg();
  return c.emailTo.length > 0 || Boolean(c.webhookUrl);
}

export interface AlertContext {
  /** tenant this error belongs to; "default" / "unknown" are valid */
  companyId: string;
  /** request route template (low cardinality), e.g. /api/bookings/:id */
  route?: string;
  method?: string;
  status?: number;
  requestId?: string;
  /** short error message (already scrubbed upstream) */
  message?: string;
}

// ---- sliding-window counter -------------------------------------------------
// In-memory fallback: timestamps per tenant, pruned to the active window.
const mem = new Map<string, number[]>();
// In-memory cooldown: last-alert epoch ms per tenant.
const memCooldown = new Map<string, number>();

const WINDOW_LUA = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return current
`;

/** Increment the tenant's error counter; return the count within the window. */
async function bumpCount(companyId: string): Promise<number> {
  const { windowMs: WINDOW_MS } = cfg();
  if (redisEnabled()) {
    const r = getRedis();
    if (r) {
      try {
        const bucket = Math.floor(Date.now() / WINDOW_MS);
        const key = `alert:err:${companyId}:${bucket}`;
        const n = (await r.eval(WINDOW_LUA, 1, key, String(WINDOW_MS))) as number;
        return Number(n) || 1;
      } catch (e) {
        log.warn("alerts: redis count failed, using memory", { err: (e as Error).message });
      }
    }
  }
  const now = Date.now();
  const arr = (mem.get(companyId) ?? []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  mem.set(companyId, arr);
  return arr.length;
}

/**
 * Claim the right to alert for this tenant. Returns true exactly once per
 * cooldown window (and on ONE node only when Redis is enabled). False means a
 * recent alert already covers this burst — stay quiet.
 */
async function claimCooldown(companyId: string): Promise<boolean> {
  const { cooldownMs: COOLDOWN_MS } = cfg();
  if (COOLDOWN_MS === 0) return true;
  if (redisEnabled()) {
    const r = getRedis();
    if (r) {
      try {
        // SET key 1 NX PX cooldown → only the first caller in the window wins.
        const res = await r.set(`alert:cd:${companyId}`, "1", "PX", COOLDOWN_MS, "NX");
        return res === "OK";
      } catch (e) {
        log.warn("alerts: redis cooldown failed, using memory", { err: (e as Error).message });
      }
    }
  }
  const now = Date.now();
  const last = memCooldown.get(companyId) ?? 0;
  if (now - last < COOLDOWN_MS) return false;
  memCooldown.set(companyId, now);
  return true;
}

// ---- delivery ---------------------------------------------------------------
function alertHtml(ctx: AlertContext, count: number): string {
  const { appUrl: APP_URL, windowMs: WINDOW_MS, threshold: THRESHOLD, service: SERVICE, env: ENV } = cfg();
  const dash = APP_URL ? `${APP_URL}/admin/observability` : "(set APP_URL to deep-link)";
  const rows: Array<[string, string]> = [
    ["Tenant", ctx.companyId],
    ["Errors in window", `${count} in ${Math.round(WINDOW_MS / 1000)}s (threshold ${THRESHOLD})`],
    ["Route", `${ctx.method ?? "?"} ${ctx.route ?? "?"}`],
    ["Status", String(ctx.status ?? "5xx")],
    ["Last error", ctx.message ?? "(no message)"],
    ["Request id", ctx.requestId ?? "—"],
    ["Service / env", `${SERVICE} / ${ENV}`],
  ];
  const body = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 12px;color:#94a3b8;font:13px system-ui">${k}</td><td style="padding:6px 12px;color:#e2e8f0;font:13px system-ui">${escapeHtml(v)}</td></tr>`,
    )
    .join("");
  return `<div style="background:#0b1220;padding:24px;border-radius:12px;max-width:560px">
    <div style="color:#f87171;font:600 16px system-ui;margin-bottom:8px">⚠ Error burst — tenant ${escapeHtml(ctx.companyId)}</div>
    <table style="border-collapse:collapse;width:100%;background:#0f172a;border-radius:8px">${body}</table>
    <a href="${dash}" style="display:inline-block;margin-top:16px;color:#38bdf8;font:13px system-ui">Open observability dashboard →</a>
  </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

async function deliver(ctx: AlertContext, count: number): Promise<void> {
  const { emailTo: EMAIL_TO, webhookUrl: WEBHOOK_URL, windowMs: WINDOW_MS, env: ENV } = cfg();
  const subject = `[NVC360 ${ENV}] Error burst — tenant ${ctx.companyId} (${count}/${Math.round(WINDOW_MS / 1000)}s)`;

  const jobs: Promise<unknown>[] = [];

  if (EMAIL_TO.length) {
    jobs.push(
      (async () => {
        const { sendEmail } = await import("../../services/email");
        await sendEmail({ to: EMAIL_TO, subject, html: alertHtml(ctx, count) });
      })(),
    );
  }

  if (WEBHOOK_URL) {
    // Slack/Discord-friendly `text` payload + structured fields for richer
    // consumers. Most incoming-webhook receivers accept `{ text }`.
    const text =
      `:rotating_light: *${subject}*\n` +
      `• route: \`${ctx.method ?? "?"} ${ctx.route ?? "?"}\` → ${ctx.status ?? "5xx"}\n` +
      `• last: ${ctx.message ?? "(no message)"}\n` +
      `• reqId: ${ctx.requestId ?? "—"}`;
    jobs.push(
      fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, tenant: ctx.companyId, count, window_ms: WINDOW_MS, ctx }),
        signal: AbortSignal.timeout(5_000),
      }).then((r) => {
        if (!r.ok) throw new Error(`webhook ${r.status}`);
      }),
    );
  }

  const results = await Promise.allSettled(jobs);
  for (const res of results) {
    if (res.status === "rejected") {
      log.error("alerts: delivery failed", { err: String(res.reason), tenant: ctx.companyId });
    }
  }
  log.warn("alerts: error-burst alert sent", { tenant: ctx.companyId, count, route: ctx.route });
}

// ---- public entrypoint ------------------------------------------------------
/**
 * Record a server error and fire an alert if this tenant has crossed the
 * threshold (and isn't in cooldown). Fire-and-forget: returns immediately, all
 * work happens off the request path, and nothing here can throw to the caller.
 */
export function recordError(ctx: AlertContext): void {
  if (!alertsEnabled()) return;
  // Detach from the request lifecycle entirely.
  void (async () => {
    try {
      const count = await bumpCount(ctx.companyId);
      if (count < cfg().threshold) return;
      if (!(await claimCooldown(ctx.companyId))) return;
      await deliver(ctx, count);
    } catch (e) {
      // Alerting must never cascade into more errors.
      log.error("alerts: recordError failed", { err: (e as Error).message });
    }
  })();
}

/**
 * Alert that a piece of infrastructure has failed in a way that silently
 * WEAKENS a guarantee rather than breaking a request.
 *
 * This exists because those failures are invisible by construction: when the
 * rate limiter loses Redis, every request still succeeds, no 5xx is recorded,
 * and `recordError` above never fires — the only observable change is that
 * enforcement got weaker. Nobody finds out until it is abused.
 *
 * Debounced through the same per-key cooldown as error bursts (keyed by
 * component, since this is a fleet-level condition and not a tenant one), so a
 * limiter degrading under load pages once instead of once per request.
 * Fire-and-forget and exception-safe, exactly like recordError.
 */
export function recordInfraDegraded(component: string, detail: string): void {
  if (!alertsEnabled()) return;
  void (async () => {
    try {
      if (!(await claimCooldown(`infra:${component}`))) return;
      const { emailTo: EMAIL_TO, webhookUrl: WEBHOOK_URL, service: SERVICE, env: ENV } = cfg();
      const subject = `[NVC360 ${ENV}] Degraded — ${component}`;
      const text =
        `:warning: *${subject}*\n` +
        `• ${detail}\n` +
        `• service: ${SERVICE} / ${ENV}`;
      const jobs: Promise<unknown>[] = [];
      if (EMAIL_TO.length) {
        jobs.push(
          (async () => {
            const { sendEmail } = await import("../../services/email");
            await sendEmail({
              to: EMAIL_TO,
              subject,
              html: `<div style="background:#0b1220;padding:24px;border-radius:12px;max-width:560px">
    <div style="color:#fbbf24;font:600 16px system-ui;margin-bottom:8px">⚠ Degraded — ${escapeHtml(component)}</div>
    <p style="color:#e2e8f0;font:13px system-ui">${escapeHtml(detail)}</p>
    <p style="color:#94a3b8;font:12px system-ui">${escapeHtml(`${SERVICE} / ${ENV}`)}</p>
  </div>`,
            });
          })(),
        );
      }
      if (WEBHOOK_URL) {
        jobs.push(
          fetch(WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, component, detail, degraded: true }),
            signal: AbortSignal.timeout(5_000),
          }).then((r) => {
            if (!r.ok) throw new Error(`webhook ${r.status}`);
          }),
        );
      }
      const results = await Promise.allSettled(jobs);
      for (const res of results) {
        if (res.status === "rejected") {
          log.error("alerts: degraded delivery failed", { err: String(res.reason), component });
        }
      }
      log.warn("alerts: degraded alert sent", { component, detail });
    } catch (e) {
      log.error("alerts: recordInfraDegraded failed", { err: (e as Error).message });
    }
  })();
}

/** Test/util: clear in-memory state. */
export function _resetAlerts(): void {
  mem.clear();
  memCooldown.clear();
}
