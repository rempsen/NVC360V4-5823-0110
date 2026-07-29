import { Stack } from "expo-router";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { OfflineBanner } from "../components/OfflineBanner";
import { OneDollarStatsProvider } from "../lib/analytics";
import { setupNetworkIntegration } from "../lib/network";
import { C } from "../lib/theme";
import appJson from "../app.json";

const queryClient = new QueryClient({
  defaultOptions: {
    // Mutations (job status changes, notes, messages, photos...) default to
    // networkMode "online" in TanStack Query — meaning if there's no signal
    // when a driver taps a button, the call is PAUSED (not failed/dropped)
    // and fires automatically the instant connectivity returns. Combined
    // with the NetInfo wiring in lib/network.ts, this closes the "did that
    // actually go through?" gap that used to exist on spotty signal.
    mutations: { retry: 1 },
    queries: { retry: 2 },
  },
});

const applicationId = appJson.expo.extra.applicationId ?? "";
const hostname = applicationId ? `${applicationId}-mobile` : "localhost";

export default function RootLayout() {
  useEffect(() => setupNetworkIntegration(), []);
  return (
    <ErrorBoundary>
      {/* Runable analytics provider — do not remove, required for analytics tracking */}
      <OneDollarStatsProvider
        config={{
          hostname,
          collectorUrl: "https://r.lilstts.com/events",
          devmode: true,
        }}
      >
        <SafeAreaProvider>
          <QueryClientProvider client={queryClient}>
            <OfflineBanner />
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: C.bg },
                animation: "fade",
              }}
            >
              <Stack.Screen name="index" />
              <Stack.Screen name="sign-in" />
              <Stack.Screen name="(rider)" />
              <Stack.Screen name="job/[id]" options={{ animation: "slide_from_right" }} />
            </Stack>
          </QueryClientProvider>
        </SafeAreaProvider>
      </OneDollarStatsProvider>
    </ErrorBoundary>
  );
}
