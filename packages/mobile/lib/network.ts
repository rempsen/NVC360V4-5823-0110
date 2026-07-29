import { useEffect, useState } from "react";
import { AppState, type AppStateStatus, Platform } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { onlineManager, focusManager } from "@tanstack/react-query";

/**
 * Wires real device connectivity into TanStack Query so the whole app gets
 * offline resilience for free:
 *  - Queries pause instead of erroring out when there's no signal, and
 *    automatically refetch the moment connectivity returns.
 *  - Mutations (job status changes, messages, notes, photos...) queue up
 *    ("paused") instead of silently failing when a driver taps a button with
 *    no signal, and fire automatically once the phone reconnects — no lost
 *    taps, no "did that actually go through?" uncertainty.
 *  - AppState wired into focusManager so coming back to the app (not just
 *    reconnecting) also triggers a refetch, matching standard app behavior.
 *
 * Call `setupNetworkIntegration()` once at the app root (see app/_layout.tsx).
 */
export function setupNetworkIntegration() {
  onlineManager.setEventListener((setOnline) => {
    return NetInfo.addEventListener((state) => {
      setOnline(!!state.isConnected);
    });
  });

  const onAppStateChange = (status: AppStateStatus) => {
    if (Platform.OS !== "web") {
      focusManager.setFocused(status === "active");
    }
  };
  const sub = AppState.addEventListener("change", onAppStateChange);
  return () => sub.remove();
}

/** Live "am I online right now" flag, for showing an offline banner in the UI. */
export function useIsOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const sub = NetInfo.addEventListener((state) => {
      setOnline(state.isConnected !== false);
    });
    NetInfo.fetch().then((state) => setOnline(state.isConnected !== false));
    return () => sub();
  }, []);
  return online;
}
