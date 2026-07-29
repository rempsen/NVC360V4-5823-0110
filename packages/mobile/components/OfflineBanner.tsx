import { View, Text, StyleSheet } from "react-native";
import { WifiSlash } from "phosphor-react-native";
import { C } from "../lib/theme";
import { useIsOnline } from "../lib/network";

/**
 * Global "you're offline" banner. Shown app-wide (mounted once in the root
 * layout) whenever the device loses connectivity, so a driver never wonders
 * whether a tap (status change, message, note) actually went through — it
 * didn't yet, but it's queued and will send automatically the moment
 * connectivity returns (see lib/network.ts).
 */
export function OfflineBanner() {
  const online = useIsOnline();
  if (online) return null;
  return (
    <View style={s.wrap} accessibilityRole="alert" accessibilityLabel="You're offline. Actions will send automatically once you're back online.">
      <WifiSlash color="#fff" size={14} weight="bold" />
      <Text style={s.text}>No connection — actions will send once you're back online</Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: C.red,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  text: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "700",
    textAlign: "center",
  },
});
