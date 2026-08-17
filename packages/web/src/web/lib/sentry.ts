/**
 * Browser crash + error reporting.
 *
 * Before this, a component crash on the admin console produced a console.error
 * inside the user's browser and nothing else — nobody on our side ever learned
 * it happened. The driver app has had Sentry since the mobile review pass; this
 * is the same treatment for web.
 *
 * Design notes:
 * - Entirely opt-in via `VITE_SENTRY_DSN`. With no DSN every export here is a
 *   safe no-op, so local dev and self-hosted builds are unaffected.
 * - Disabled in dev. Reporting your own hot-reload crashes is pure noise.
 * - `beforeSend` drops *expected* API failures (401/403/404, validation 400s).
 *   Those are already surfaced to the user as a toast; sending them to Sentry
 *   would bury real crashes under a wall of "session expired".
 * - No Session Replay and no PII: this app carries customer addresses and phone
 *   numbers, and a replay of a dispatch board would capture all of it.
 */
import * as Sentry from "@sentry/react";
import { isExpectedApiError, isHandledLocally } from "./api-error";
import { sentryTarget } from "./sentry-target";

const DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;

let enabled = false;

/** True when Sentry is actually reporting (DSN present and not in dev). */
export function sentryEnabled() {
  return enabled;
}

export function initSentry() {
  if (!DSN) return;

  // `import.meta.env.DEV` alone was not enough. A `vite build` in the sandbox
  // is a production bundle by that measure, so a deliberately-injected test
  // crash on localhost was reported as a production issue and emailed out.
  // The host decides — see sentry-target.ts.
  const target = sentryTarget(
    typeof window === "undefined" ? "" : window.location.hostname,
    import.meta.env.DEV,
    import.meta.env.VITE_SENTRY_ENV as string | undefined,
  );
  if (!target.report) return;

  Sentry.init({
    dsn: DSN,
    environment: target.environment,
    // The web app and the driver app currently report into the same Sentry
    // project, so every event has to say which platform it came from —
    // otherwise a browser error looks like a React Native crash.
    initialScope: { tags: { platform: "web", app: "nvc360-web" } },
    // Keep the payload lean — this is error monitoring, not analytics.
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    ignoreErrors: [
      // Benign browser/extension noise that is not an app bug.
      "ResizeObserver loop limit exceeded",
      "ResizeObserver loop completed with undelivered notifications",
      "Non-Error promise rejection captured",
      /^Load failed$/,
      /^Failed to fetch$/,
      /chrome-extension:/,
    ],
    beforeSend(event, hint) {
      const err = hint?.originalException;
      // Expected, user-visible, already surfaced. Only server faults are ours.
      // Duck-typed on `status` (not `instanceof ApiError`) because mutations
      // routinely re-throw a friendly Error and lose the class on the way out —
      // that is how a 429 rate-limit notice became an "error" issue in Sentry.
      if (isExpectedApiError(err)) return null;
      if (isHandledLocally(err)) return null;
      return event;
    },
  });

  enabled = true;
}

/** Attach the signed-in user so a crash report says who hit it. */
export function setSentryUser(user: { id: string; email?: string | null; role?: string | null } | null) {
  if (!enabled) return;
  if (!user) {
    Sentry.setUser(null);
    return;
  }
  // id + role only. Email is PII we don't need to triage a stack trace.
  Sentry.setUser({ id: user.id });
  if (user.role) Sentry.setTag("role", user.role);
}

/** Tag the tenant so we can tell a one-company bug from a platform-wide one. */
export function setSentryTenant(companyId: string | null) {
  if (!enabled) return;
  Sentry.setTag("company_id", companyId ?? "none");
}

/**
 * Report an error. Always logs to the console so behaviour is identical whether
 * or not a DSN is configured.
 */
export function reportError(err: unknown, context?: Record<string, unknown>) {
  console.error("[error]", err, context ?? "");
  if (!enabled) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

/** Breadcrumb — shows up as the trail leading into a crash. */
export function trace(message: string, data?: Record<string, unknown>) {
  if (!enabled) return;
  Sentry.addBreadcrumb({ message, data, level: "info" });
}

export { Sentry };
