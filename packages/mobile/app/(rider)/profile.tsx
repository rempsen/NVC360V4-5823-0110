import { useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, Alert, ActivityIndicator } from "react-native";
import * as Haptics from "expo-haptics";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { Camera, SignOut } from "phosphor-react-native";
import { api } from "../../lib/api";
import { authClient, clearToken, getToken } from "../../lib/auth";
import { unregisterPushToken } from "../../lib/push";
import { stopLocationSharing } from "../../lib/use-location-heartbeat";
import Constants from "expo-constants";
import { C } from "../../lib/theme";
import { Avatar, Card, Button, FullLoader, Row } from "../../components/ui";
import { isBiometricAvailable, getLockPreference, setLockPreference, clearUnlockStamp } from "../../lib/biometric-lock";

const API = ((Constants.expoConfig?.extra?.apiUrl as string) ?? "").replace(/\/$/, "");

export default function Profile() {
  const router = useRouter();
  const qc = useQueryClient();
  const { data: session } = authClient.useSession();
  const [uploading, setUploading] = useState(false);

  const biometric = useQuery({
    queryKey: ["biometric-lock"],
    queryFn: async () => ({
      available: await isBiometricAvailable(),
      enabled: await getLockPreference(),
    }),
    staleTime: Infinity,
  });
  const toggleBiometric = useMutation({
    mutationFn: async (enabled: boolean) => {
      await setLockPreference(enabled);
      return enabled;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["biometric-lock"] }),
  });

  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const res = await api.riders.me.$get();
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).rider as any;
    },
  });

  const setStatus = useMutation({
    mutationFn: async (status: string) => {
      const res = await api.riders.me.$patch({ json: { status } });
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).rider;
    },
    onSuccess: (_rider, status) => {
      // Stop native background GPS tracking immediately on going Offline —
      // don't wait for the rider layout's own query refetch. The layout's
      // useLocationHeartbeat(onShift) effect will also pick this up once
      // ["me"] refetches, but stopping here is instant instead of depending
      // on network/query timing.
      if (status === "offline") stopLocationSharing().catch(() => {});
      qc.invalidateQueries({ queryKey: ["me"] });
    },
  });

  async function pickPhoto() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission needed", "Allow photo access to update your headshot.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", {
        uri: asset.uri,
        name: asset.fileName || "headshot.jpg",
        type: asset.mimeType || "image/jpeg",
      } as any);
      const res = await fetch(`${API}/api/riders/me/photo`, {
        method: "POST",
        headers: { Authorization: `Bearer ${getToken()}` },
        body: form,
      });
      if (!res.ok) throw new Error("Upload failed");
      await qc.invalidateQueries({ queryKey: ["me"] });
    } catch (e: any) {
      Alert.alert("Upload failed", e?.message || "Try again");
    } finally {
      setUploading(false);
    }
  }

  async function signOut() {
    Alert.alert("Sign out", "End your session?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: async () => {
          // Unhook this device before clearing auth: stop background GPS and
          // remove the push token so a logged-out phone goes dark. Also clear
          // the "already unlocked today" stamp so the NEXT sign-in on this
          // device (possibly a different driver, shared phone) always gets
          // one fresh biometric prompt rather than inheriting today's unlock.
          await unregisterPushToken().catch(() => {});
          await stopLocationSharing().catch(() => {});
          await clearUnlockStamp().catch(() => {});
          await authClient.signOut().catch(() => {});
          await clearToken();
          qc.clear();
          router.replace("/sign-in");
        },
      },
    ]);
  }

  if (me.isLoading) return <FullLoader />;
  const rider = me.data;
  const status = rider?.status ?? "offline";
  // "On the clock" = anything that isn't a deliberate offline. Busy/enroute/onsite
  // are still on-shift, just occupied with a job — so the toggle reads ON.
  const onShift = status !== "offline";
  const busy = status === "busy" || status === "enroute" || status === "onsite";
  const available = status === "available";
  const statusLabel = available ? "Available" : busy ? "Busy" : "Offline";
  const statusColor = available ? C.green : busy ? C.amber : C.muted;

  return (
    <SafeAreaView style={s.safe} edges={["top", "left", "right"]}>
      <View style={s.header}>
        <Text style={s.title}>Profile</Text>
      </View>
      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        <View style={s.idCard}>
          <Pressable
            onPress={pickPhoto}
            style={s.avatarWrap}
            accessibilityRole="button"
            accessibilityLabel="Change profile photo"
          >
            <Avatar name={session?.user?.name} photoUrl={rider?.photoUrl} size={88} />
            <View style={s.camBadge}>
              {uploading ? <ActivityIndicator color="#fff" size="small" /> : <Camera color="#fff" size={16} weight="fill" />}
            </View>
          </Pressable>
          <Text style={s.name}>{session?.user?.name || "Technician"}</Text>
          <Text style={s.email}>{session?.user?.email}</Text>
          <View style={[s.statusChip, onShift ? s.onChip : s.offChip]}>
            <View style={[s.statusDot, { backgroundColor: statusColor }]} />
            <Text style={[s.statusTxt, { color: statusColor }]}>{statusLabel}</Text>
          </View>
        </View>

        <Card>
          <View style={s.availRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.availTitle}>On the clock</Text>
              <Text style={s.availSub}>
                {busy
                  ? "You have active jobs — you stay Busy until they're done or reassigned."
                  : onShift
                  ? "You're available to receive new job offers."
                  : "You're offline and won't receive new offers."}
              </Text>
            </View>
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
                setStatus.mutate(onShift ? "offline" : "available");
              }}
              style={[s.toggle, onShift && s.toggleOn]}
              accessibilityRole="switch"
              accessibilityLabel="On the clock"
              accessibilityState={{ checked: onShift, busy: setStatus.isPending }}
              accessibilityHint={onShift ? "Double tap to go off shift" : "Double tap to go on shift"}
            >
              {setStatus.isPending ? (
                <ActivityIndicator color={onShift ? "#03130d" : C.sub} size="small" />
              ) : (
                <View style={[s.knob, onShift && s.knobOn]} />
              )}
            </Pressable>
          </View>
        </Card>

        {biometric.data?.available && (
          <Card>
            <View style={s.availRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.availTitle}>Face ID / Fingerprint Lock</Text>
                <Text style={s.availSub}>
                  {biometric.data.enabled
                    ? "Unlock NVC360 with Face ID or your fingerprint once a day."
                    : "Off — the app opens without unlocking."}
                </Text>
              </View>
              <Pressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
                  toggleBiometric.mutate(!biometric.data!.enabled);
                }}
                style={[s.toggle, biometric.data.enabled && s.toggleOn]}
                accessibilityRole="switch"
                accessibilityLabel="Face ID / Fingerprint Lock"
                accessibilityState={{ checked: biometric.data.enabled, busy: toggleBiometric.isPending }}
                accessibilityHint={biometric.data.enabled ? "Double tap to turn off" : "Double tap to turn on"}
              >
                {toggleBiometric.isPending ? (
                  <ActivityIndicator color={biometric.data.enabled ? "#03130d" : C.sub} size="small" />
                ) : (
                  <View style={[s.knob, biometric.data.enabled && s.knobOn]} />
                )}
              </Pressable>
            </View>
          </Card>
        )}

        <Card>
          <Text style={s.cardTitle}>Details</Text>
          <Row label="Skill class" value={rider?.skillClass} />
          <Row label="Vehicle" value={rider?.vehicle} />
          <Row label="Phone" value={(session?.user as any)?.phone || rider?.phone} />
          <Row label="Completed jobs" value={String(rider?.completedJobs ?? 0)} />
          <Row label="License plate" value={rider?.licensePlate} />
        </Card>

        <Button title="Sign out" variant="danger" icon={<SignOut color="#fff" size={18} weight="bold" />} onPress={signOut} />
        <Text style={s.foot}>NVC360 Technician · v1.0</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  header: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 8 },
  title: { color: C.text, fontSize: 24, fontWeight: "800" },
  scroll: { padding: 16, gap: 16, paddingBottom: 40 },
  idCard: {
    alignItems: "center",
    gap: 8,
    backgroundColor: C.card,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: C.border,
    paddingVertical: 26,
    paddingHorizontal: 16,
  },
  avatarWrap: { position: "relative" },
  camBadge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    backgroundColor: C.brand,
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: C.card,
  },
  name: { color: C.text, fontSize: 20, fontWeight: "800", marginTop: 4 },
  email: { color: C.sub, fontSize: 13 },
  statusChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    marginTop: 6,
  },
  onChip: { backgroundColor: C.greenBg },
  offChip: { backgroundColor: C.bg3 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusTxt: { fontSize: 13, fontWeight: "700" },
  availRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  availTitle: { color: C.text, fontSize: 15, fontWeight: "700" },
  availSub: { color: C.sub, fontSize: 12, marginTop: 3 },
  toggle: {
    width: 56,
    height: 32,
    borderRadius: 999,
    backgroundColor: C.bg3,
    borderWidth: 1,
    borderColor: C.border,
    padding: 3,
    justifyContent: "center",
  },
  toggleOn: { backgroundColor: C.green, borderColor: C.green },
  knob: { width: 24, height: 24, borderRadius: 12, backgroundColor: C.muted },
  knobOn: { backgroundColor: "#03130d", alignSelf: "flex-end" },
  cardTitle: { color: C.text, fontSize: 15, fontWeight: "700", marginBottom: 6 },
  foot: { color: C.muted, fontSize: 12, textAlign: "center", marginTop: 8 },
});
