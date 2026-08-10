import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiHeaders } from "../lib/api";
import { useAuth } from "../hooks/use-auth";
import { activeCompany, switchCompany } from "../lib/tenant";
import { Building2, ChevronsUpDown, Check } from "lucide-react";

type Company = {
  id: string;
  name: string;
  role?: string;
  status?: string;
};

const ROLE_LABEL: Record<string, string> = {
  superadmin: "Superadmin",
  admin: "Admin",
  manager: "Manager",
  dispatcher: "Dispatcher",
  project_manager: "Project manager",
  rider: "Technician",
  customer: "Client",
};

/**
 * Company selector.
 *
 * Shows for two audiences:
 *  - superadmins, who can act as any tenant (amber "acting as tenant" styling,
 *    unchanged), and
 *  - anyone who genuinely belongs to more than one company, e.g. a contract
 *    technician working for both Acme and Bolt. They see only their own
 *    companies and the role they hold at each.
 *
 * Someone with a single company sees nothing at all, so the common case is
 * exactly as it was before.
 */
export function TenantSwitcher() {
  const { role } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const stored = activeCompany();

  const { data } = useQuery({
    queryKey: ["me", "companies"],
    queryFn: async () => {
      const res = await fetch("/api/me/companies", { headers: apiHeaders() });
      if (!res.ok) return { companies: [], superadmin: false, activeCompanyId: null };
      return res.json();
    },
  });

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const isSuper = role === "superadmin" || !!data?.superadmin;
  const companies = ((data?.companies ?? []) as Company[]).filter(
    (c) => c.status !== "suspended",
  );
  // The server is the source of truth for what we're acting as; localStorage is
  // only a hint (and may be stale after a membership is revoked).
  const active = stored ?? data?.activeCompanyId ?? "default";

  // A single-company person has nothing to switch between — render nothing.
  if (!isSuper && companies.length < 2) return null;
  if (isSuper && companies.length === 0) return null;

  const list = isSuper
    ? companies.some((c) => c.id === "default")
      ? companies
      : [{ id: "default", name: "NVC 360 (Home)" }, ...companies]
    : companies;
  const current = list.find((c) => c.id === active);

  const label = isSuper ? "Acting as tenant" : "Company";
  const tone = isSuper
    ? "border-amber-500/30 bg-amber-500/10 text-amber-200 hover:border-amber-500/50"
    : "border-white/10 bg-white/5 text-slate-200 hover:border-white/20";
  const labelTone = isSuper ? "text-amber-400/70" : "text-slate-500";

  return (
    <div ref={ref} className="relative px-3 py-3">
      <div
        className={`mb-1.5 px-0.5 text-[10px] font-semibold uppercase tracking-wide ${labelTone}`}
      >
        {label}
      </div>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition ${tone}`}
        title={isSuper ? "Switch active tenant" : "Switch company"}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Building2 className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">
          {current?.name ?? "Select company"}
        </span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
      </button>

      {open && (
        <div className="absolute left-3 right-3 z-50 mt-2 overflow-hidden rounded-xl border border-white/10 bg-ink-2 shadow-2xl">
          <div className="max-h-72 overflow-y-auto py-1" role="menu">
            {list.map((c) => (
              <button
                key={c.id}
                role="menuitem"
                aria-current={c.id === active}
                onClick={() => {
                  setOpen(false);
                  if (c.id !== active) switchCompany(c.id);
                }}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-slate-300 transition hover:bg-white/5"
              >
                <span className="min-w-0">
                  <span className="block truncate">{c.name}</span>
                  <span className="block truncate text-xs text-slate-500">
                    {/* Superadmins care about the tenant slug; a technician cares
                        about what they are at that company. */}
                    {isSuper ? c.id : (ROLE_LABEL[c.role ?? ""] ?? c.role ?? "")}
                  </span>
                </span>
                {c.id === active && <Check className="h-4 w-4 text-cyan-glow" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
