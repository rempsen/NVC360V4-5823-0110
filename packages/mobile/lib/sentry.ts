import * as Sentry from "@sentry/react-native";
import Constants from "expo-constants";

/**
 * Crash reporting for the driver app.
 *
 * Previously the app had NO crash reporting at all — a native crash on a
 * driver's phone in the field was invisible; the only error UI
 * (components/ErrorBoundary.tsx) only renders on the web build, not on
 * iOS/Android. This closes that gap: Sentry's native SDK hooks in below the
 * JS layer and reports crashes, unhandled JS exceptions, and (at a low
 * sample rate) performance data, with a stack trace and device context.
 *
 * DSN comes from EXPO_PUBLIC_SENTRY_DSN (set in .env) — DSNs are safe to
 * ship in the client bundle (write-only, no read access to your Sentry data).
 * If it's not set (e.g. local dev without a DSN configured), Sentry.init is
 * skipped entirely and the app behaves exactly as before — never blocks or
 * breaks anything on a missing DSN.
 */
const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

export function setupSentry() {
  if (!dsn) {
    console.warn("[sentry] EXPO_PUBLIC_SENTRY_DSN not set — crash reporting disabled");
    return;
  }
  Sentry.init({
    dsn,
    environment: __DEV__ ? "development" : "production",
    release: Constants.expoConfig?.version,
    // Light performance tracing — enough to see slow API calls/screens
    // without generating a lot of event volume on the free tier.
    tracesSampleRate: __DEV__ ? 1.0 : 0.2,
    // Don't spam Sentry with local dev noise.
    enabled: !__DEV__,
    debug: false,
    // The web app reports into this same Sentry project, so every event has to
    // say which app it came from — otherwise a browser error looks like a
    // React Native crash (that is exactly how issue REACT-NATIVE-9, a web
    // rate-limit notice, turned up here).
    initialScope: { tags: { platform: "mobile", app: "nvc360-driver" } },
    beforeSend(event, hint) {
      // A 4xx is the API refusing correctly (signed out, rate limited, job
      // already taken) and is shown to the driver on screen. Never a crash.
      const status = (hint?.originalException as { status?: unknown } | null | undefined)?.status;
      if (typeof status === "number" && status >= 400 && status < 500) return null;
      return event;
    },
  });
}

export { Sentry };
