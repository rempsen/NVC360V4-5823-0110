import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../lib/query-client";
import { ToastProvider } from "./toast";

interface ProviderProps {
  children: React.ReactNode;
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
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
