import { useEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../lib/query-client";
import { ToastProvider } from "./toast";
import { useAuth } from "../hooks/use-auth";
import { setSentryUser } from "../lib/sentry";

interface ProviderProps {
  children: React.ReactNode;
}

/**
 * Attaches the signed-in user id + role to crash reports. Without this a Sentry
 * issue tells you a page broke but not for whom or in which role, which is the
 * difference between a five-minute fix and an afternoon of guessing.
 * No-ops entirely when Sentry has no DSN.
 */
function SentryIdentity() {
  const { user, role } = useAuth();
  useEffect(() => {
    setSentryUser(user ? { id: user.id, role } : null);
  }, [user?.id, role]);
  return null;
}

/**
 * App-wide providers. The QueryClient itself lives in lib/query-client.ts as a
 * single shared instance (there were previously two nested clients, and the
 * inner one silently shadowed the outer).
 *
 * ToastProvider must sit inside this so the global mutation-error handler on the
 * query client has a mounted toast viewport to render into.
 */
export function Provider({ children }: ProviderProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <SentryIdentity />
        {children}
      </ToastProvider>
    </QueryClientProvider>
  );
}
