import { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import Constants from "expo-constants";
import { Buildings, CheckCircle, ArrowClockwise } from "phosphor-react-native";
import { useQueryClient } from "@tanstack/react-query";
import { getToken, authHeaders } from "../lib/auth";
import {
  setActiveCompany,
  getActiveCompany,
  type CompanyOption,
} from "../lib/active-company";
import { hasSeenOnboarding } from "../lib/onboarding";
import { C } from "../lib/theme";
import { Button } from "../components/ui";

const API = ((Constants.expoConfig?.extra?.apiUrl as string) ?? "").replace(/\/$/, "");

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
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);

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

      // Zero companies means the person has no active membership anywhere —
      // usually an invite they haven't accepted yet. Say so plainly instead of
      // dropping them into an empty job list that looks like a bug.
      if (list.length === 0) {
        setCompanies([]);
        return;
      }
      if (list.length === 1) {
        await proceed(list[0]!.id);
        return;
      }
      setCompanies(list);
    } catch (e: any) {
      setError(e?.message || "Something went wrong");
    }
  }, [proceed, router]);

  useEffect(() => {
    load();
  }, [load]);

  const current = getActiveCompany();

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
          <Text style={s.title}>No active company</Text>
          <Text style={s.sub}>
            You're not on any company's roster yet. If you were invited, open the invite email
            and accept it first — then pull down to refresh here.
          </Text>
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
            You're on {companies.length} rosters. Pick the company for this shift — you'll only
            see their jobs, and you can switch any time from your profile.
          </Text>
        </View>

        <View style={{ gap: 10 }}>
          {companies.map((co) => {
            const isCurrent = co.id === current;
            return (
              <Pressable
                key={co.id}
                onPress={() => proceed(co.id)}
                accessibilityRole="button"
                accessibilityLabel={`Work for ${co.name} today`}
                style={({ pressed }) => [s.card, pressed && s.cardPressed]}
              >
                <View style={s.avatar}>
                  <Text style={s.avatarTxt}>{co.name?.[0]?.toUpperCase() ?? "?"}</Text>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.cardName} numberOfLines={1}>
                    {co.name}
                  </Text>
                  <Text style={s.cardRole}>
                    {co.staffType === "driver" ? "Driver" : "Technician"}
                    {isCurrent ? " · last used" : ""}
                  </Text>
                </View>
                {isCurrent && <CheckCircle color={C.brand} size={22} weight="fill" />}
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
});
