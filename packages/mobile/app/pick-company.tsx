import { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  ScrollView,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import Constants from "expo-constants";
import { Buildings, CheckCircle, ArrowClockwise, EnvelopeSimple } from "phosphor-react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getToken, authHeaders } from "../lib/auth";
import {
  setActiveCompany,
  getActiveCompany,
  type CompanyOption,
} from "../lib/active-company";
import { hasSeenOnboarding } from "../lib/onboarding";
import {
  fetchNotifySummary,
  NOTIFY_SUMMARY_KEY,
  companyCount,
  type NotifySummary,
} from "../lib/notify-summary";
import { C } from "../lib/theme";
import { Button } from "../components/ui";
import { CompanyBadge, CompanyAlertLine, companyAlertText } from "../components/company-alert";

const API = ((Constants.expoConfig?.extra?.apiUrl as string) ?? "").replace(/\/$/, "");

type PendingInvite = {
  membershipId: string;
  companyId: string;
  company: string;
  role: string;
  staffType?: string | null;
};

/**
 * "Which company are you working for today?"
 *
 * Shown after the security gate (biometric unlock) on every sign-in, per
 * product decision — a contract tech who works for two contractors should
 * consciously pick each day rather than inherit yesterday's choice and
 * accidentally clock into the wrong company's jobs.
 *
 * A driver who belongs to exactly ONE company never sees this screen: we
 * auto-select and forward. That keeps the flow identical for every
 * single-company driver, which is the vast majority of them.
 *
 * This screen deliberately does its own `fetch` rather than going through the
 * typed `api` client, because it must run BEFORE a company is chosen — it is
 * the one endpoint that is company-agnostic.
 */
export default function PickCompany() {
  const router = useRouter();
  const qc = useQueryClient();
  const [companies, setCompanies] = useState<CompanyOption[] | null>(null);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  // Which of these companies is actually waiting on this tech? This is the
  // whole reason the picker is more than a list of names: a tech opening the
  // app needs to see that Bolt has sent a work order, not pick a company and
  // hope. Company-agnostic, so it is safe to call before a company is chosen.
  const notify = useQuery<NotifySummary>({
    queryKey: NOTIFY_SUMMARY_KEY,
    queryFn: fetchNotifySummary,
    refetchInterval: 15_000,
  });

  const proceed = useCallback(
    async (companyId: string) => {
      setChoosing(companyId);
      await setActiveCompany(companyId);
      // Any data already cached was fetched under the PREVIOUS company. Not
      // clearing it is what leaves company A's jobs on screen under company B
      // until each query happens to refetch.
      qc.clear();
      const seen = await hasSeenOnboarding();
      router.replace(seen ? "/(rider)" : "/onboarding");
    },
    [qc, router],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      if (!getToken()) {
        router.replace("/sign-in");
        return;
      }
      const res = await fetch(`${API}/api/me/companies`, { headers: authHeaders() });
      if (res.status === 401) {
        router.replace("/sign-in");
        return;
      }
      if (!res.ok) throw new Error(`Couldn't load your companies (${res.status})`);
      const json = (await res.json()) as { companies?: CompanyOption[] };
      const list = json.companies ?? [];

      // Pending invites are fetched too, so a tech can accept a new company's
      // invite right here instead of hunting for the email. Failure to load
      // invites must NOT block the picker — the roster is the critical part.
      let pending: PendingInvite[] = [];
      try {
        const ir = await fetch(`${API}/api/me/invites`, { headers: authHeaders() });
        if (ir.ok) pending = ((await ir.json()) as { invites?: PendingInvite[] }).invites ?? [];
      } catch {
        /* non-critical */
      }
      setInvites(pending);

      // Zero companies means the person has no active membership anywhere —
      // usually an invite they haven't accepted yet. Say so plainly instead of
      // dropping them into an empty job list that looks like a bug.
      if (list.length === 0) {
        setCompanies([]);
        return;
      }
      // Auto-skip only when there is genuinely nothing to choose. A single
      // active company PLUS a pending invite is a real choice, so the screen
      // must stay up — silently forwarding would hide the invite completely,
      // which is the whole problem this screen is fixing.
      if (list.length === 1 && pending.length === 0) {
        await proceed(list[0]!.id);
        return;
      }
      setCompanies(list);
    } catch (e: any) {
      setError(e?.message || "Something went wrong");
    }
  }, [proceed, router]);

  /**
   * Accept an invite in-app. On success we reload rather than optimistically
   * moving the invite into the roster — the server is the authority on what
   * the person may act as, and a half-applied local state here would let them
   * pick a company the backend hasn't actually activated yet.
   */
  const accept = useCallback(
    async (inv: PendingInvite) => {
      setActing(inv.membershipId);
      try {
        const res = await fetch(`${API}/api/me/join-company/${inv.membershipId}`, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
        });
        if (!res.ok) {
          const msg =
            ((await res.json().catch(() => ({}))) as { message?: string })?.message ??
            `Couldn't accept (${res.status})`;
          Alert.alert("Couldn't join", msg);
          return;
        }
        await load();
        Alert.alert("You're on the roster", `You can now take jobs for ${inv.company}.`);
      } catch {
        Alert.alert("Couldn't join", "Check your connection and try again.");
      } finally {
        setActing(null);
      }
    },
    [load],
  );

  const decline = useCallback(
    (inv: PendingInvite) => {
      Alert.alert(
        `Decline ${inv.company}?`,
        "They'll have to invite you again if you change your mind.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Decline",
            style: "destructive",
            onPress: async () => {
              setActing(inv.membershipId);
              try {
                const res = await fetch(
                  `${API}/api/me/join-company/${inv.membershipId}/decline`,
                  { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }) },
                );
                if (!res.ok) throw new Error();
                await load();
              } catch {
                Alert.alert("Couldn't decline", "Check your connection and try again.");
              } finally {
                setActing(null);
              }
            },
          },
        ],
      );
    },
    [load],
  );

  useEffect(() => {
    load();
  }, [load]);

  const current = getActiveCompany();

  /** Invite cards — shared by the empty state and the normal picker. */
  function InviteList() {
    if (invites.length === 0) return null;
    return (
      <View style={{ gap: 10, width: "100%" }}>
        <Text style={s.sectionLabel}>
          {invites.length === 1 ? "Invitation" : "Invitations"}
        </Text>
        {invites.map((inv) => {
          const busy = acting === inv.membershipId;
          return (
            <View key={inv.membershipId} style={[s.card, s.inviteCard]}>
              <View style={s.inviteRow}>
                <View style={[s.avatar, { backgroundColor: "#0b2a3a" }]}>
                  <EnvelopeSimple color={C.brand} size={20} weight="fill" />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.cardName} numberOfLines={1}>
                    {inv.company}
                  </Text>
                  <Text style={s.cardRole}>
                    Invited you as {inv.staffType === "driver" ? "a driver" : "a technician"}
                  </Text>
                </View>
              </View>
              {busy ? (
                <ActivityIndicator color={C.brand} style={{ marginTop: 12 }} />
              ) : (
                <View style={s.inviteActions}>
                  <Pressable
                    onPress={() => decline(inv)}
                    accessibilityRole="button"
                    accessibilityLabel={`Decline invitation from ${inv.company}`}
                    style={({ pressed }) => [s.declineBtn, pressed && { opacity: 0.6 }]}
                  >
                    <Text style={s.declineTxt}>Decline</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => accept(inv)}
                    accessibilityRole="button"
                    accessibilityLabel={`Accept invitation from ${inv.company}`}
                    style={({ pressed }) => [s.acceptBtn, pressed && { opacity: 0.8 }]}
                  >
                    <Text style={s.acceptTxt}>Accept</Text>
                  </Pressable>
                </View>
              )}
            </View>
          );
        })}
      </View>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={s.safe}>
        <View style={s.center}>
          <Text style={s.title}>Can't load your companies</Text>
          <Text style={s.sub}>{error}</Text>
          <Button title="Try again" onPress={load} style={{ marginTop: 12, minWidth: 160 }} />
        </View>
      </SafeAreaView>
    );
  }

  if (companies === null || choosing) {
    return (
      <SafeAreaView style={s.safe}>
        <View style={s.center}>
          <ActivityIndicator color={C.brand} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  if (companies.length === 0) {
    return (
      <SafeAreaView style={s.safe}>
        <View style={s.center}>
          <View style={s.iconWrap}>
            <Buildings color={C.brand} size={36} weight="fill" />
          </View>
          <Text style={s.title}>
            {invites.length > 0 ? "You've been invited" : "No active company"}
          </Text>
          <Text style={[s.sub, { textAlign: "center" }]}>
            {invites.length > 0
              ? "Accept below to start taking jobs. No email needed."
              : "You're not on any company's roster yet. Ask your dispatcher to invite you, then refresh."}
          </Text>
          <View style={{ height: 8 }} />
          <InviteList />
          <Pressable onPress={load} style={s.refreshBtn} accessibilityRole="button">
            <ArrowClockwise color={C.brand} size={16} weight="bold" />
            <Text style={s.refreshTxt}>Refresh</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.safe} edges={["top", "left", "right", "bottom"]}>
      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        <View style={s.head}>
          <View style={s.iconWrap}>
            <Buildings color={C.brand} size={34} weight="fill" />
          </View>
          <Text style={s.title}>Who are you working for today?</Text>
          <Text style={s.sub}>
            {companies.length === 1
              ? "Pick your company for this shift — you'll only see their jobs, and you can switch any time from your profile."
              : `You're on ${companies.length} rosters. Pick the company for this shift — you'll only see their jobs, and you can switch any time from your profile.`}
          </Text>
        </View>

        <InviteList />

        <View style={{ gap: 10 }}>
          {invites.length > 0 && <Text style={s.sectionLabel}>Your companies</Text>}
          {companies.map((co) => {
            const isCurrent = co.id === current;
            const n = companyCount(notify.data, co.id);
            const waiting = (n?.total ?? 0) > 0;
            const alert = companyAlertText(n);
            return (
              <Pressable
                key={co.id}
                onPress={() => proceed(co.id)}
                accessibilityRole="button"
                accessibilityLabel={
                  alert
                    ? `Work for ${co.name} today. ${alert} waiting.`
                    : `Work for ${co.name} today`
                }
                style={({ pressed }) => [
                  s.card,
                  // A red border, not just a bubble: the row itself has to read
                  // as "this one needs you" at a glance across a list.
                  waiting && s.cardWaiting,
                  pressed && s.cardPressed,
                ]}
              >
                <View style={[s.avatar, waiting && s.avatarWaiting]}>
                  <Text style={[s.avatarTxt, waiting && { color: C.red }]}>
                    {co.name?.[0]?.toUpperCase() ?? "?"}
                  </Text>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.cardName} numberOfLines={1}>
                    {co.name}
                  </Text>
                  {waiting ? (
                    <CompanyAlertLine n={n} />
                  ) : (
                    <Text style={s.cardRole}>
                      {co.staffType === "driver" ? "Driver" : "Technician"}
                      {isCurrent ? " · last used" : ""}
                    </Text>
                  )}
                </View>
                {waiting ? (
                  <CompanyBadge count={n!.total} />
                ) : isCurrent ? (
                  <CheckCircle color={C.brand} size={22} weight="fill" />
                ) : null}
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  scroll: { padding: 20, paddingTop: 28, gap: 22 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 },
  head: { gap: 8 },
  iconWrap: {
    width: 68,
    height: 68,
    borderRadius: 20,
    backgroundColor: C.bg3,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  title: { color: C.text, fontSize: 21, fontWeight: "800" },
  sub: { color: C.sub, fontSize: 13, lineHeight: 19 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: C.bg2,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    padding: 16,
  },
  cardPressed: { opacity: 0.7, borderColor: C.brand },
  cardWaiting: { borderColor: C.red, backgroundColor: "rgba(239,68,68,0.07)" },
  avatarWaiting: { backgroundColor: "rgba(239,68,68,0.16)" },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: C.bg3,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarTxt: { color: C.brand, fontSize: 18, fontWeight: "800" },
  cardName: { color: C.text, fontSize: 16, fontWeight: "700" },
  cardRole: { color: C.sub, fontSize: 12, marginTop: 2 },
  refreshBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 14,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
  },
  refreshTxt: { color: C.brand, fontSize: 13, fontWeight: "700" },
  sectionLabel: {
    color: C.muted,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  inviteCard: { flexDirection: "column", alignItems: "stretch", gap: 0 },
  inviteRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  inviteActions: { flexDirection: "row", gap: 10, marginTop: 14 },
  declineBtn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: "center",
  },
  declineTxt: { color: C.sub, fontSize: 14, fontWeight: "700" },
  acceptBtn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 12,
    backgroundColor: C.brand,
    alignItems: "center",
  },
  acceptTxt: { color: "#062534", fontSize: 14, fontWeight: "800" },
});
