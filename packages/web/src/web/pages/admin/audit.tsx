import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { FullLoader } from "../../components/loader";
import { PageWrap } from "../../components/brand";
import { PageHead } from "./shell";
import { Plus, Pencil, Trash2, UserCheck, Wallet, ScrollText, ShieldAlert } from "lucide-react";

const ACTION_META: Record<string, { icon: any; color: string }> = {
  create: { icon: Plus, color: "#22c55e" },
  update: { icon: Pencil, color: "#06b6d4" },
  delete: { icon: Trash2, color: "#ef4444" },
  assign: { icon: UserCheck, color: "#a855f7" },
  payout: { icon: Wallet, color: "#f59e0b" },
  // Permission changes are the highest-stakes entry in the log — give them
  // their own icon/colour so they stand out from routine edits.
  role_change: { icon: ShieldAlert, color: "#f43f5e" },
};

const fmt = (d: string) =>
  new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function AdminAudit() {
  const [filter, setFilter] = useState("all");
  const audit = useQuery({
    queryKey: ["audit"],
    queryFn: async () => (await api.audit.$get({ query: { limit: "300" } })).json(),
    refetchInterval: 15000,
  });

  if (audit.isLoading) return <FullLoader label="Loading audit log…" />;
  let entries = (audit.data as any)?.entries ?? [];
  const types = ["all", ...Array.from(new Set(entries.map((e: any) => e.entityType)))] as string[];
  if (filter !== "all") entries = entries.filter((e: any) => e.entityType === filter);

  return (
    <PageWrap>
      <PageHead title="Audit Log" subtitle="Every administrative action, timestamped" />

      <div className="mb-4 flex flex-wrap gap-1.5">
        {types.map((t) => (
          <button key={t} onClick={() => setFilter(t)}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold capitalize transition ${filter === t ? "bg-brand text-white" : "bg-ink-2 text-slate-400 hover:bg-white/5"}`}>
            {t.replace(/_/g, " ")}
          </button>
        ))}
      </div>

      {entries.length === 0 ? (
        <div className="nvc-card grid place-items-center py-16 text-center text-slate-500">
          <ScrollText className="mb-2 h-8 w-8 text-slate-700" />
          No activity recorded yet.
        </div>
      ) : (
        <div className="nvc-card divide-y divide-white/5">
          {entries.map((e: any) => {
            const meta = ACTION_META[e.action] ?? { icon: ScrollText, color: "#64748b" };
            return (
              <div key={e.id} className="flex items-start gap-3 px-4 py-3">
                <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg" style={{ background: `${meta.color}22`, color: meta.color }}>
                  <meta.icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-200">
                    <span className="font-semibold text-white">{e.actorName || "System"}</span>{" "}
                    {e.summary || `${e.action} ${e.entityType}`}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {e.entityType.replace(/_/g, " ")} · {fmt(e.createdAt)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </PageWrap>
  );
}
