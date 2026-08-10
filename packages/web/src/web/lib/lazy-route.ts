/**
 * `React.lazy` that survives a deploy.
 *
 * Every route in this app is code-split, so the HTML shell references chunk
 * filenames that carry a content hash (`zones-BJXN4BuK.js`). A new build
 * produces new hashes and deletes the old files. Anyone with the app already
 * open — a dispatcher who left the console up overnight, a customer sitting on
 * a tracking page — is holding the OLD shell. The moment they navigate to a
 * route they hadn't visited yet, the browser requests a chunk that no longer
 * exists and the dynamic import rejects with:
 *
 *   TypeError: Failed to fetch dynamically imported module: .../zones-<hash>.js
 *
 * That rejection happens during render, so it lands in the route error boundary
 * and the user sees a crash screen for what is really just "you're one version
 * behind". It also fires a Sentry issue per stale tab, which buries real bugs.
 *
 * The recovery is a reload: the shell is served `no-store` (see server.ts), so
 * a reload always fetches the new HTML with the new chunk names. This wrapper
 * does exactly that, once, and only for chunk-load failures — any other import
 * error is rethrown untouched so genuine bugs still reach the boundary and
 * Sentry.
 *
 * The `sessionStorage` timestamp is the loop guard. If a reload doesn't fix it
 * (a genuinely broken deploy, a CDN serving a truncated file), the second
 * failure inside the window rethrows instead of reloading again, so the user
 * gets the error screen rather than an infinite refresh.
 */
import { lazy, type ComponentType } from "react";
import { isStaleChunkError } from "./global-errors";

const RELOAD_KEY = "nvc360:chunk-reload-at";
/** A second stale-chunk failure within this window means reloading isn't working. */
const RELOAD_WINDOW_MS = 20_000;

/** sessionStorage throws in some privacy modes; never let that break routing. */
function lastReloadAt(): number {
  try {
    return Number(window.sessionStorage.getItem(RELOAD_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function markReload(): void {
  try {
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // No storage: we still reload once. Worst case a hard-broken deploy
    // refreshes in a loop, which the user can escape by closing the tab.
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the standard
// React.lazy constraint; props are inferred from the imported component.
type AnyComponent = ComponentType<any>;

export function lazyRoute<T extends AnyComponent>(load: () => Promise<{ default: T }>) {
  return lazy(() =>
    load().catch((err: unknown) => {
      if (typeof window === "undefined" || !isStaleChunkError(err)) throw err;
      if (Date.now() - lastReloadAt() < RELOAD_WINDOW_MS) throw err;

      markReload();
      window.location.reload();

      // Reloading is asynchronous. Hand React a promise that never settles so
      // it keeps showing the Suspense fallback instead of flashing a crash
      // screen for the fraction of a second before the page goes away.
      return new Promise<{ default: T }>(() => {});
    }),
  );
}
