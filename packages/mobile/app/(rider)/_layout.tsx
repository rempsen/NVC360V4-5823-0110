import { Tabs } from "expo-router";
import { useEffect } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import {
  Briefcase,
  CurrencyDollar,
  UserCircle,
  ChatCircleDots,
} from "phosphor-react-native";
import { C } from "../../lib/theme";
import { api } from "../../lib/api";
import { useLocationHeartbeat } from "../../lib/use-location-heartbeat";
import { endAllLiveActivities } from "../../lib/useLiveActivity";
import { usePushNotifications, setAppBadgeCount } from "../../lib/push";
import { useNotifySummary } from "../../lib/notify-summary";

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

  // A Live Activity is owned by iOS and survives the app being closed, so the
  // ONLY way it disappears is us ending it. Once the tech is confirmed off the
  // clock, tear down anything still on the Lock Screen / Dynamic Island. This
  // also catches the case where they went offline from another device or the
  // dispatcher took them off shift server-side. Gated on `me.data` being
  // loaded so a cold boot doesn't kill a legitimate in-progress job activity
  // before we know the status.
  useEffect(() => {
    if (me.data?.status == null) return;
    if (!onShift) endAllLiveActivities().catch(() => {});
  }, [onShift, me.data?.status]);

  // register this device for push (job offers, enroute alerts) + handle taps.
  usePushNotifications();

  // Everything that needs the tech's attention, at EVERY company they work for.
  // One query drives all four tab badges and the app-icon count.
  const notify = useNotifySummary();
  const msgBadge = notify.active.unreadMessages;
  const jobBadge = notify.active.pendingOffers;
  // Another company is waiting on them. Shown on Profile because that's where
  // the company switcher lives — the badge has to point at the thing that
  // resolves it.
  const elsewhereBadge = notify.elsewhere.reduce((s, x) => s + x.total, 0);

  // Mirror the count onto the OS app-icon badge while the app is
  // open/foregrounded. A push notification's own `badge` field already sets
  // this when the app is backgrounded/closed and a message arrives — this
  // covers the case where the count changes while polling in the foreground
  // (e.g. reading on another device) and reliably syncs it back down.
  //
  // This is the TOTAL across every company on purpose: the home-screen icon is
  // one icon for the whole app, so scoping it to the current shift's company
  // would leave a work order from the tech's other employer completely
  // invisible until they happened to switch.
  const iconBadge = notify.data.total;
  useEffect(() => {
    setAppBadgeCount(iconBadge);
  }, [iconBadge]);

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
            <TabIcon
              count={jobBadge}
              label={
                jobBadge === 1 ? "1 work order to accept or decline" : `${jobBadge} work orders to accept or decline`
              }
            >
              <Briefcase color={color} size={24} weight={focused ? "fill" : "regular"} />
            </TabIcon>
          ),
        }}
      />
      <Tabs.Screen
        name="messages"
        options={{
          title: "Messages",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon
              count={msgBadge}
              label={msgBadge === 1 ? "1 unread message" : `${msgBadge} unread messages`}
            >
              <ChatCircleDots color={color} size={24} weight={focused ? "fill" : "regular"} />
            </TabIcon>
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
            <TabIcon
              count={elsewhereBadge}
              label={`${elsewhereBadge} waiting at another company you work for`}
            >
              <UserCircle color={color} size={24} weight={focused ? "fill" : "regular"} />
            </TabIcon>
          ),
        }}
      />
    </Tabs>
  );
}

/**
 * Tab icon with the red count bubble.
 *
 * The count is also exposed to VoiceOver — a screen reader announces the tab
 * label, not a decorative red circle, so without this the number simply does
 * not exist for a tech using accessibility features.
 */
function TabIcon({
  count,
  label,
  children,
}: {
  count: number;
  label: string;
  children: React.ReactNode;
}) {
  if (count <= 0) return <>{children}</>;
  return (
    <View accessible accessibilityLabel={label}>
      {children}
      <View style={badgeStyles.badge}>
        <Text style={badgeStyles.badgeTxt} allowFontScaling={false}>
          {count > 9 ? "9+" : count}
        </Text>
      </View>
    </View>
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
