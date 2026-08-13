import { useEffect, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Constants from "expo-constants";
import {
  PaperPlaneRight,
  Headset,
  Briefcase,
  CaretRight,
  Wrench,
} from "phosphor-react-native";
import { authHeaders } from "../../lib/auth";
import { C } from "../../lib/theme";
import { FullLoader } from "../../components/ui";
import { NOTIFY_SUMMARY_KEY } from "../../lib/notify-summary";
import { useLiveMessageSignal } from "../../lib/live-messages";

const API = ((Constants.expoConfig?.extra?.apiUrl as string) ?? "").replace(/\/$/, "");

type DirectMsg = {
  id: string;
  senderRole: string;
  senderName: string;
  body: string;
  read: boolean;
  createdAt: string;
};

export default function Messages() {
  const router = useRouter();
  const qc = useQueryClient();
  
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<ScrollView>(null);

  // dispatcher direct thread + current active job thread
  const thread = useQuery({
    queryKey: ["dispatch-thread"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/messages/direct`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ direct: DirectMsg[]; job: any }>;
    },
    // SSE (below) pushes an instant refetch on a new message; this interval
    // is now just a safety net in case the stream silently drops.
    refetchInterval: 60000,
  });
  useLiveMessageSignal("/api/messages/direct/stream", () =>
    qc.invalidateQueries({ queryKey: ["dispatch-thread"] }),
  );

  // new job offers — surfaced here too so the driver never misses one
  const jobs = useQuery({
    queryKey: ["bookings"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/bookings`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed");
      const j = (await res.json()) as { bookings: any[] };
      return j.bookings;
    },
    refetchInterval: 15000,
  });

  const send = useMutation({
    mutationFn: async (body: string) => {
      const res = await fetch(`${API}/api/messages/direct`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => {
      setDraft("");
      qc.invalidateQueries({ queryKey: ["dispatch-thread"] });
    },
  });

  // Explicitly ack read ONCE whenever this screen gains focus — not from the
  // 5s poll. The GET no longer marks-as-read as a side effect (it used to,
  // which meant the app icon's unread badge and the poll were racing each
  // other, and reading a message on a backgrounded/foregrounded app could
  // leave the badge stuck).
  //
  // We refetch the notification summary rather than zeroing the OS badge
  // directly: the icon badge now also counts work orders awaiting accept/
  // decline and anything waiting at the tech's OTHER companies, so slamming it
  // to 0 on reading a message would hide a live work order until the next poll.
  // The tab layout sets the badge from the refreshed count.
  useFocusEffect(
    useCallback(() => {
      fetch(`${API}/api/messages/direct/mark-read`, {
        method: "POST",
        headers: authHeaders(),
      })
        .then(() => {
          qc.invalidateQueries({ queryKey: NOTIFY_SUMMARY_KEY });
        })
        .catch(() => {});
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const direct = thread.data?.direct ?? [];
  const offers = (jobs.data ?? []).filter(
    (b: any) => b.assignStatus === "offered" && b.status !== "completed",
  );

  useEffect(() => {
    const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    return () => clearTimeout(t);
  }, [direct.length]);

  if (thread.isLoading) return <FullLoader label="Loading messages…" />;

  return (
    <SafeAreaView style={s.safe} edges={["top", "left", "right"]}>
      <View style={s.header}>
        <View style={s.headIcon}>
          <Headset color={C.cyan} size={22} weight="fill" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.title}>Dispatch</Text>
          <Text style={s.sub}>Direct line to your dispatcher</Text>
        </View>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={90}
      >
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={s.scroll}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={thread.isRefetching}
              onRefresh={() => thread.refetch()}
              tintColor={C.brand}
            />
          }
        >
          {/* New job offers banner */}
          {offers.length > 0 && (
            <View style={s.offersWrap}>
              <Text style={s.offersLbl}>
                {offers.length} new job {offers.length === 1 ? "offer" : "offers"}
              </Text>
              {offers.map((b: any) => (
                <Pressable
                  key={b.id}
                  style={s.offerCard}
                  onPress={() => router.push("/(rider)")}
                  accessibilityRole="button"
                  accessibilityLabel={`New job offer: ${b.service?.name || b.title || "Service"} at ${b.address || "unknown address"}`}
                >
                  <View style={s.offerIcon}>
                    <Briefcase color={C.brand} size={18} weight="fill" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.offerSvc}>{b.service?.name || b.title || "Service"}</Text>
                    <Text style={s.offerMeta} numberOfLines={1}>
                      {b.address}
                    </Text>
                  </View>
                  <CaretRight color={C.muted} size={18} />
                </Pressable>
              ))}
            </View>
          )}

          {/* Active job thread shortcut */}
          {thread.data?.job && (
            <Pressable
              style={s.jobLink}
              onPress={() => router.push(`/job/${thread.data!.job.id}`)}
              accessibilityRole="button"
              accessibilityLabel={`Open job thread for ${thread.data.job.title}`}
            >
              <Wrench color={C.cyan} size={16} weight="fill" />
              <Text style={s.jobLinkTxt} numberOfLines={1}>
                Job thread · {thread.data.job.title}
              </Text>
              <CaretRight color={C.muted} size={16} />
            </Pressable>
          )}

          {/* Dispatch direct conversation */}
          <View style={{ gap: 10, marginTop: 4 }}>
            {direct.length === 0 ? (
              <View style={s.empty}>
                <Headset color={C.muted} size={40} />
                <Text style={s.emptyTxt}>No messages yet</Text>
                <Text style={s.emptySub}>
                  Message dispatch anytime — they'll reply here.
                </Text>
              </View>
            ) : (
              direct.map((m) => {
                const mine = m.senderRole === "tech";
                return (
                  <View
                    key={m.id}
                    style={[s.bubble, mine ? s.bubbleMine : s.bubbleThem]}
                  >
                    {!mine && (
                      <Text style={s.bubbleName}>{m.senderName || "Dispatch"}</Text>
                    )}
                    <Text style={[s.bubbleTxt, mine && { color: "#04121c" }]}>
                      {m.body}
                    </Text>
                    <Text style={[s.bubbleTime, mine && { color: "rgba(4,18,28,0.55)" }]}>
                      {new Date(m.createdAt).toLocaleTimeString([], {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </Text>
                  </View>
                );
              })
            )}
          </View>
        </ScrollView>

        {/* Composer */}
        <View style={s.composer}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Message dispatch…"
            placeholderTextColor={C.muted}
            style={s.input}
            multiline
            accessibilityLabel="Message to dispatch"
          />
          <Pressable
            onPress={() => draft.trim() && send.mutate(draft.trim())}
            style={[s.sendBtn, !draft.trim() && { opacity: 0.5 }]}
            disabled={!draft.trim() || send.isPending}
            accessibilityRole="button"
            accessibilityLabel="Send message"
          >
            {send.isPending ? (
              <ActivityIndicator color="#04121c" size="small" />
            ) : (
              <PaperPlaneRight color="#04121c" size={20} weight="fill" />
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 6,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  headIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: "rgba(34,211,238,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  title: { color: C.text, fontSize: 20, fontWeight: "800" },
  sub: { color: C.sub, fontSize: 13, marginTop: 2 },
  scroll: { padding: 16, gap: 12, paddingBottom: 30 },
  offersWrap: {
    backgroundColor: "rgba(14,165,233,0.06)",
    borderWidth: 1,
    borderColor: "rgba(14,165,233,0.25)",
    borderRadius: 16,
    padding: 12,
    gap: 10,
  },
  offersLbl: {
    color: C.brand,
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  offerCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: C.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    padding: 12,
  },
  offerIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: C.bg3,
    alignItems: "center",
    justifyContent: "center",
  },
  offerSvc: { color: C.text, fontSize: 15, fontWeight: "700" },
  offerMeta: { color: C.sub, fontSize: 12, marginTop: 2 },
  jobLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(34,211,238,0.08)",
    borderWidth: 1,
    borderColor: "rgba(34,211,238,0.25)",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  jobLinkTxt: { color: C.cyan, fontSize: 13, fontWeight: "700", flex: 1 },
  empty: { alignItems: "center", gap: 8, paddingVertical: 60 },
  emptyTxt: { color: C.text, fontSize: 16, fontWeight: "700" },
  emptySub: { color: C.muted, fontSize: 13, textAlign: "center", paddingHorizontal: 30 },
  bubble: { maxWidth: "82%", borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 },
  bubbleMine: { backgroundColor: C.brand, alignSelf: "flex-end" },
  bubbleThem: {
    backgroundColor: C.bg3,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: C.border,
  },
  bubbleName: { color: C.cyan, fontSize: 11, fontWeight: "700", marginBottom: 3 },
  bubbleTxt: { color: C.text, fontSize: 15, lineHeight: 20 },
  bubbleTime: { color: C.muted, fontSize: 10, marginTop: 4, opacity: 0.75 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 28,
    borderTopWidth: 1,
    borderTopColor: C.border,
    backgroundColor: C.bg2,
  },
  input: {
    flex: 1,
    backgroundColor: C.bg3,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: C.text,
    fontSize: 15,
    maxHeight: 120,
  },
  sendBtn: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: C.brand,
    alignItems: "center",
    justifyContent: "center",
  },
});
