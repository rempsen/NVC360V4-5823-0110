import app from "./api";
import { reconcileAllRiders } from "./services/presence";
import { rowsNeedingPoll, triggerVerify } from "./services/email-domains";
import { seedRolePermissions } from "./api/routes/team";
import { startRetentionSweeps } from "./services/retention";
import { startScheduler } from "./services/scheduler";
// Importing these registers their scheduler task handlers (review_request,
// maintenance_reminder) at boot. Without the import the queue would claim the
// tasks and find no handler.
import "./services/reviews";
import "./services/maintenance";
import { sweepTimeTriggers } from "./services/automation";
import { log, captureException } from "./api/lib/logger";
import { initRealtimeBus } from "./services/realtime";
import { initRateLimitStore } from "./api/lib/rate-limit";
import { alertsEnabled } from "./api/lib/alerts";
import { closeRedis } from "./api/lib/redis";
import { flushAnalytics } from "./api/lib/analytics";

// Select realtime + rate-limit backends. Redis (multi-node) when REDIS_URL is
// set, in-memory (single-node) otherwise. Wrapped so that even an unexpected
// synchronous throw (e.g. Redis unreachable from a deploy runner) can NEVER
// stop the server from binding its port — otherwise the platform's post-start
// health-check fetch fails and the whole deploy is marked failed ("start-website
// failed: fetch failed"). Degrade to in-memory rather than crash.
try {
  initRealtimeBus();
} catch (e) {
  console.error("initRealtimeBus failed (continuing single-node)", e);
}
try {
  initRateLimitStore();
} catch (e) {
  console.error("initRateLimitStore failed (continuing single-node)", e);
}
log.info(
  alertsEnabled()
    ? "alerts: per-tenant error alerting ENABLED"
    : "alerts: disabled (set ALERT_EMAIL or ALERT_WEBHOOK_URL to enable)",
);

// crash safety — log + report, never silently die
process.on("unhandledRejection", (reason) =>
  captureException(reason, { kind: "unhandledRejection" }),
);
process.on("uncaughtException", (err) => captureException(err, { kind: "uncaughtException" }));

startRetentionSweeps();

// Seed industry-default role permissions on boot (no-op if already present).
seedRolePermissions().catch((e) =>
  console.error("seedRolePermissions (boot) failed", e),
);

const port = Number(process.env.PORT ?? 3000);

// Warm up the Turso connection before serving traffic so the first real user
// request after a cold start / host resume never races the socket coming up.
import { warmUpDb, pingDb } from "./api/database";
warmUpDb().catch((e) => console.error("db warm-up (boot) failed", e));
// Keep the DB socket warm: a cheap `select 1` every 60s stops Turso's
// keep-alive socket from idling out between low-traffic periods.
setInterval(() => {
  pingDb().catch(() => {});
}, 60 * 1000);

// Periodic self-heal: clear any stuck "busy"/"available" mismatches so a tech
// never stays locked by a future-dated or cancelled job. Runs on boot + every 2 min.
reconcileAllRiders().catch((e) => console.error("presence sweep (boot) failed", e));
setInterval(() => {
  reconcileAllRiders().catch((e) => console.error("presence sweep failed", e));
}, 2 * 60 * 1000);

// Deferred task queue: review requests, maintenance reminders, warranty
// nudges, time-based automation. Ticks every 60s; claims are race-safe so a
// rolling deploy running two instances can't double-fire a task.
startScheduler();

// Time-based automation triggers (tech_idle, sla_risk). Nothing fires these —
// they are conditions of time passing — so we sweep once a minute. Cheap: the
// sweep exits immediately when no tenant has an enabled time-based rule.
setInterval(() => {
  sweepTimeTriggers().catch((e) =>
    console.error("automation time sweep failed", e),
  );
}, 60 * 1000);

// Auto-poll pending/verifying email sending domains and flip to verified.
async function pollEmailDomains() {
  const rows = await rowsNeedingPoll();
  for (const r of rows) {
    if (!r.resendDomainId) continue; // not approved yet — nothing to check
    await triggerVerify(r.id).catch((e) =>
      console.error(`email-domain poll failed for ${r.domain}`, e),
    );
  }
}
pollEmailDomains().catch((e) => console.error("email-domain poll (boot) failed", e));
setInterval(() => {
  pollEmailDomains().catch((e) => console.error("email-domain poll failed", e));
}, 2 * 60 * 1000);
const distDir = `${import.meta.dir}/../dist`;
const indexPath = `${distDir}/index.html`;

const server = Bun.serve({
  port,
  // SSE streams (e.g. /api/track/:token/stream) hold the socket open with a
  // 20s heartbeat. Bun's default idleTimeout is 10s and would kill them, so
  // disable the idle timeout. Per-connection lifecycle is managed in-app.
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api")) {
      return app.fetch(request);
    }

    // serve uploaded files from local disk
    if (url.pathname.startsWith("/uploads/")) {
      const safe = decodeURIComponent(url.pathname)
        .replace(/^\/+/, "")
        .replaceAll("..", "");
      const uploaded = Bun.file(`${process.cwd()}/${safe}`);
      if (await uploaded.exists()) return new Response(uploaded);
      return new Response("Not found", { status: 404 });
    }

    const filePath = getStaticFilePath(url.pathname);
    const file = Bun.file(filePath);

    if (await file.exists()) {
      return await serveStatic(filePath, file, url.pathname, request);
    }

    const index = Bun.file(indexPath);
    if (await index.exists()) {
      // SPA shell — must NEVER be cached (CDN, proxy, or browser) so every
      // deploy is picked up immediately and we can't serve an old index.html
      // that references stale, deleted asset hashes (the classic blank-page
      // CDN-cache trap). Asset files under /assets/* are content-hashed and
      // get long immutable cache; the HTML document gets zero cache.
      return new Response(index, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
          Pragma: "no-cache",
          Expires: "0",
          // Tell Cloudflare's CDN explicitly not to hold this object.
          "CDN-Cache-Control": "no-store",
          "Cloudflare-CDN-Cache-Control": "no-store",
        },
      });
    }

    return new Response("Build output not found. Run `bun run build` first.", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
});

console.log(`Web server listening on http://localhost:${server.port}`);

// ---------------------------------------------------------------------------
// Self-ping keep-alive: prevents the Runable (and similar platforms') idle
// shutdown from hibernating the container after extended inactivity.
//
// Every 4 minutes we fetch our own /api/ready endpoint. This keeps the process
// marked "active" by the host runtime and also warms the DB connection. The
// ping uses the public APP_URL (env var set by Runable) so it goes through the
// full CDN + routing path, the same as a real user request, rather than a
// loopback that could be optimised away by the platform.
//
// If APP_URL is not set (local dev), we fall back to localhost so dev mode is
// unaffected.
// ---------------------------------------------------------------------------
const SELF_PING_URL =
  (process.env.APP_URL ?? `http://localhost:${port}`).replace(/\/$/, "") +
  "/api/ready";

setInterval(async () => {
  try {
    const r = await fetch(SELF_PING_URL, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) console.warn(`[keep-alive] /api/ready returned ${r.status}`);
  } catch {
    // Network errors during a self-ping are non-fatal — just swallow.
  }
}, 4 * 60 * 1000);

// Graceful shutdown: stop accepting traffic, then close Redis connections so a
// rolling deploy doesn't leave dangling sockets / half-published messages.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down", { signal });
  try {
    server.stop();
    await flushAnalytics();
    await closeRedis();
  } catch (e) {
    captureException(e, { kind: "shutdown" });
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

function getStaticFilePath(pathname: string) {
  const cleanPath = decodeURIComponent(pathname)
    .replace(/^\/+/, "")
    .replaceAll("..", "");

  return cleanPath ? `${distDir}/${cleanPath}` : indexPath;
}

// ---------------------------------------------------------------------------
// Static asset serving: long-lived, immutable caching for content-hashed build
// assets. Repeat visits hit the browser cache instead of re-downloading.
//
// IMPORTANT: We DO NOT compress (gzip/brotli) at the origin. This app is served
// behind Cloudflare + Google front-end proxies (see `via: 1.1 google` on prod
// responses) which apply their own on-the-fly compression. When the origin ALSO
// sets `Content-Encoding: gzip`, the edge double-handles the body: the response
// reaches the browser tagged `content-encoding: gzip` but with a body that is
// NOT valid gzip. The browser fails to decode it, the JS bundle is garbage, the
// module never evaluates, React never mounts -> BLANK WHITE PAGE. (This was the
// real root cause of the uberize.ai blank-page outage.)
//
// Fix / rule: serve raw, uncompressed bytes from origin and let the CDN compress.
// CDNs negotiate Accept-Encoding correctly and compress text assets edge-side.
// NEVER set Content-Encoding at the origin when behind a compressing CDN.
// ---------------------------------------------------------------------------

function cacheControlFor(pathname: string): string {
  // Vite emits content-hashed files under /assets (e.g. index-CkEh9DlZ.js).
  // These are immutable: a new build changes the hash, so cache forever.
  if (pathname.startsWith("/assets/")) {
    return "public, max-age=31536000, immutable";
  }
  // HTML documents (the SPA shell, served for "/" and any .html) must NEVER be
  // cached by CDN/proxy/browser. A stale index.html references deleted asset
  // hashes and produces a blank white page. This is the classic SPA cache trap.
  if (pathname === "/" || pathname === "" || pathname.endsWith(".html")) {
    return "no-store, no-cache, max-age=0, must-revalidate";
  }
  // Other static files (favicon, manifest, etc.) — short cache, revalidate.
  return "public, max-age=3600, must-revalidate";
}

async function serveStatic(
  filePath: string,
  file: ReturnType<typeof Bun.file>,
  pathname: string,
  request: Request,
): Promise<Response> {
  const type = file.type || "application/octet-stream";
  const size = file.size;
  const cacheControl = cacheControlFor(pathname);
  const baseHeaders: Record<string, string> = {
    "Content-Type": type,
    "Cache-Control": cacheControl,
  };
  // For no-store responses (HTML shell), also tell Cloudflare's CDN explicitly
  // and add legacy proxy hints, so no edge layer can hold a stale document.
  if (cacheControl.includes("no-store")) {
    baseHeaders["CDN-Cache-Control"] = "no-store";
    baseHeaders["Cloudflare-CDN-Cache-Control"] = "no-store";
    baseHeaders["Pragma"] = "no-cache";
    baseHeaders["Expires"] = "0";
  }

  // Serve raw bytes only. We intentionally DO NOT set Content-Encoding here —
  // the CDN (Cloudflare/Google) compresses text assets on the fly and negotiates
  // Accept-Encoding correctly. Setting it at origin behind the CDN produces a
  // body tagged gzip but not actually gzipped -> browser decode failure -> blank
  // page. See the block comment above. `Vary: Accept-Encoding` lets the CDN cache
  // per-encoding variants of the (uncompressed) origin response.
  const etag = `"${size.toString(16)}-${Bun.hash(filePath).toString(16)}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": baseHeaders["Cache-Control"] },
    });
  }
  return new Response(file, {
    headers: {
      ...baseHeaders,
      ETag: etag,
      Vary: "Accept-Encoding",
    },
  });
}
