import { Tabs } from "expo-router";
import { useEffect } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import Constants from "expo-constants";
import {
  Briefcase,
  CurrencyDollar,
  UserCircle,
  ChatCircleDots,
} from "phosphor-react-native";
import { C } from "../../lib/theme";
import { api } from "../../lib/api";
import { getToken } from "../../lib/auth";
import { useLocationHeartbeat } from "../../lib/use-location-heartbeat";
import { usePushNotifications, setAppBadgeCount } from "../../lib/push";

const API = ((Constants.expoConfig?.extra?.apiUrl as string) ?? "").replace(/\/$/, "");

export default function RiderLayout() {
  // Rider's own status drives whether native background GPS tracking runs at
  // all — NOT merely "is there a signed-in session" (a session persists
  // across app relaunches, including headless background relaunches iOS
  // performs for apps with UIBackgroundModes:["location"], so gating on
  // session alone is what let the app get woken in the background forever
  // even when the tech was off shift and never opened it). Same query key
  // ("me") as profile.tsx so they share one cache entry.
  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const res = await api.riders.me.$get();
      if (!res.ok) throw new Error("Failed");
      return (await res.json()).rider as { status?: string } | null;
    },
    // keep this reasonably fresh so toggling shift status in Profile turns
    // background tracking off/on again promptly, not just after a full
    // app relaunch.
    refetchInterval: 20_000,
  });
  // Default to NOT tracking until we actually know the rider's status —
  // avoids a window where a cold boot starts tracking before we've confirmed
  // the tech is on shift.
  const onShift = me.data?.status != null && me.data.status !== "offline";

  // keep the technician's live GPS location flowing to dispatch while — and
  // ONLY while — they are on shift (independent of any specific job).
  useLocationHeartbeat(onShift);

  // register this device for push (job offers, enroute alerts) + handle taps.
  usePushNotifications();

  // unread dispatch messages + new job offers → tab badge
  const unread = useQuery({
    queryKey: ["dispatch-unread"],
    queryFn: async () => {
      const res = await fetch(`${API}/api/messages/direct/unread`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) return { count: 0 };
      return res.json() as Promise<{ count: number }>;
    },
    refetchInterval: 8000,
  });
  const badge = (unread.data as any)?.count ?? 0;

  // Mirror the unread count onto the OS app-icon badge while the app is
  // open/foregrounded. A push notification's own `badge` field already sets
  // this when the app is backgrounded/closed and a message arrives — this
  // covers the case where the count changes while polling in the foreground
  // (e.g. reading on another device) and reliably syncs it back down.
  useEffect(() => {
    setAppBadgeCount(badge);
  }, [badge]);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: C.brand,
        tabBarInactiveTintColor: C.muted,
        tabBarStyle: {
          backgroundColor: C.bg2,
          borderTopColor: C.border,
          borderTopWidth: 1,
          height: 84,
          paddingTop: 8,
          paddingBottom: 28,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "700" },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Jobs",
          tabBarIcon: ({ color, focused }) => (
            <Briefcase color={color} size={24} weight={focused ? "fill" : "regular"} />
          ),
        }}
      />
      <Tabs.Screen
        name="messages"
        options={{
          title: "Messages",
          tabBarIcon: ({ color, focused }) => (
            <View>
              <ChatCircleDots color={color} size={24} weight={focused ? "fill" : "regular"} />
              {badge > 0 && (
                <View style={badgeStyles.badge}>
                  <Text style={badgeStyles.badgeTxt}>{badge > 9 ? "9+" : badge}</Text>
                </View>
              )}
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="earnings"
        options={{
          title: "Earnings",
          tabBarIcon: ({ color, focused }) => (
            <CurrencyDollar color={color} size={24} weight={focused ? "fill" : "regular"} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarIcon: ({ color, focused }) => (
            <UserCircle color={color} size={24} weight={focused ? "fill" : "regular"} />
          ),
        }}
      />
    </Tabs>
  );
}

const badgeStyles = StyleSheet.create({
  badge: {
    position: "absolute",
    top: -5,
    right: -9,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "#ef4444",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
    borderWidth: 2,
    borderColor: C.bg2,
  },
  badgeTxt: { color: "#fff", fontSize: 10, fontWeight: "800" },
});
