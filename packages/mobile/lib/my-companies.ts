import { useQuery } from "@tanstack/react-query";
import Constants from "expo-constants";
import { authHeaders } from "./auth";
import { getActiveCompany } from "./active-company";
import { resolveActiveCompanyName, type MyCompanies } from "./company-name";

/**
 * Fetching side of "which company am I working for right now" — kept apart
 * from the pure name resolution in ./company-name.ts so that logic stays
 * testable without React Native in the loader.
 */

const API = ((Constants.expoConfig?.extra?.apiUrl as string) ?? "").replace(/\/$/, "");

/**
 * One cache key for the roster list, shared by Profile's company switcher and
 * the Dispatch header. Same key + same fetcher means the two can never render
 * different names for the same driver.
 */
export const MY_COMPANIES_KEY = ["my-companies"] as const;

export function useMyCompanies() {
  return useQuery<MyCompanies>({
    queryKey: MY_COMPANIES_KEY,
    queryFn: async () => {
      const res = await fetch(`${API}/api/me/companies`, { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed");
      const json = (await res.json()) as Partial<MyCompanies>;
      return { ...json, companies: json.companies ?? [] };
    },
    staleTime: 5 * 60_000,
  });
}

/** Hook form: the active company's readable name, or "" when unknown. */
export function useActiveCompanyName(): string {
  const q = useMyCompanies();
  return resolveActiveCompanyName(getActiveCompany(), q.data);
}
