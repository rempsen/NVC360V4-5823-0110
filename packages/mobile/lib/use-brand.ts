import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/**
 * Tenant brand + vocabulary for the driver app — mirrors
 * packages/web/src/web/lib/use-brand.ts so a company that calls its field
 * staff "Plumbers"/"Drivers" and its work "Visits"/"Rides" sees that
 * everywhere, not just on the admin web dashboard.
 *
 * Cached for the session (settings rarely change); falls back to sane
 * NVC360 defaults while loading or if the request fails.
 */
export interface TenantBrand {
  noun: string; // singular worker noun, e.g. "Technician"
  nounPlural: string;
  customerNoun: string; // singular noun for who they serve, e.g. "Client", "Patient"
  customerNounPlural: string;
  jobNoun: string; // singular noun for a unit of work, e.g. "Job", "Visit", "Ride"
  jobNounPlural: string;
  name: string;
}

const DEFAULTS: TenantBrand = {
  noun: "Technician",
  nounPlural: "Technicians",
  customerNoun: "Customer",
  customerNounPlural: "Customers",
  jobNoun: "Job",
  jobNounPlural: "Jobs",
  name: "NVC 360",
};

export function useBrand(): TenantBrand {
  const q = useQuery({
    queryKey: ["tenant-brand"],
    queryFn: async () => {
      const r = await api.settings.$get();
      const j = (await r.json()) as { settings?: Record<string, unknown> };
      return j.settings ?? {};
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
  const s = (q.data ?? {}) as Record<string, unknown>;
  const str = (v: unknown, fb: string) =>
    typeof v === "string" && v.trim() ? (v as string) : fb;
  return {
    noun: str(s.workerNoun, DEFAULTS.noun),
    nounPlural: str(s.workerNounPlural, DEFAULTS.nounPlural),
    customerNoun: str(s.customerNoun, DEFAULTS.customerNoun),
    customerNounPlural: str(s.customerNounPlural, DEFAULTS.customerNounPlural),
    jobNoun: str(s.jobNoun, DEFAULTS.jobNoun),
    jobNounPlural: str(s.jobNounPlural, DEFAULTS.jobNounPlural),
    name: str(s.name, DEFAULTS.name),
  };
}

/** Convenience: just the worker noun pair. */
export function useWorkerNoun(): { noun: string; nounPlural: string } {
  const b = useBrand();
  return { noun: b.noun, nounPlural: b.nounPlural };
}

/** Convenience: just the customer noun pair (who this tenant serves). */
export function useCustomerNoun(): { noun: string; nounPlural: string } {
  const b = useBrand();
  return { noun: b.customerNoun, nounPlural: b.customerNounPlural };
}

/** Convenience: just the job/unit-of-work noun pair. */
export function useJobNoun(): { noun: string; nounPlural: string } {
  const b = useBrand();
  return { noun: b.jobNoun, nounPlural: b.jobNounPlural };
}
