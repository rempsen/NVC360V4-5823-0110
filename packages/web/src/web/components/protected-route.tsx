import { Redirect } from "wouter";
import { useAuth } from "../hooks/use-auth";
import type { Role } from "../lib/auth";
import { Loader } from "./loader";

export function ProtectedRoute({
  children,
  roles,
}: {
  children: React.ReactNode;
  roles?: Role[];
}) {
  const { user, role, isPending, sessionError, refetchSession } = useAuth();

  if (isPending)
    return (
      <div className="grid min-h-screen place-items-center">
        <Loader />
      </div>
    );

  // The session READ failed (offline, rate limited, server hiccup) and we have
  // no cached user to fall back on. That is not a sign-out, so don't throw the
  // person at the login screen — let them retry.
  if (!user && sessionError)
    return (
      <div className="grid min-h-screen place-items-center px-6">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold text-white">Can&apos;t reach the server</h1>
          <p className="mt-2 text-sm text-white/60">
            We couldn&apos;t confirm your session. Check your connection and try again — you
            haven&apos;t been signed out.
          </p>
          <div className="mt-5 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => refetchSession()}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
            >
              Try again
            </button>
            <a href="/sign-in" className="text-sm text-white/50 hover:text-white/80">
              Sign in instead
            </a>
          </div>
        </div>
      </div>
    );

  if (!user) return <Redirect to="/sign-in" />;
  if (roles && !roles.includes(role)) {
    // send to the right home for the role
    const dest =
      role === "admin" || role === "superadmin" ? "/admin" : role === "rider" ? "/rider" : "/app";
    return <Redirect to={dest} />;
  }
  return <>{children}</>;
}
