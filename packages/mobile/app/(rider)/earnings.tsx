import { useCallback, useMemo } from "react";
import { View, Text, StyleSheet, FlatList, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { TrendUp, CheckCircle, Receipt, Star } from "phosphor-react-native";
import Constants from "expo-constants";
import { authHeaders } from "../../lib/auth";
import { getActiveCompany } from "../../lib/active-company";
import { C, R, S, money, fmtDate } from "../../lib/theme";
import { Card, Empty, StatusBadge, ListSkeleton } from "../../components/ui";
import { useJobNoun } from "../../lib/use-brand";

const API =
  (Constants.expoConfig?.extra?.apiUrl as string) ?? process.env.EXPO_PUBLIC_API_URL;

/**
 * Earnings is the one screen in the driver app that is deliberately
 * CROSS-COMPANY.
 *
 * A contract tech can be on several rosters. Every other screen is scoped to
 * the company they're on shift for (the `X-Company-Id` header), and that was
 * true here too — so this screen showed only the current company's completed
 * jobs while naming no company at all. The result was genuinely confusing: a
 * job done for BMD Materials looked like it belonged to whatever company the
 * Profile screen said you were working for.
 *
 * The driver's own work history is theirs no matter who dispatched it, so this
 * now reads `GET /api/me/earnings` (company-agnostic, caller's own memberships
 * only) and ATTRIBUTES every row: each job and payout carries a company chip,
 * and rating is shown per company because each employer rates separately.
 */
type EarnJob = {
  id: string;
  companyId: string;
  company: string;
  title: string;
  service: string;
  customerName: string;
  scheduledAt: number | null;
  finishedAt: number | null;
  /** Pre-tax value of the job to the company — NOT what the tech takes home. */
  price: number;
  /** Real pay: on-site hours x hourly rate + per-unit pay. */
  pay: number;
  onSiteMinutes: number;
  payRatePerHour: number;
  hourlyPay: number;
  unitPay: number;
  /** $0 because the office has not set an hourly rate and there was no unit pay. */
  unrated: boolean;
};
type EarnPayout = {
  id: string;
  companyId: string;
  company: string;
  periodStart: number | null;
  periodEnd: number | null;
  jobsCount: number;
  gross: number;
  net: number;
  hourlyPay: number;
  unitPay: number;
  onSiteMinutes: number;
  status: string;
};
type EarnCompany = {
  companyId: string;
  company: string;
  rating: number | null;
  jobsCount: number;
  gross: number;
  pay: number;
  hourlyPay: number;
  unitPay: number;
  onSiteMinutes: number;
};
type Earnings = {
  companies: EarnCompany[];
  jobs: EarnJob[];
  payouts: EarnPayout[];
  totals: {
    gross: number; weekGross: number; weekJobs: number; jobsCount: number; paidNet: number;
    pay: number; weekPay: number; hourlyPay: number; unitPay: number; onSiteMinutes: number;
  };
  truncated: boolean;
};

/**
 * Stable per-company accent so the same employer reads the same colour every
 * time, without hardcoding a palette per tenant. Hash the company id rather
 * than using list order — otherwise a company's colour would change the moment
 * the driver joins another roster.
 */
/** Minutes -> "1h 45m" / "45m" / "—", for pay lines. */
function fmtHours(mins: number): string {
  const n = Math.max(0, Math.round(Number(mins) || 0));
  if (n === 0) return "0m";
  const h = Math.floor(n / 60);
  return h > 0 ? `${h}h ${n % 60}m` : `${n}m`;
}

const CHIP_COLORS = [C.brand, "#a78bfa", C.amber, "#34d399", "#f472b6", C.cyan];
function chipColor(companyId: string): string {
  let h = 0;
  for (let i = 0; i < companyId.length; i++) h = (h * 31 + companyId.charCodeAt(i)) >>> 0;
  return CHIP_COLORS[h % CHIP_COLORS.length]!;
}

function CompanyChip({ companyId, name }: { companyId: string; name: string }) {
  const col = chipColor(companyId);
  return (
    <View style={[s.chip, { borderColor: col, backgroundColor: `${col}1F` }]}>
      <Text style={[s.chipTxt, { color: col }]} numberOfLines={1}>
        {name}
      </Text>
    </View>
  );
}

export default function Earnings() {
  const { nounPlural: jobNounPlural } = useJobNoun();
  const activeCompany = getActiveCompany();

  const earnings = useQuery<Earnings>({
    queryKey: ["earnings-all"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/me/earnings`, { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed");
      return (await res.json()) as Earnings;
    },
  });

  const onRefresh = useCallback(() => {
    earnings.refetch();
  }, [earnings]);

  const d = earnings.data;
  // Memoized so the `activeName` lookup below doesn't re-run on every render
  // (a fresh `[]` literal would invalidate it constantly).
  const rosters = useMemo(() => d?.companies ?? [], [d?.companies]);
  const multi = rosters.length > 1;

  // The company the app is CURRENTLY acting as, resolved through the same
  // list the server returned. Shown in the subtitle so a mismatch between
  // "who am I working for" and what's on screen is visible, not silent.
  const activeName = useMemo(() => {
    if (!activeCompany) return rosters.length === 1 ? rosters[0]!.company : "";
    return rosters.find((r) => r.companyId === activeCompany)?.company ?? "";
  }, [activeCompany, rosters]);

  const ListHeader = (
    <View style={{ gap: 22, marginBottom: 10 }}>
      <View style={s.heroCard}>
        <Text style={s.heroLbl}>This week{multi ? " · all companies" : ""}</Text>
        <Text style={s.heroAmt}>{money(d?.totals.weekPay ?? 0)}</Text>
        <View style={s.heroRow}>
          <TrendUp color={C.green} size={16} />
          <Text style={s.heroSub}>
            {d?.totals.weekJobs ?? 0} {jobNounPlural.toLowerCase()} completed
          </Text>
        </View>
      </View>

      <View style={s.statGrid}>
        <Stat label={multi ? "Total earned (all)" : "Total earned"} value={money(d?.totals.pay ?? 0)} />
        <Stat label={`${jobNounPlural} done`} value={String(d?.totals.jobsCount ?? 0)} />
        <Stat label="Paid out" value={money(d?.totals.paidNet ?? 0)} />
        <Stat label="Companies" value={String(rosters.length || 1)} />
      </View>

      {/* How the total was earned. Pay is on-site time x hourly rate plus any
          per-unit work, so the split is shown instead of one opaque number —
          "why is my cheque this?" should be answerable on this screen. */}
      <View style={s.splitCard}>
        <Text style={s.section}>How your pay is calculated</Text>
        <View style={s.splitRow}>
          <Text style={s.splitLbl}>On-site time{"\n"}<Text style={s.splitHint}>{fmtHours(d?.totals.onSiteMinutes ?? 0)} worked</Text></Text>
          <Text style={s.splitVal}>{money(d?.totals.hourlyPay ?? 0)}</Text>
        </View>
        <View style={s.splitRow}>
          <Text style={s.splitLbl}>Per-unit work</Text>
          <Text style={s.splitVal}>{money(d?.totals.unitPay ?? 0)}</Text>
        </View>
        <View style={[s.splitRow, s.splitTotal]}>
          <Text style={s.splitTotalLbl}>Total earned</Text>
          <Text style={s.splitTotalVal}>{money(d?.totals.pay ?? 0)}</Text>
        </View>
      </View>

      {/* Per-company breakdown. Ratings are set by each employer separately,
          so they are never blended into one star. */}
      {rosters.length > 0 && (
        <View style={{ gap: 10 }}>
          <Text style={s.section}>By company</Text>
          {rosters.map((r) => (
            <Card
              key={r.companyId}
              accessibilityLabel={`${r.company}: ${r.jobsCount} jobs, ${money(r.pay)} earned${
                r.rating != null ? `, rated ${r.rating.toFixed(1)}` : ""
              }${r.companyId === activeCompany ? ", current shift" : ""}`}
            >
              <View style={s.coRow}>
                <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
                  <CompanyChip companyId={r.companyId} name={r.company} />
                  <Text style={s.coMeta}>
                    {r.jobsCount} {jobNounPlural.toLowerCase()}
                    {r.companyId === activeCompany ? " · current shift" : ""}
                  </Text>
                </View>
                <View style={{ alignItems: "flex-end", gap: 4 }}>
                  <Text style={s.coAmt}>{money(r.gross)}</Text>
                  {r.rating != null && (
                    <View style={s.ratingRow}>
                      <Star color={C.amber} size={12} weight="fill" />
                      <Text style={s.ratingTxt}>{r.rating.toFixed(1)}</Text>
                    </View>
                  )}
                </View>
              </View>
            </Card>
          ))}
        </View>
      )}

      {(d?.payouts.length ?? 0) > 0 && (
        <View style={{ gap: 10 }}>
          <Text style={s.section}>Payouts</Text>
          {d!.payouts.map((p) => (
            <Card
              key={p.id}
              accessibilityLabel={`Payout from ${p.company} for ${fmtDate(p.periodStart ?? 0).split(",")[0]} to ${fmtDate(p.periodEnd ?? 0).split(",")[0]}, ${money(p.net)} net, ${p.status}`}
            >
              <View style={s.payRow}>
                <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
                  <CompanyChip companyId={p.companyId} name={p.company} />
                  <Text style={s.payPeriod}>
                    {fmtDate(p.periodStart ?? 0).split(",")[0]} – {fmtDate(p.periodEnd ?? 0).split(",")[0]}
                  </Text>
                  <Text style={s.paySub}>
                    {p.jobsCount} jobs · {money(p.gross)} gross
                  </Text>
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

      <Text style={s.section}>Completed {jobNounPlural.toLowerCase()}</Text>
      {d?.truncated && (
        <Text style={s.truncNote}>Showing your most recent 500 completed jobs.</Text>
      )}
    </View>
  );

  return (
    <SafeAreaView style={s.safe} edges={["top", "left", "right"]}>
      <View style={s.header}>
        <Text style={s.title}>Earnings</Text>
        <Text style={s.subtitle}>
          {multi
            ? `All companies you work for${activeName ? ` · on shift at ${activeName}` : ""}`
            : activeName || "Your completed work"}
        </Text>
      </View>
      {earnings.isLoading ? (
        <View style={{ padding: S.md, gap: S.sm }}>
          <ListSkeleton rows={4} />
        </View>
      ) : (
        <FlatList
          contentContainerStyle={s.scroll}
          data={d?.jobs ?? []}
          keyExtractor={(b) => b.id}
          ListHeaderComponent={ListHeader}
          ListEmptyComponent={
            <Empty
              icon={<Receipt color={C.muted} size={40} />}
              text={earnings.isError ? "Couldn't load earnings" : "No completed jobs yet"}
              sub={earnings.isError ? "Pull down to try again." : undefined}
            />
          }
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          refreshControl={
            <RefreshControl refreshing={earnings.isRefetching} onRefresh={onRefresh} tintColor={C.brand} />
          }
          showsVerticalScrollIndicator={false}
          // Virtualization tuning: a long-tenured driver across several rosters
          // can have hundreds of completed jobs — keep only the on-screen
          // window plus a modest buffer mounted.
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
          removeClippedSubviews
          renderItem={({ item: b }) => (
            <Card
              accessibilityLabel={`${b.service || b.title || "Job"} for ${b.customerName || "customer"} at ${b.company}, completed ${fmtDate(b.finishedAt ?? b.scheduledAt ?? 0)}, earned ${money(b.pay)}`}
            >
              <View style={s.jobRow}>
                <CheckCircle color={C.green} size={22} weight="fill" />
                <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
                  {/* The label Dan asked for: which company this job was for.
                      Always rendered, even for a single-roster driver — a job
                      record with no employer on it is ambiguous by itself. */}
                  <CompanyChip companyId={b.companyId} name={b.company} />
                  <Text style={s.jobName} numberOfLines={1}>
                    {b.service || b.title}
                  </Text>
                  <Text style={s.jobMeta} numberOfLines={1}>
                    {b.customerName} · {fmtDate(b.finishedAt ?? b.scheduledAt ?? 0)}
                  </Text>
                  {/* Pay breakdown per job, so the number is never a mystery. */}
                  <Text style={s.jobPay} numberOfLines={1}>
                    {b.hourlyPay > 0
                      ? `${fmtHours(b.onSiteMinutes)} on site${b.payRatePerHour ? ` @ ${money(b.payRatePerHour)}/h` : ""} = ${money(b.hourlyPay)}`
                      : b.unrated
                        ? "No pay rate set — ask the office"
                        : `${fmtHours(b.onSiteMinutes)} on site`}
                    {b.unitPay > 0 ? ` · per-unit ${money(b.unitPay)}` : ""}
                  </Text>
                </View>
                <Text style={s.jobAmt}>{money(b.pay)}</Text>
              </View>
            </Card>
          )}
        />
      )}
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
  subtitle: { color: C.sub, fontSize: 12.5, fontWeight: "600", marginTop: 2 },
  scroll: { padding: 16, paddingBottom: 40 },
  heroCard: {
    backgroundColor: C.brandDeep,
    borderRadius: R.sheet,
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
    borderRadius: R.card,
    borderWidth: 1,
    borderColor: C.border,
    padding: 16,
    gap: 4,
  },
  statVal: { color: C.text, fontSize: 22, fontWeight: "800" },
  statLbl: { color: C.muted, fontSize: 12, fontWeight: "600" },
  section: { color: C.sub, fontSize: 13, fontWeight: "800", textTransform: "uppercase", letterSpacing: 1 },
  truncNote: { color: C.muted, fontSize: 11.5, marginTop: -4 },
  chip: {
    alignSelf: "flex-start",
    maxWidth: "100%",
    borderWidth: 1,
    borderRadius: R.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  chipTxt: { fontSize: 10.5, fontWeight: "800", letterSpacing: 0.3 },
  coRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  coMeta: { color: C.sub, fontSize: 12 },
  coAmt: { color: C.text, fontSize: 16, fontWeight: "800" },
  ratingRow: { flexDirection: "row", alignItems: "center", gap: 3 },
  ratingTxt: { color: C.amber, fontSize: 12, fontWeight: "700" },
  payRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  payPeriod: { color: C.text, fontSize: 15, fontWeight: "700" },
  paySub: { color: C.sub, fontSize: 12 },
  payNet: { color: C.green, fontSize: 17, fontWeight: "800" },
  jobRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  jobName: { color: C.text, fontSize: 15, fontWeight: "700" },
  jobMeta: { color: C.sub, fontSize: 12 },
  jobAmt: { color: C.green, fontSize: 15, fontWeight: "800" },
  jobPay: { color: C.sub, fontSize: 11.5, fontWeight: "600" },
  splitCard: {
    backgroundColor: C.card,
    borderRadius: R.card,
    borderWidth: 1,
    borderColor: C.border,
    padding: 16,
    gap: 10,
  },
  splitRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  splitLbl: { color: C.text, fontSize: 13, fontWeight: "700", flex: 1 },
  splitHint: { color: C.sub, fontSize: 11.5, fontWeight: "600" },
  splitVal: { color: C.text, fontSize: 14, fontWeight: "800" },
  splitTotal: { borderTopWidth: 1, borderTopColor: C.border, paddingTop: 10 },
  splitTotalLbl: { color: C.sub, fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.8 },
  splitTotalVal: { color: C.green, fontSize: 17, fontWeight: "900" },
});
