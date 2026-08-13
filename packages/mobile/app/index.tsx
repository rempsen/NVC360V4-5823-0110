import { useEffect, useRef, useState } from "react";
import { View, Text, ActivityIndicator, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { Fingerprint } from "phosphor-react-native";
import { authClient } from "../lib/auth";
import { C, R } from "../lib/theme";
import { Button } from "../components/ui";
import { shouldPromptBiometric, markUnlockedNow, LocalAuthentication } from "../lib/biometric-lock";
import { endAllLiveActivities } from "../lib/useLiveActivity";

export default function Index() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  // "checking": deciding what to do / running the OS prompt (spinner).
  // "locked": the driver cancelled/failed Face ID — show a manual retry
  // instead of silently re-triggering the OS prompt in a loop.
  const [phase, setPhase] = useState<"checking" | "locked">("checking");
  const attempted = useRef(false);

  async function tryUnlockAndProceed() {
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Unlock NVC360",
        cancelLabel: "Cancel",
        disableDeviceFallback: false,
      });
      if (result.success) {
        await markUnlockedNow();
        // The company picker sits AFTER the security gate on purpose: the
        // driver proves who they are, THEN says who they're working for today.
        router.replace("/pick-company");
      } else {
        // Cancelled or failed — this is NOT a sign-out, just stay here with
        // a retry option (matches how Uber/DoorDash handle a declined
        // biometric prompt: never force a re-login over it).
        setPhase("locked");
      }
    } catch {
      setPhase("locked");
    }
  }

  useEffect(() => {
    if (isPending) return;
    const role = (session?.user as any)?.role;
    if (!session) {
      // Safety net: a Live Activity outlives the app process, so if we ever
      // reach a cold start with no session (session expired, sign-out that
      // didn't finish, app force-quit mid-flow) clear anything still showing.
      endAllLiveActivities().catch(() => {});
      router.replace("/sign-in");
      return;
    }
    if (role !== "rider" && role !== "admin") {
      // customers aren't part of the tech app
      router.replace("/sign-in");
      return;
    }
    if (attempted.current) return;
    attempted.current = true;
    (async () => {
      const needsPrompt = await shouldPromptBiometric();
      if (!needsPrompt) {
        router.replace("/pick-company");
        return;
      }
      await tryUnlockAndProceed();
    })();
    // `tryUnlockAndProceed` is redefined on every render, so listing it would
    // re-run this boot effect constantly. The `attempted` ref already makes the
    // unlock run exactly once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPending, session, router]);

  if (phase === "locked") {
    return (
      <View style={s.wrap}>
        <View style={s.iconWrap}>
          <Fingerprint color={C.brand} size={40} weight="fill" />
        </View>
        <Text style={s.title}>NVC360 is locked</Text>
        <Text style={s.sub}>Unlock with Face ID or your fingerprint to continue.</Text>
        <Button
          title="Unlock"
          onPress={() => {
            setPhase("checking");
            tryUnlockAndProceed();
          }}
          style={{ marginTop: 8, minWidth: 160 }}
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator color={C.brand} size="large" />
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.bg, alignItems: "center", justifyContent: "center", padding: 32, gap: 10 },
  iconWrap: {
    width: 76,
    height: 76,
    borderRadius: R.sheet,
    backgroundColor: C.bg3,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  title: { color: C.text, fontSize: 19, fontWeight: "800" },
  sub: { color: C.sub, fontSize: 13, textAlign: "center", marginBottom: 8 },
});
