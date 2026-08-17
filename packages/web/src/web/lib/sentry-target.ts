/**
 * Decide whether this page is a real deployment that should report to Sentry,
 * and what to call its environment.
 *
 * Kept in its own module with no `import.meta` and no Sentry import so it is
 * directly unit-testable — see __tests__/sentry-target.test.ts for the incident
 * that motivated it.
 *
 * The rule: reporting is a property of the HOST, not of the build mode. A
 * production bundle served from localhost or a throwaway preview URL is a test
 * run, and its crashes are noise that buries real ones (and pages the owner).
 */

/** Hosts that are the actual product. Anything else public is "staging". */
const PRODUCTION_HOSTS = [
  "uberize.ai",
  "nvc360.com",
  "nvc360.app",
];

/** Host suffixes for ephemeral preview/sandbox deploys — never report. */
const PREVIEW_HOST_SUFFIXES = [
  ".runable.site",
  ".ngrok.io",
  ".ngrok-free.app",
  ".localhost",
  ".local",
  ".test",
];

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"];

/** RFC1918 + link-local: a developer's machine on a LAN, not a deployment. */
function isPrivateAddress(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

export type SentryTarget = {
  /** Whether Sentry.init should run at all. */
  report: boolean;
  /** Value for Sentry's `environment`. */
  environment: string;
};

export function sentryTarget(
  hostname: string,
  isDevBuild: boolean,
  envOverride?: string,
): SentryTarget {
  // Normalise: hostname can arrive with a port, a trailing dot, or mixed case.
  const host = hostname.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");

  const isProdHost = PRODUCTION_HOSTS.some(
    (h) => host === h || host.endsWith(`.${h}`),
  );
  // A subdomain that literally says staging/preview/dev is not production even
  // when it sits under a production domain (staging.uberize.ai).
  const looksNonProd = /^(staging|preview|dev|test|qa|canary)\./.test(host);

  const environment =
    envOverride ?? (isProdHost && !looksNonProd ? "production" : "staging");

  const isLocal =
    LOOPBACK_HOSTS.includes(host) ||
    isPrivateAddress(host) ||
    PREVIEW_HOST_SUFFIXES.some((s) => host.endsWith(s));

  // The override deliberately cannot turn reporting back on for a local or
  // preview host — otherwise it just re-creates the bug it was added after.
  return { report: !isDevBuild && !isLocal && host !== "", environment };
}
