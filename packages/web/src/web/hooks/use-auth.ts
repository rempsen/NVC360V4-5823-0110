import { authClient } from "../lib/auth";
import type { Role } from "../lib/auth";

type SessionUser = { id: string; name: string; email: string; role?: Role; phone?: string };

/**
 * Last successfully-read session user, cached in-memory for the tab's lifetime.
 *
 * Why: a session read can fail transiently (network blip, 429, server restart).
 * When that happened the app saw "no user" and ProtectedRoute bounced the
 * person to /sign-in mid-work, losing whatever they were doing. A transient
 * READ failure is not proof of a signed-out session, so we keep the last known
 * user and let the UI show a degraded/retry state instead of a logout.
 *
 * This is a UX cache only — it never grants access. Every API call is still
 * authorised server-side, so a stale cache can't read or write anything.
 */
let lastGoodUser: SessionUser | undefined;

export function useAuth() {
  const { data: session, isPending, error, refetch } = authClient.useSession();
  const fresh = session?.user as SessionUser | undefined;

  if (fresh) lastGoodUser = fresh;
  // A definitive "no session" (successful read, empty result) means signed out —
  // drop the cache so sign-out really signs out.
  else if (!isPending && !error) lastGoodUser = undefined;

  const sessionError = !!error;
  const user = fresh ?? (sessionError ? lastGoodUser : undefined);

  return {
    user,
    role: (user?.role ?? "customer") as Role,
    isPending,
    isAuthed: !!user,
    /** the last session read failed (network/429/5xx) — not a sign-out */
    sessionError,
    /** retry the session read */
    refetchSession: refetch,
  };
}
