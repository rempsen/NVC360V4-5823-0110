import { QueryClient, MutationCache, QueryCache } from "@tanstack/react-query";
import { ApiError, errorMessage, errorStatus, isExpectedApiError, isHandledLocally } from "./api-error";
import { toast } from "../components/toast";
import { reportError } from "./sentry";

/**
 * Only server faults and unexpected exceptions go to Sentry. A 400/401/404 is
 * the API working correctly and is already shown to the user as a toast.
 *
 * The status test is duck-typed (`isExpectedApiError`) rather than
 * `instanceof ApiError`: a mutation that catches an ApiError and re-throws a
 * plain `new Error("nice message for the customer")` used to lose the status on
 * the way out, so a 429 from the public message rate-limiter arrived here as an
 * unclassified Error and opened a Sentry issue titled "Too many messages just
 * now — please wait a minute and try again." That is a rate limiter doing its
 * job, not a bug, and it buried real crashes.
 */
function reportIfOurFault(error: unknown, context: Record<string, unknown>) {
  if (isExpectedApiError(error)) return;
  // A screen that renders its own explanation has handled the failure — unless
  // it was a server fault, which is always ours to fix.
  const status = errorStatus(error);
  if (isHandledLocally(error) && (status === undefined || status < 500)) return;
  reportError(error, context);
}

/**
 * The app's ONE QueryClient.
 *
 * There used to be two — one in main.tsx and one in components/provider.tsx,
 * nested. The inner provider silently shadowed the outer, so any client-level
 * config set in main.tsx never applied to a single component. Consolidating
 * here is what makes the global error handling below actually reachable.
 *
 * `MutationCache.onError` is the lever that fixes ~130 mutations without editing
 * them: it fires for EVERY failed mutation, whether or not that mutation has its
 * own `onError`. Combined with the throwing `apiFetch`, a rejected write can no
 * longer pass silently anywhere in the app.
 */

/** 401s are a signed-out session, not a per-action failure — handle once. */
let redirectingToSignIn = false;

function handleAuthExpiry(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 401) return false;
  if (redirectingToSignIn) return true;

  // Public, no-login surfaces (tracking links, intake forms, the property hub)
  // legitimately hit endpoints that can 401. Never bounce those visitors to a
  // sign-in page they have no business seeing.
  const path = window.location.pathname;
  const isPublic = /^\/(t|s|p|f|join)\//.test(path) || path === "/" || path.startsWith("/sign-");
  if (isPublic) return true;

  redirectingToSignIn = true;
  toast({ kind: "warning", message: "Your session expired — please sign in again.", key: "auth-expired" });
  setTimeout(() => {
    window.location.href = `/sign-in?next=${encodeURIComponent(path + window.location.search)}`;
  }, 1200);
  return true;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      // Writes must never be retried automatically — a retried "complete job"
      // or "fire event" can double-send an SMS or double-charge.
      retry: 0,
    },
  },

  mutationCache: new MutationCache({
    onError: (error) => {
      if (handleAuthExpiry(error)) return;

      const msg = errorMessage(error);
      const detail =
        error instanceof ApiError && error.requestId && error.status >= 500
          ? `Reference: ${error.requestId}`
          : undefined;

      // Screens that render the failure themselves (inline `role="alert"` under
      // the input, e.g. the public tracking page's message box) opted out: a
      // toast on top of that shows the customer the same sentence twice.
      if (!isHandledLocally(error)) {
        // key de-dupes a burst of identical failures into one toast.
        toast({ kind: "error", message: msg, detail, key: `mut:${msg}` });
      }

      reportIfOurFault(error, { kind: "mutation" });
    },
  }),

  queryCache: new QueryCache({
    onError: (error, query) => {
      if (handleAuthExpiry(error)) return;

      // Reads are noisier and often recover on their own; only surface a read
      // failure when react-query already has no data to show for that key,
      // otherwise a background refetch blip would toast over a working screen.
      if (query.state.data !== undefined) return;

      // Opt-out for screens that render their own explanation of the failure
      // (e.g. the public tracking page's "this link is invalid or has expired").
      // Set `meta: { silentError: true }` on the query.
      if ((query.meta as { silentError?: boolean } | undefined)?.silentError) {
        reportIfOurFault(error, { kind: "query", queryHash: String(query.queryHash) });
        return;
      }

      toast({
        kind: "warning",
        message: `Couldn't load data — ${errorMessage(error)}`,
        key: `qry:${String(query.queryHash)}`,
      });
      reportIfOurFault(error, { kind: "query", queryHash: String(query.queryHash) });
    },
  }),
});
