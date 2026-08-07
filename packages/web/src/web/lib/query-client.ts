import { QueryClient, MutationCache, QueryCache } from "@tanstack/react-query";
import { ApiError, errorMessage } from "./api-error";
import { toast } from "../components/toast";

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

      // key de-dupes a burst of identical failures into one toast.
      toast({ kind: "error", message: msg, detail, key: `mut:${msg}` });

      console.error("[mutation] failed", error);
    },
  }),

  queryCache: new QueryCache({
    onError: (error, query) => {
      if (handleAuthExpiry(error)) return;

      // Reads are noisier and often recover on their own; only surface a read
      // failure when react-query already has no data to show for that key,
      // otherwise a background refetch blip would toast over a working screen.
      if (query.state.data !== undefined) return;

      toast({
        kind: "warning",
        message: `Couldn't load data — ${errorMessage(error)}`,
        key: `qry:${String(query.queryHash)}`,
      });
      console.error("[query] failed", query.queryHash, error);
    },
  }),
});
