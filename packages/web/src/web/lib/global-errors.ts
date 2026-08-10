/**
 * Window-level safety net for errors that escape React and react-query.
 *
 * React error boundaries only catch errors thrown during render. An error
 * thrown inside a `setTimeout`, an event handler's async continuation, or a
 * floating promise (`doThing()` with no `await` and no `.catch`) bypasses every
 * boundary in the tree — before this, those vanished into the console.
 *
 * Two rules here:
 * - The user gets ONE generic toast, de-duped by message. We don't spam a
 *   dispatcher with a stack trace they can't act on, but we also don't let the
 *   UI sit there looking like nothing happened.
 * - Expected API failures (401/403/404, validation 400s) are skipped entirely.
 *   Those already have a proper, specific message via the mutation/query error
 *   handlers; a second generic toast on top is just noise.
 */
import { ApiError } from "./api-error";
import { reportError } from "./sentry";
import { toast } from "../components/toast";

let installed = false;

/** Expected, already-surfaced failures we should stay quiet about. */
function isExpected(err: unknown): boolean {
  if (err instanceof ApiError) return err.status < 500;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  // Chunk-load failures after a deploy: handled below with a specific message.
  return /ResizeObserver loop/i.test(msg);
}

/** A stale lazy chunk after a redeploy — a reload genuinely fixes it. */
export function isStaleChunkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError/i.test(
    msg,
  );
}

export function installGlobalErrorHandlers() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const handle = (err: unknown, source: "error" | "unhandledrejection") => {
    if (isStaleChunkError(err)) {
      toast({
        kind: "warning",
        key: "stale-chunk",
        message: "A new version of the app was released.",
        detail: "Reload the page to continue.",
      });
      return;
    }
    if (isExpected(err)) return;

    reportError(err, { source });
    const msg = err instanceof Error ? err.message : String(err ?? "Unknown error");
    toast({
      kind: "error",
      key: `global:${msg}`,
      message: "Something went wrong in the background.",
      detail: msg.slice(0, 160),
    });
  };

  window.addEventListener("unhandledrejection", (e) => {
    handle(e.reason, "unhandledrejection");
  });

  window.addEventListener("error", (e) => {
    // Resource load failures (<img>, <script>) surface here with no `error`
    // object — not app crashes, and not worth a toast.
    if (!e.error) return;
    handle(e.error, "error");
  });
}
