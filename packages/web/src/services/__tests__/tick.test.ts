/**
 * oncePerTick() — re-entrancy guard for the once-a-minute sweeps.
 *
 * Why this exists: setInterval does NOT wait for the previous run. Every sweep
 * in server.ts (running-late, automation time triggers, email-domain poll,
 * presence reconcile) walks the same rows and writes to them. One slow Turso
 * tick that takes longer than the interval and two passes run concurrently over
 * the same booking — which for the running-late sweep means two "we're running
 * late" texts to the same customer, and for automation means the same rule
 * firing twice.
 *
 * Contract: while a named job is in flight, another start is SKIPPED (not
 * queued — a backlog of stale sweeps is worse than a missed one; the next tick
 * is 60s away and the work is idempotent by design). A throw must release the
 * lock, or one error would wedge the sweep until the next deploy.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { oncePerTick, _resetTicksForTests, isTickRunning } from "../tick";

const defer = () => {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res as () => void;
    reject = rej;
  });
  return { promise, resolve, reject };
};

beforeEach(() => _resetTicksForTests());

describe("oncePerTick", () => {
  it("runs the job and reports that it ran", async () => {
    let runs = 0;
    const r = await oncePerTick("sweep", async () => {
      runs++;
    });
    expect(runs).toBe(1);
    expect(r.ran).toBe(true);
  });

  it("SKIPS a second start while the first is still in flight", async () => {
    let runs = 0;
    const gate = defer();
    const first = oncePerTick("sweep", async () => {
      runs++;
      await gate.promise;
    });

    // Second tick arrives while the first is parked.
    const second = await oncePerTick("sweep", async () => {
      runs++;
    });
    expect(second.ran).toBe(false);
    expect(second.reason).toBe("already-running");
    expect(runs).toBe(1); // the second body never executed

    gate.resolve();
    await first;
    expect(runs).toBe(1);
  });

  it("does not queue the skipped run — it is dropped, not deferred", async () => {
    let runs = 0;
    const gate = defer();
    const first = oncePerTick("sweep", async () => {
      runs++;
      await gate.promise;
    });
    await oncePerTick("sweep", async () => {
      runs++;
    });
    gate.resolve();
    await first;
    // Give any accidental queued continuation a chance to run.
    await new Promise((r) => setTimeout(r, 5));
    expect(runs).toBe(1);
  });

  it("runs again on the next tick once the first has finished", async () => {
    let runs = 0;
    await oncePerTick("sweep", async () => {
      runs++;
    });
    const second = await oncePerTick("sweep", async () => {
      runs++;
    });
    expect(second.ran).toBe(true);
    expect(runs).toBe(2);
  });

  it("releases the lock when the job throws, and swallows the error", async () => {
    const r = await oncePerTick("sweep", async () => {
      throw new Error("turso blip");
    });
    expect(r.ran).toBe(true);
    expect(r.error).toBeInstanceOf(Error);
    expect(isTickRunning("sweep")).toBe(false);

    let runs = 0;
    const next = await oncePerTick("sweep", async () => {
      runs++;
    });
    expect(next.ran).toBe(true);
    expect(runs).toBe(1);
  });

  it("releases the lock when the job throws synchronously", async () => {
    const r = await oncePerTick("sweep", (() => {
      throw new Error("sync boom");
    }) as unknown as () => Promise<void>);
    expect(r.error).toBeInstanceOf(Error);
    expect(isTickRunning("sweep")).toBe(false);
  });

  it("keeps different named jobs independent", async () => {
    const gate = defer();
    let other = 0;
    const busy = oncePerTick("delays", async () => {
      await gate.promise;
    });
    const r = await oncePerTick("automation", async () => {
      other++;
    });
    expect(r.ran).toBe(true);
    expect(other).toBe(1);
    gate.resolve();
    await busy;
  });

  it("exposes whether a job is currently running", async () => {
    const gate = defer();
    expect(isTickRunning("sweep")).toBe(false);
    const p = oncePerTick("sweep", async () => {
      await gate.promise;
    });
    expect(isTickRunning("sweep")).toBe(true);
    gate.resolve();
    await p;
    expect(isTickRunning("sweep")).toBe(false);
  });

  it("returns the job's own result so callers can still log counts", async () => {
    const r = await oncePerTick("sweep", async () => ({ flagged: 3 }));
    expect(r.ran).toBe(true);
    expect(r.value).toEqual({ flagged: 3 });
  });
});
