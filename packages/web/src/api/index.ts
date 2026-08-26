import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth";
import { authMiddleware } from "./middleware/auth";
import { AppError } from "./lib/errors";
import { captureException, requestLogger } from "./lib/logger";
import type { Variables } from "./env";
import { recordError } from "./lib/alerts";
import { apiLimiter, authSurfaceLimiter } from "./lib/rate-limit";
import { recordHttp, renderProm, renderJson, templatePath } from "./lib/metrics";
import { servicesRoutes } from "./routes/services";
import { catalogRoutes } from "./routes/catalog";
import { bookingsRoutes } from "./routes/bookings";
import { trackingRoutes } from "./routes/tracking";
import { ridersRoutes } from "./routes/riders";
import { paymentsRoutes } from "./routes/payments";
import { paymentsWebhookRoutes } from "./routes/payments-webhook";
import { notificationsRoutes } from "./routes/notifications";
import { adminRoutes } from "./routes/admin";
import { trackRoutes } from "./routes/track";
import { propertyPublicRoutes } from "./routes/property-public";
import { maintenanceRoutes } from "./routes/maintenance";
import { optionCatalogRoutes } from "./routes/option-catalog";
import { optionSelectionsRoutes } from "./routes/option-selections";
import { messagesRoutes } from "./routes/messages";
import { fleetRoutes } from "./routes/fleet";
import { aiRoutes } from "./routes/ai";
import { templatesRoutes } from "./routes/templates";
import { automationRoutes } from "./routes/automation";
import { integrationsRoutes } from "./routes/integrations";
import { exportRoutes } from "./routes/export";
import { jobSearchRoutes } from "./routes/job-search";
import { settingsRoutes } from "./routes/settings";
import { tagsRoutes } from "./routes/tags";
import { customFieldsRoutes } from "./routes/custom-fields";
import { uploadsRoutes } from "./routes/uploads";
import { geoRoutes } from "./routes/geo";
import { zonesRoutes } from "./routes/zones";
import { changeRequestsRoutes } from "./routes/change-requests";
import { delaysRoutes } from "./routes/delays";
import { shiftsRoutes } from "./routes/shifts";
import { payoutsRoutes } from "./routes/payouts";
import { reviewsRoutes } from "./routes/reviews";
import { auditRoutes } from "./routes/audit";
import { notifConfigRoutes } from "./routes/notif-config";
import { invitesRoutes } from "./routes/invites";
import { skillsRoutes } from "./routes/skills";
import { pricingRoutes } from "./routes/pricing";
import { calendarRoutes } from "./routes/calendar";
import { reportsRoutes } from "./routes/reports";
import { apiKeysRoutes } from "./routes/api-keys";
import { mcpRoutes } from "./routes/mcp";
import { meRoutes } from "./routes/me";
import { teamRoutes } from "./routes/team";
import { superadminRoutes } from "./routes/superadmin";
import { formsRoutes } from "./routes/forms";
import { publicFormsRoutes } from "./routes/public-forms";

// CORS allowlist: comma-separated origins in CORS_ORIGINS. "*" allows all
// (dev only). Credentials are only echoed for explicitly-allowed origins.
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? "*")
  .split(",")
  .map((s: string) => s.trim())
  .filter(Boolean);
const ALLOW_ALL = CORS_ORIGINS.includes("*");

const app = new Hono<{ Variables: Variables }>()
  // request id + per-request logger (correlation across the request lifecycle)
  .use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") || crypto.randomUUID();
    c.set("requestId", requestId);
    c.set("log", requestLogger(requestId, { path: c.req.path, method: c.req.method }));
    c.header("X-Request-Id", requestId);
    const start = performance.now();
    await next();
    const ms = Math.round(performance.now() - start);
    // feed application metrics (route-templated, low-cardinality) — skip the
    // metrics endpoints themselves to avoid self-referential noise.
    const p = c.req.path;
    if (p !== "/api/metrics" && p !== "/api/metrics.json") {
      recordHttp(c.req.method, p, c.res.status, ms);
    }
    // access log (skip noisy health checks)
    if (p !== "/api/health") {
      c.get("log").info("request", { status: c.res.status, ms });
    }
  })
  .use(
    cors({
      origin: (origin) => {
        if (ALLOW_ALL) return origin ?? "*";
        if (origin && CORS_ORIGINS.includes(origin)) return origin;
        return ""; // not allowed — no ACAO header echoed
      },
      credentials: true,
      exposeHeaders: ["set-auth-token", "X-Request-Id"],
    }),
  )
  // global error handler — sanitized envelope, never leaks stacks
  .onError((err, c) => {
    const reqId = c.get("requestId");
    // Tenant for per-tenant alerting. Safe even before authMiddleware runs
    // (companyId unset → "unknown"); never throws.
    const tenant = (c.get("companyId") as string | undefined) ?? "unknown";
    const route = templatePath(c.req.path);
    if (err instanceof AppError) {
      if (err.status >= 500) {
        captureException(err, { requestId: reqId });
        recordError({
          companyId: tenant,
          route,
          method: c.req.method,
          status: err.status,
          requestId: reqId,
          message: err.message,
        });
      }
      // Validation failures carry a per-field map in `details`. Lift it to the
      // top level (plus a bare `message`) so form screens can highlight the
      // offending input instead of showing one generic toast.
      const fields =
        err.expose && err.details && typeof err.details === "object"
          ? (err.details as { fields?: Record<string, string> }).fields
          : undefined;
      return c.json(
        {
          error: { code: err.code, message: err.expose ? err.message : "Internal server error" },
          ...(fields ? { fields, message: err.message } : {}),
          requestId: reqId,
        },
        err.status as 400,
      );
    }
    const eventId = captureException(err, { requestId: reqId });
    recordError({
      companyId: tenant,
      route,
      method: c.req.method,
      status: 500,
      requestId: reqId,
      message: err instanceof Error ? err.message : String(err),
    });
    return c.json(
      { error: { code: "internal", message: "Internal server error" }, requestId: reqId, eventId },
      500,
    );
  })
  .notFound((c) =>
    c.json({ error: { code: "not_found", message: "Not found" }, requestId: c.get("requestId") }, 404),
  )
  // throttle credential auth surfaces hard (brute-force defense); session reads
  // (get-session etc.) get a generous budget so page loads never 429 -> /sign-in
  .use("/api/auth/*", authSurfaceLimiter)
  .on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
  // Stripe webhook — MUST stay before basePath/authMiddleware/json parsing so
  // the handler can read the raw body for signature verification, and so it is
  // reachable unauthenticated (Stripe authenticates via the signature).
  .route("/api/payments/webhook", paymentsWebhookRoutes)
  // PUBLIC intake forms — embeddable on any tenant's own website, so CORS is
  // permissive here (auth is the publishable key + origin allow-list on the key,
  // NOT CORS). Mounted before basePath/authMiddleware so it stays unauthenticated.
  .use("/api/public/*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["Content-Type", "X-Public-Key"] }))
  .route("/api/public/forms", publicFormsRoutes)
  // PUBLIC object proxy — streams a stored file (S3 or local) without auth so
  // <img> tags, public tracking pages and outbound email logos load anywhere.
  // The bucket itself stays private; only objects whose key is known load.
  .get("/api/public/file/:key{.+}", async (c) => {
    const { getObjectBody } = await import("./lib/storage");
    const key = decodeURIComponent(c.req.param("key"));
    const obj = await getObjectBody(key);
    if (!obj) return c.json({ message: "Not found" }, 404);
    // Content-Length must be set explicitly — without it, HEAD requests (which
    // many email clients / image proxies send to validate an image before
    // rendering it, e.g. Gmail's image proxy) came back as `content-length: 0`
    // even though GET returned the full body. That 0-length HEAD response is
    // exactly why tenant header logos were intermittently rendering as broken
    // images in real inboxes despite looking fine in the in-app preview.
    // `obj.body` is a Uint8Array. Since TS 5.7 that carries an ArrayBufferLike
    // type argument the DOM `BodyInit` union doesn't accept, though the runtime
    // accepts it fine — hence the cast rather than a copy.
    return new Response(c.req.method === "HEAD" ? null : (obj.body as unknown as BodyInit), {
      headers: {
        "Content-Type": obj.contentType,
        "Content-Length": String(obj.body.byteLength),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  })
  // Metrics exposition — mounted BEFORE auth so monitoring backends can scrape
  // without a session. Optionally protected by a bearer token: set METRICS_TOKEN
  // and scrapers send `Authorization: Bearer <token>`. Unset = open (fine when
  // the endpoint isn't internet-exposed or sits behind an allow-list).
  .use("/api/metrics", async (c, next) => {
    const tok = process.env.METRICS_TOKEN;
    if (tok && c.req.header("authorization") !== `Bearer ${tok}`) {
      return c.json({ error: { code: "unauthorized", message: "metrics token required" } }, 401);
    }
    await next();
  })
  .get("/api/metrics", (c) =>
    c.body(renderProm(), 200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" }),
  )
  .use("/api/metrics.json", async (c, next) => {
    const tok = process.env.METRICS_TOKEN;
    if (tok && c.req.header("authorization") !== `Bearer ${tok}`) {
      return c.json({ error: { code: "unauthorized", message: "metrics token required" } }, 401);
    }
    await next();
  })
  .get("/api/metrics.json", (c) => c.json(renderJson(), 200))
  .basePath("api")
  .use("*", authMiddleware)
  // general API limiter (per-user / per-IP). Public track + ping have their own.
  .use("*", apiLimiter)
  .get("/health", (c) => c.json({ status: "ok" }, 200))
  // deep readiness probe — checks the DB is actually reachable
  .get("/ready", async (c) => {
    const checks: Record<string, string> = {};
    let ok = true;
    try {
      const { db } = await import("./database");
      const { sql } = await import("drizzle-orm");
      await db.execute(sql`select 1`);
      checks.database = "ok";
    } catch (e) {
      ok = false;
      checks.database = "down";
      captureException(e, { probe: "ready" });
    }
    const { storageMode } = await import("./lib/storage");
    checks.storage = storageMode;

    // Realtime + rate-limit backend (redis when REDIS_URL set, else memory).
    const { redisEnabled, getRedis } = await import("./lib/redis");
    if (redisEnabled()) {
      try {
        const r = getRedis();
        const pong = await r?.ping();
        checks.redis = pong === "PONG" ? "ok" : "down";
        if (pong !== "PONG") ok = false;
      } catch {
        checks.redis = "down";
        ok = false;
      }
    } else {
      checks.redis = "memory";
    }
    const { realtimeStats } = await import("../services/realtime");
    checks.realtime = realtimeStats().backend;

    return c.json({ status: ok ? "ok" : "degraded", checks }, ok ? 200 : 503);
  })
  .post("/seed", async (c) => {
    const { seed } = await import("./seed");
    const result = await seed();
    return c.json(result, 200);
  })
  .route("/services", servicesRoutes)
  .route("/catalog", catalogRoutes)
  .route("/bookings", bookingsRoutes)
  .route("/jobs", jobSearchRoutes)
  .route("/tracking", trackingRoutes)
  .route("/riders", ridersRoutes)
  .route("/payments", paymentsRoutes)
  .route("/notifications", notificationsRoutes)
  .route("/admin", adminRoutes)
  .route("/track", trackRoutes)
  // Public, persistent property hub (no auth) — /p/:token service history.
  .route("/property", propertyPublicRoutes)
  // Public options/selections page (no auth) — token-based, same trust model as /track.
  .route("/selections", optionSelectionsRoutes)
  // Admin-authenticated options/tier catalog CRUD + attach-rate reporting.
  .route("/option-catalog", optionCatalogRoutes)
  .route("/messages", messagesRoutes)
  .route("/fleet", fleetRoutes)
  .route("/ai", aiRoutes)
  .route("/templates", templatesRoutes)
  .route("/automation", automationRoutes)
  .route("/maintenance", maintenanceRoutes)
  .route("/integrations", integrationsRoutes)
  .route("/export", exportRoutes)
  .route("/settings", settingsRoutes)
  .route("/tags", tagsRoutes)
  .route("/custom-fields", customFieldsRoutes)
  .route("/uploads", uploadsRoutes)
  .route("/geo", geoRoutes)
  .route("/zones", zonesRoutes)
  .route("/change-requests", changeRequestsRoutes)
  .route("/delays", delaysRoutes)
  .route("/shifts", shiftsRoutes)
  .route("/payouts", payoutsRoutes)
  .route("/reviews", reviewsRoutes)
  .route("/audit", auditRoutes)
  .route("/notif-config", notifConfigRoutes)
  .route("/invites", invitesRoutes)
  .route("/skills", skillsRoutes)
  .route("/pricing", pricingRoutes)
  .route("/calendar", calendarRoutes)
  .route("/reports", reportsRoutes)
  .route("/api-keys", apiKeysRoutes)
  .route("/forms", formsRoutes)
  .route("/mcp", mcpRoutes)
  .route("/me", meRoutes)
  .route("/team", teamRoutes)
  .route("/superadmin", superadminRoutes);

export type AppType = typeof app;
export default app;
