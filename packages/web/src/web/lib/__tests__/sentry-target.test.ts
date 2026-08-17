/**
 * Where Sentry is allowed to report from.
 *
 * Why this exists: on Aug 17 2026 a deliberate crash, injected on purpose in
 * the sandbox to prove a browser test could actually fail, was emailed to the
 * owner as a production Sentry alert. The build was a `vite build`, so
 * `import.meta.env.DEV` was false and Sentry initialised — even though the page
 * was served from localhost inside a throwaway sandbox, and even though the
 * "environment" it reported was a flat "production".
 *
 * `import.meta.env.DEV` answers "was this bundled by the dev server", which is
 * not the same question as "is this a real deployment". Only the hostname
 * answers that.
 */
import { describe, it, expect } from "bun:test";
import { sentryTarget } from "../sentry-target";

describe("sentryTarget", () => {
  it("reports from the real production hosts", () => {
    for (const host of ["uberize.ai", "www.uberize.ai", "nvc360.com", "app.nvc360.com"]) {
      const t = sentryTarget(host, false);
      expect(t.report).toBe(true);
      expect(t.environment).toBe("production");
    }
  });

  it("stays silent on localhost even in a production build", () => {
    // The exact case that produced the SABOTAGE email.
    for (const host of ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]) {
      expect(sentryTarget(host, false).report).toBe(false);
    }
  });

  it("stays silent on a sandbox preview host", () => {
    const t = sentryTarget("nvc360-bgyv8cj-preview-4200.runable.site", false);
    expect(t.report).toBe(false);
  });

  it("stays silent on a private LAN address", () => {
    for (const host of ["192.168.1.20", "10.0.0.4", "172.16.4.5"]) {
      expect(sentryTarget(host, false).report).toBe(false);
    }
  });

  it("never reports from a dev-server build, whatever the host", () => {
    expect(sentryTarget("uberize.ai", true).report).toBe(false);
  });

  it("labels a non-production deployment as staging rather than production", () => {
    // A staging deploy SHOULD report — it just must not be indistinguishable
    // from real customer traffic in the issue list.
    const t = sentryTarget("staging.uberize.ai", false);
    expect(t.report).toBe(true);
    expect(t.environment).toBe("staging");
  });

  it("treats an unknown public host as staging, not production", () => {
    // Fail safe: a host nobody added to the list is not assumed to be prod.
    const t = sentryTarget("some-fork.example.com", false);
    expect(t.report).toBe(true);
    expect(t.environment).toBe("staging");
  });

  it("ignores case and a port", () => {
    expect(sentryTarget("Uberize.AI", false).environment).toBe("production");
    expect(sentryTarget("LOCALHOST", false).report).toBe(false);
  });

  it("honours an explicit environment override", () => {
    // Set VITE_SENTRY_ENV and that wins, so a real staging box can label itself
    // without a code change.
    const t = sentryTarget("uberize.ai", false, "canary");
    expect(t.environment).toBe("canary");
    expect(t.report).toBe(true);
  });

  it("an explicit override still cannot switch reporting on for localhost", () => {
    // Otherwise the override becomes a foot-gun that re-creates the original bug.
    expect(sentryTarget("localhost", false, "production").report).toBe(false);
  });
});
