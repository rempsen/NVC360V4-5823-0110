import { View, Text, StyleSheet } from "react-native";
import { C } from "../lib/theme";
import type { CompanyNotifications } from "../lib/notify-summary";

/**
 * "This company is waiting on you."
 *
 * A technician on two rosters sees one job list at a time, so the company
 * picker and the profile switcher are the ONLY places where the other
 * employer's pending work can surface. Both render these, so the badge a tech
 * taps in the picker and the badge they see in Profile can never disagree.
 */

/** Red count bubble for a company row. Renders nothing at zero. */
export function CompanyBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <View style={s.badge}>
      <Text style={s.badgeTxt} allowFontScaling={false}>
        {count > 99 ? "99+" : count}
      </Text>
    </View>
  );
}

/**
 * Plain-English breakdown: "2 new work orders · 1 unread message".
 *
 * Spelled out rather than shown as a bare number because the two things need
 * different reactions from the tech — a work order expires if nobody accepts
 * it, a message doesn't.
 */
export function companyAlertText(n?: CompanyNotifications | null): string | null {
  if (!n || n.total <= 0) return null;
  const parts: string[] = [];
  if (n.pendingOffers > 0) {
    parts.push(n.pendingOffers === 1 ? "1 new work order" : `${n.pendingOffers} new work orders`);
  }
  if (n.unreadMessages > 0) {
    parts.push(
      n.unreadMessages === 1 ? "1 unread message" : `${n.unreadMessages} unread messages`,
    );
  }
  return parts.join(" · ");
}

/** The same breakdown as a red line under the company name. */
export function CompanyAlertLine({ n }: { n?: CompanyNotifications | null }) {
  const txt = companyAlertText(n);
  if (!txt) return null;
  return <Text style={s.alertTxt}>{txt}</Text>;
}

const s = StyleSheet.create({
  badge: {
    minWidth: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: C.red,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 7,
  },
  badgeTxt: { color: "#fff", fontSize: 12, fontWeight: "800" },
  alertTxt: { color: C.red, fontSize: 12, fontWeight: "700", marginTop: 3 },
});
