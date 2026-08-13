import { useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  Pressable,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { MapPin, CaretRight, Clock, CurrencyDollar, CheckCircle, Buildings } from "phosphor-react-native";
import { api } from "../../lib/api";
import { authClient } from "../../lib/auth";
import { C, R, fmtDate, money } from "../../lib/theme";
import { StatusBadge, Card, Button, ListSkeleton, Empty } from "../../components/ui";
import Constants from "expo-constants";
import { authHeaders } from "../../lib/auth";
import { useCustomerNoun } from "../../lib/use-brand";
import { useNotifySummary, NOTIFY_SUMMARY_KEY } from "../../lib/notify-summary";
import { companyAlertText } from "../../components/company-alert";

const API = ((Constants.expoConfig?.extra?.apiUrl as string) ?? "").replace(/\/$/, "");

type Booking = any;

const ACTIVE = new Set(["assigned", "enroute", "arrived", "in_progress"]);

export default function Jobs() {
  const router = useRouter();
  const qc = useQueryClient();
  const { data: session } = authClient.useSession();
  const firstName = (session?.user?.name || "Tech").split(" ")[0];

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["bookings"],
    queryFn: async () => {
      const res = await api.bookings.$get();
      if (!res.ok) throw new Error("Failed to load jobs");
      const j = (await res.json()) as { bookings: Booking[] };
      return j.bookings;
    },
    refetchInterval: 20000,
  });

  const { data: todayStats } = useQuery({
    queryKey: ["today-stats"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/bookings/today-stats`, {
        headers: authHeaders(),
      });
      if (!res.ok) return { jobsDone: 0, earnings: 0, activeJobs: 0, totalToday: 0 };
      return res.json() as Promise<{ jobsDone: number; earnings: number; activeJobs: number; totalToday: number }>;
    },
    refetchInterval: 30000,
  });

  // Accepting or declining is the action that CLEARS a pending-work-order
  // badge, so both refresh the notification summary immediately instead of
  // leaving a red number on a job the tech just dealt with for up to one poll.
  const clearBadges = () => {
    qc.invalidateQueries({ queryKey: ["bookings"] });
    qc.invalidateQueries({ queryKey: NOTIFY_SUMMARY_KEY });
  };

  const accept = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.bookings[":id"].accept.$post({ param: { id } });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: clearBadges,
  });
  const decline = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.bookings[":id"].decline.$post({
        param: { id },
        json: { reason: "Declined from app" },
      } as any);
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: clearBadges,
  });

  // Work waiting at the tech's OTHER employer(s). The job list itself is
  // tenant-scoped, so without this the only hint would be a number on the
  // Profile tab with no explanation of what it means.
  const notify = useNotifySummary();

  const onRefresh = useCallback(() => {
    refetch();
    qc.invalidateQueries({ queryKey: ["today-stats"] });
    qc.invalidateQueries({ queryKey: NOTIFY_SUMMARY_KEY });
  }, [refetch, qc]);

  // Skeletons rather than a spinner: this is the first screen of the shift and
  // the one most often opened on bad signal, so it should look like the job
  // list arriving, not like the app hanging.
  if (isLoading)
    return (
      <SafeAreaView style={s.safe} edges={["top", "left", "right"]}>
        <View style={s.header}>
          <Text style={s.hi}>Loading…</Text>
        </View>
        <View style={{ padding: 16, gap: 12 }}>
          <ListSkeleton rows={3} />
        </View>
      </SafeAreaView>
    );

  const bookings = data ?? [];
  const offered = bookings.filter((b) => b.assignStatus === "offered" && b.status !== "completed");
  const active = bookings.filter(
    (b) => b.assignStatus === "accepted" && ACTIVE.has(b.status)
  );
  const upcoming = active.filter((b) => b.status === "assigned");
  const inflight = active.filter((b) => b.status !== "assigned");

  const stats = todayStats ?? { jobsDone: 0, earnings: 0, activeJobs: 0, totalToday: 0 };

  return (
    <SafeAreaView style={s.safe} edges={["top", "left", "right"]}>
      <View style={s.header}>
        <View>
          <Text style={s.hi}>Hi, {firstName}</Text>
          <Text style={s.date}>{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</Text>
        </View>
        <View style={s.countPill}>
          <Text style={s.countNum}>{active.length}</Text>
          <Text style={s.countLbl}>active</Text>
        </View>
      </View>

      {/* Today's earnings summary strip */}
      {(stats.jobsDone > 0 || stats.totalToday > 0) && (
        <View style={s.statsStrip}>
          <View style={s.statItem}>
            <CheckCircle color={C.green} size={16} weight="fill" />
            <Text style={s.statVal}>{stats.jobsDone}</Text>
            <Text style={s.statLbl}>done today</Text>
          </View>
          <View style={s.statDivider} />
          <View style={s.statItem}>
            <CurrencyDollar color={C.green} size={16} weight="fill" />
            <Text style={s.statVal}>{money(stats.earnings)}</Text>
            <Text style={s.statLbl}>earned today</Text>
          </View>
          {stats.totalToday > 0 && (
            <>
              <View style={s.statDivider} />
              <View style={s.statItem}>
                <Clock color={C.sub} size={16} weight="fill" />
                <Text style={s.statVal}>{stats.jobsDone}/{stats.totalToday}</Text>
                <Text style={s.statLbl}>jobs</Text>
              </View>
            </>
          )}
        </View>
      )}

      {notify.elsewhere.length > 0 && (
        <Pressable
          onPress={() => router.push("/(rider)/profile")}
          accessibilityRole="button"
          accessibilityLabel={`${notify.elsewhere
            .map((x) => `${companyAlertText(x)} at ${x.company}`)
            .join(", ")}. Opens your companies to switch.`}
          style={({ pressed }) => [s.elsewhere, pressed && { opacity: 0.75 }]}
        >
          <View style={s.elsewhereIcon}>
            <Buildings color={C.red} size={18} weight="fill" />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.elsewhereTitle} numberOfLines={1}>
              {notify.elsewhere.length === 1
                ? `${notify.elsewhere[0]!.company} is waiting on you`
                : `${notify.elsewhere.length} other companies are waiting on you`}
            </Text>
            <Text style={s.elsewhereSub} numberOfLines={1}>
              {notify.elsewhere.length === 1
                ? `${companyAlertText(notify.elsewhere[0]!)} · tap to switch`
                : "Tap to see which and switch"}
            </Text>
          </View>
          <CaretRight color={C.red} size={16} weight="bold" />
        </Pressable>
      )}

      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={onRefresh} tintColor={C.brand} />
        }
        showsVerticalScrollIndicator={false}
      >
        {offered.length > 0 && (
          <Section title="New offers" accent>
            {offered.map((b) => (
              <Card key={b.id} style={{ borderColor: C.brand, borderWidth: 1.5 }}>
                <JobHead b={b} />
                <View style={s.actions}>
                  <Button
                    title="Accept"
                    variant="success"
                    small
                    loading={accept.isPending}
                    onPress={() => accept.mutate(b.id)}
                    style={{ flex: 1 }}
                  />
                  <Button
                    title="Decline"
                    variant="outline"
                    small
                    loading={decline.isPending}
                    onPress={() => decline.mutate(b.id)}
                    style={{ flex: 1 }}
                  />
                </View>
              </Card>
            ))}
          </Section>
        )}

        {inflight.length > 0 && (
          <Section title="In progress">
            {inflight.map((b) => (
              <Card
                key={b.id}
                onPress={() => router.push(`/job/${b.id}`)}
                accessibilityLabel={`${b.service?.name || b.title || "Job"} for ${b.customer?.name || "customer"}, in progress. Opens job details.`}
              >
                <JobHead b={b} chevron />
              </Card>
            ))}
          </Section>
        )}

        {upcoming.length > 0 && (
          <Section title="Up next">
            {upcoming.map((b) => (
              <Card
                key={b.id}
                onPress={() => router.push(`/job/${b.id}`)}
                accessibilityLabel={`${b.service?.name || b.title || "Job"} for ${b.customer?.name || "customer"}, up next. Opens job details.`}
              >
                <JobHead b={b} chevron />
              </Card>
            ))}
          </Section>
        )}

        {offered.length === 0 && active.length === 0 && (
          <Empty
            icon={<Clock color={C.muted} size={44} />}
            text="No active jobs"
            sub="New offers will appear here automatically."
          />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, accent, children }: { title: string; accent?: boolean; children: React.ReactNode }) {
  return (
    <View style={{ gap: 10 }}>
      <Text style={[s.section, accent && { color: C.brand }]}>{title}</Text>
      {children}
    </View>
  );
}

function JobHead({ b, chevron }: { b: Booking; chevron?: boolean }) {
  const { noun: customerNoun } = useCustomerNoun();
  return (
    <>
      <View style={s.jobTop}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={s.svc}>{b.service?.name || b.title || "Service"}</Text>
          <Text style={s.cust}>{b.customer?.name || customerNoun}</Text>
        </View>
        <View style={{ alignItems: "flex-end", gap: 6 }}>
          <StatusBadge status={b.status} />
          {chevron && <CaretRight color={C.muted} size={18} />}
        </View>
      </View>
      <View style={s.metaRow}>
        <MapPin color={C.sub} size={15} />
        <Text style={s.meta} numberOfLines={1}>{b.address}</Text>
      </View>
      <View style={s.metaRow}>
        <Clock color={C.sub} size={15} />
        <Text style={s.meta}>{fmtDate(b.scheduledAt)}</Text>
        <Text style={s.price}>{money(b.price)}</Text>
      </View>
    </>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  header: {
    paddingHorizontal: 20,
    paddingTop: 6,
    paddingBottom: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  hi: { color: C.text, fontSize: 24, fontWeight: "800" },
  date: { color: C.sub, fontSize: 13, marginTop: 2 },
  countPill: {
    backgroundColor: C.bg3,
    borderRadius: R.card,
    paddingHorizontal: 16,
    paddingVertical: 8,
    alignItems: "center",
    borderWidth: 1,
    borderColor: C.border,
  },
  countNum: { color: C.brand, fontSize: 20, fontWeight: "800" },
  countLbl: { color: C.muted, fontSize: 11, fontWeight: "600" },
  statsStrip: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 1,
    borderColor: C.border,
    paddingVertical: 10,
    paddingHorizontal: 16,
    gap: 0,
  },
  statItem: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5 },
  statVal: { color: C.green, fontSize: 14, fontWeight: "800" },
  statLbl: { color: C.muted, fontSize: 11 },
  statDivider: { width: 1, height: 24, backgroundColor: C.border },
  elsewhere: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: R.card,
    borderWidth: 1,
    borderColor: C.red,
    backgroundColor: "rgba(239,68,68,0.10)",
  },
  elsewhereIcon: {
    width: 34,
    height: 34,
    borderRadius: R.control,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(239,68,68,0.16)",
  },
  elsewhereTitle: { color: C.text, fontSize: 14, fontWeight: "800" },
  elsewhereSub: { color: C.red, fontSize: 12, fontWeight: "600", marginTop: 2 },
  scroll: { padding: 16, gap: 22, paddingBottom: 40 },
  section: { color: C.sub, fontSize: 13, fontWeight: "800", textTransform: "uppercase", letterSpacing: 1 },
  jobTop: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  svc: { color: C.text, fontSize: 16, fontWeight: "700" },
  cust: { color: C.sub, fontSize: 13 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 10 },
  meta: { color: C.sub, fontSize: 13, flex: 1 },
  price: { color: C.green, fontSize: 14, fontWeight: "800" },
  actions: { flexDirection: "row", gap: 10, marginTop: 16 },
});
