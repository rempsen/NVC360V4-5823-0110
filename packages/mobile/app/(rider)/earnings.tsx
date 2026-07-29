import { useCallback } from "react";
import { View, Text, StyleSheet, FlatList, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { TrendUp, CheckCircle, Receipt } from "phosphor-react-native";
import { api } from "../../lib/api";
import { C, money, fmtDate } from "../../lib/theme";
import { Card, FullLoader, Empty, StatusBadge } from "../../components/ui";
import { useJobNoun } from "../../lib/use-brand";

export default function Earnings() {
  const { nounPlural: jobNounPlural } = useJobNoun();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const res = await api.riders.me.$get();
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).rider as any;
    },
  });

  const bookings = useQuery({
    queryKey: ["bookings"],
    queryFn: async () => {
      const res = await api.bookings.$get();
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).bookings as any[];
    },
  });

  const payouts = useQuery({
    queryKey: ["payouts"],
    queryFn: async () => {
      const res = await api.payouts.$get();
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).payouts as any[];
    },
  });

  const onRefresh = useCallback(() => {
    bookings.refetch();
    payouts.refetch();
    me.refetch();
  }, [
	payouts,
	me,
	bookings
]);

  if (bookings.isLoading || me.isLoading) return <FullLoader label="Loading earnings…" />;

  const myId = me.data?.id;
  // NOTE: GET /api/bookings returns every booking this rider has ever had, with
  // no limit/date filter — for a long-tenured driver this can be a large list.
  // Rendering it via FlatList (below) keeps this screen fast regardless of
  // history size by only mounting the rows actually on screen. The unbounded
  // fetch itself is a separate, shared-endpoint concern (also used by
  // customer/admin views) and intentionally not changed here.
  const completed = (bookings.data ?? []).filter((b) => b.status === "completed");
  const myPayouts = (payouts.data ?? []).filter((p) => p.riderId === myId);

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const weekJobs = completed.filter((b) => new Date(b.scheduledAt) >= weekAgo);
  const gross = completed.reduce((sum, b) => sum + (b.price || 0), 0);
  const weekGross = weekJobs.reduce((sum, b) => sum + (b.price || 0), 0);
  const paidNet = myPayouts.filter((p) => p.status === "paid").reduce((s, p) => s + (p.net || 0), 0);

  const ListHeader = (
    <View style={{ gap: 22, marginBottom: 10 }}>
      <View style={s.heroCard}>
        <Text style={s.heroLbl}>This week</Text>
        <Text style={s.heroAmt}>{money(weekGross)}</Text>
        <View style={s.heroRow}>
          <TrendUp color={C.green} size={16} />
          <Text style={s.heroSub}>{weekJobs.length} {jobNounPlural.toLowerCase()} completed</Text>
        </View>
      </View>

      <View style={s.statGrid}>
        <Stat label="Total earned" value={money(gross)} />
        <Stat label={`${jobNounPlural} done`} value={String(completed.length)} />
        <Stat label="Paid out" value={money(paidNet)} />
        <Stat label="Rating" value={`★ ${(me.data?.rating ?? 5).toFixed(1)}`} />
      </View>

      {myPayouts.length > 0 && (
        <View style={{ gap: 10 }}>
          <Text style={s.section}>Payouts</Text>
          {myPayouts.map((p) => (
            <Card key={p.id} accessibilityLabel={`Payout for ${fmtDate(p.periodStart).split(",")[0]} to ${fmtDate(p.periodEnd).split(",")[0]}, ${money(p.net)} net, ${p.status}`}>
              <View style={s.payRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.payPeriod}>
                    {fmtDate(p.periodStart).split(",")[0]} – {fmtDate(p.periodEnd).split(",")[0]}
                  </Text>
                  <Text style={s.paySub}>{p.jobsCount} jobs · {money(p.gross)} gross</Text>
                </View>
                <View style={{ alignItems: "flex-end", gap: 5 }}>
                  <Text style={s.payNet}>{money(p.net)}</Text>
                  <StatusBadge status={p.status === "paid" ? "completed" : "pending"} />
                </View>
              </View>
            </Card>
          ))}
        </View>
      )}

      <Text style={s.section}>Completed jobs</Text>
    </View>
  );

  return (
    <SafeAreaView style={s.safe} edges={["top", "left", "right"]}>
      <View style={s.header}>
        <Text style={s.title}>Earnings</Text>
      </View>
      <FlatList
        contentContainerStyle={s.scroll}
        data={completed}
        keyExtractor={(b) => b.id}
        ListHeaderComponent={ListHeader}
        ListEmptyComponent={
          <Empty icon={<Receipt color={C.muted} size={40} />} text="No completed jobs yet" />
        }
        ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        refreshControl={
          <RefreshControl refreshing={bookings.isRefetching} onRefresh={onRefresh} tintColor={C.brand} />
        }
        showsVerticalScrollIndicator={false}
        // Virtualization tuning: these screens can grow to hundreds/thousands
        // of completed jobs over a driver's tenure — keep only a modest
        // on-screen + buffer window mounted at once instead of everything.
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={7}
        removeClippedSubviews
        renderItem={({ item: b }) => (
          <Card accessibilityLabel={`${b.service?.name || b.title || "Job"} for ${b.customer?.name || "customer"}, completed ${fmtDate(b.scheduledAt)}, ${money(b.price)}`}>
            <View style={s.jobRow}>
              <CheckCircle color={C.green} size={22} weight="fill" />
              <View style={{ flex: 1 }}>
                <Text style={s.jobName}>{b.service?.name || b.title}</Text>
                <Text style={s.jobMeta}>{b.customer?.name} · {fmtDate(b.scheduledAt)}</Text>
              </View>
              <Text style={s.jobAmt}>{money(b.price)}</Text>
            </View>
          </Card>
        )}
      />
    </SafeAreaView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.stat}>
      <Text style={s.statVal}>{value}</Text>
      <Text style={s.statLbl}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  header: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 8 },
  title: { color: C.text, fontSize: 24, fontWeight: "800" },
  scroll: { padding: 16, paddingBottom: 40 },
  heroCard: {
    backgroundColor: C.brandDeep,
    borderRadius: 22,
    padding: 22,
    gap: 6,
  },
  heroLbl: { color: "rgba(255,255,255,0.7)", fontSize: 13, fontWeight: "600" },
  heroAmt: { color: "#fff", fontSize: 38, fontWeight: "900" },
  heroRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  heroSub: { color: "rgba(255,255,255,0.85)", fontSize: 13, fontWeight: "600" },
  statGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  stat: {
    flexBasis: "47.5%",
    flexGrow: 1,
    backgroundColor: C.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    padding: 16,
    gap: 4,
  },
  statVal: { color: C.text, fontSize: 22, fontWeight: "800" },
  statLbl: { color: C.muted, fontSize: 12, fontWeight: "600" },
  section: { color: C.sub, fontSize: 13, fontWeight: "800", textTransform: "uppercase", letterSpacing: 1 },
  payRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  payPeriod: { color: C.text, fontSize: 15, fontWeight: "700" },
  paySub: { color: C.sub, fontSize: 12, marginTop: 3 },
  payNet: { color: C.green, fontSize: 17, fontWeight: "800" },
  jobRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  jobName: { color: C.text, fontSize: 15, fontWeight: "700" },
  jobMeta: { color: C.sub, fontSize: 12, marginTop: 3 },
  jobAmt: { color: C.green, fontSize: 15, fontWeight: "800" },
});
