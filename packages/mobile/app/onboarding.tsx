import { View, Text, StyleSheet, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { MapPinLine, BellRinging, Camera } from "phosphor-react-native";
import { C, R } from "../lib/theme";
import { Button } from "../components/ui";
import { markOnboardingSeen } from "../lib/onboarding";

/**
 * One-time "permissions primer" shown right after first sign-in, before the
 * OS ever asks for Location/Notifications/Camera access.
 *
 * Apple/Google's own guidance (and every well-reviewed field-service app —
 * Uber Driver, DoorDash Dasher, Instacart Shopper — follows this) is to
 * explain WHY an app needs a sensitive permission before the system prompt
 * interrupts the user cold. A driver who understands "location sharing is
 * how dispatch gives your customers an accurate ETA" is far more likely to
 * tap Allow than one who sees a generic OS dialog out of nowhere — and a
 * driver who declines by reflex is a driver who can't get dispatched jobs.
 *
 * This screen does NOT itself request any permission — the real prompts
 * still happen at their existing trigger points (going on shift, taking a
 * job photo, etc. — see lib/use-location-heartbeat.ts, lib/push.ts). It only
 * sets expectations first, then gets out of the way.
 */
export default function Onboarding() {
  const router = useRouter();

  async function continueToApp() {
    await markOnboardingSeen();
    router.replace("/(rider)");
  }

  return (
    <SafeAreaView style={s.safe} edges={["top", "left", "right", "bottom"]}>
      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        <Text style={s.title}>Before you get started</Text>
        <Text style={s.sub}>NVC360 will ask you to allow a few things — here's why.</Text>

        <View style={s.item}>
          <View style={s.iconWrap}>
            <MapPinLine color={C.brand} size={26} weight="fill" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.itemTitle}>Location</Text>
            <Text style={s.itemBody}>
              While you're on shift, we share your live location with dispatch so customers get an accurate ETA
              and the office knows where you are. It's off the moment you go off shift.
            </Text>
          </View>
        </View>

        <View style={s.item}>
          <View style={s.iconWrap}>
            <BellRinging color={C.brand} size={26} weight="fill" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.itemTitle}>Notifications</Text>
            <Text style={s.itemBody}>
              Get an instant alert the moment a new job comes in, or when dispatch or a customer messages you —
              so you never miss a job offer.
            </Text>
          </View>
        </View>

        <View style={s.item}>
          <View style={s.iconWrap}>
            <Camera color={C.brand} size={26} weight="fill" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.itemTitle}>Camera & Photos</Text>
            <Text style={s.itemBody}>
              Attach before/after job photos and update your profile picture directly from the app.
            </Text>
          </View>
        </View>

        <Button title="Got it, let's go" onPress={continueToApp} style={{ marginTop: 8 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  scroll: { flexGrow: 1, padding: 24, paddingTop: 12, justifyContent: "center", gap: 22 },
  title: { fontSize: 24, fontWeight: "800", color: C.text, textAlign: "center" },
  sub: { fontSize: 14, color: C.sub, textAlign: "center", marginBottom: 6 },
  item: { flexDirection: "row", gap: 14, alignItems: "flex-start" },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: R.card,
    backgroundColor: C.bg3,
    alignItems: "center",
    justifyContent: "center",
  },
  itemTitle: { fontSize: 15, fontWeight: "700", color: C.text, marginBottom: 3 },
  itemBody: { fontSize: 13, color: C.sub, lineHeight: 19 },
});
