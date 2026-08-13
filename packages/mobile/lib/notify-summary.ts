import { useQuery } from "@tanstack/react-query";
import Constants from "expo-constants";
import { authHeaders } from "./auth";
import { getActiveCompany } from "./active-company";

const API = ((Constants.expoConfig?.extra?.apiUrl as string) ?? "").replace(/\/$/, "");

/**
 * "What needs this technician's attention, everywhere they work?"
 *
 * One query, one cache entry, feeding every red indicator in the app:
 *   - the number on the app icon (unread messages + work orders awaiting a
 *     yes/no), which is what the driver sees before they even open the app
 *   - the count on the Jobs and Messages tabs for the company they're on shift
 *     for right now
 *   - the red badge on each company in the picker and the profile switcher, so
 *     a tech on two rosters can see WHICH company is waiting on them
 *
 * Why a dedicated endpoint instead of deriving this from the job list and the
 * message thread already loaded on screen: every other endpoint in this app is
 * tenant-scoped to the company the tech picked for this shift. Derived counts
 * therefore structurally CANNOT see the other company's work order — the tech
 * would have to switch companies to discover a job they were never told about.
 * `/api/me/notifications` is the one company-agnostic read (scoped to the
 * caller's own memberships) that can.
 *
 * Deliberately raw `fetch` rather than the typed `api` client: this is used on
 * `pick-company`, which runs BEFORE a company has been chosen.
 */

export type CompanyNotifications = {
  companyId: string;
  company: string;
  staffType?: string | null;
  unreadMessages: number;
  pendingOffers: number;
  total: number;
};

export type NotifySummary = {
  total: number;
  unreadMessages: number;
  pendingOffers: number;
  active: {
    companyId: string;
    unreadMessages: number;
    pendingOffers: number;
    total: number;
  };
  companies: CompanyNotifications[];
};

const EMPTY: NotifySummary = {
  total: 0,
  unreadMessages: 0,
  pendingOffers: 0,
  active: { companyId: "", unreadMessages: 0, pendingOffers: 0, total: 0 },
  companies: [],
};

export const NOTIFY_SUMMARY_KEY = ["notify-summary"] as const;

export async function fetchNotifySummary(): Promise<NotifySummary> {
  const res = await fetch(`${API}/api/me/notifications`, { headers: authHeaders() });
  // Never throw on a bad response: a failed count must degrade to "no badge",
  // not to an error state on a screen whose actual job is showing jobs. A
  // thrown error here would also retry-storm behind the 8s interval.
  if (!res.ok) return EMPTY;
  const json = (await res.json()) as Partial<NotifySummary>;
  return { ...EMPTY, ...json, companies: json.companies ?? [] };
}

/**
 * @param enabled pass false where there is no session yet (the sign-in screen)
 *   so we don't poll an endpoint that can only 401.
 */
export function useNotifySummary(enabled = true) {
  const q = useQuery({
    queryKey: NOTIFY_SUMMARY_KEY,
    queryFn: fetchNotifySummary,
    // 8s matches the old dispatch-unread poll this replaces. A dispatcher
    // offering a job expects the phone to light up in seconds, not minutes.
    refetchInterval: 8000,
    enabled,
  });
  const data = q.data ?? EMPTY;

  // The picker writes the active company to the Keychain and the server reads it
  // off a header, so on the very first fetch after a switch `active` can still
  // describe the previous company. Resolve it locally against the id we know is
  // current — the per-company rows are authoritative regardless of header timing.
  const activeId = getActiveCompany();
  const local = data.companies.find((x) => x.companyId === activeId);
  const active = local
    ? { companyId: local.companyId, unreadMessages: local.unreadMessages, pendingOffers: local.pendingOffers, total: local.total }
    : data.active;

  return {
    ...q,
    data,
    active,
    /** Waiting on the tech at a company OTHER than the one they're on shift for. */
    elsewhere: data.companies.filter((x) => x.companyId !== active.companyId && x.total > 0),
  };
}

/** Count for one company, safe on a missing/loading summary. */
export function companyCount(
  summary: NotifySummary | undefined,
  companyId: string,
): CompanyNotifications | undefined {
  return summary?.companies.find((x) => x.companyId === companyId);
}
