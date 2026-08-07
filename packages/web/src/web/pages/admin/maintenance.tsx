/**
 * Maintenance plans — recurring service agreements.
 *
 * The retention half of the business: every completed job can become a plan
 * ("furnace tune-up every 180 days"), and the scheduler texts the customer
 * ahead of each due date so the next visit books itself.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { FullLoader } from "../../components/loader";
import { PageWrap } from "../../components/brand";
import { PageHead } from "./shell";
import { useCustomerNoun, useJobNoun } from "../../lib/use-brand";
import {
  CalendarSync,
  Plus,
  Trash2,
  X,
  MapPin,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";

interface Plan {
  id: string;
  name: string;
  address: string;
  intervalDays: number;
  remindDaysBefore: number;
  nextDueAt: string | null;
  lastServiceAt: string | null;
  notes: string;
  active: boolean;
  remindersSent: number;
}

const inputCls =
  "w-full rounded-lg border border-white/10 bg-ink-3/60 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-brand focus:outline-none";

function fmt(v: string | null) {
  if (!v) return "—";
  const d = new Date(v);
  return isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function daysUntil(v: string | null): number | null {
  if (!v) return null;
  const d = new Date(v).getTime();
  if (isNaN(d)) return null;
  return Math.round((d - Date.now()) / 86_400_000);
}

const PRESETS = [
  { label: "Monthly", days: 30 },
  { label: "Quarterly", days: 90 },
  { label: "Twice a year", days: 180 },
  { label: "Yearly", days: 365 },
];

export default function MaintenancePage() {
  const qc = useQueryClient();
  const { noun: customerNoun } = useCustomerNoun();
  const { noun: jobNoun } = useJobNoun();
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({
    name: "",
    address: "",
    intervalDays: 180,
    remindDaysBefore: 7,
    nextDueAt: "",
    notes: "",
  });

  const plans = useQuery({
    queryKey: ["maintenance"],
    queryFn: async () => {
      const r = await fetch("/api/maintenance", { credentials: "include" });
      if (!r.ok) throw new Error("failed");
      return r.json() as Promise<{ plans: Plan[] }>;
    },
  });

  const mutateJson = async (url: string, method: string, body?: unknown) => {
    const r = await fetch(url, {
      method,
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error("failed");
    return r.json();
  };
  const invalidate = () => qc.invalidateQueries({ queryKey: ["maintenance"] });

  const create = useMutation({
    mutationFn: () =>
      mutateJson("/api/maintenance", "POST", {
        ...form,
        nextDueAt: form.nextDueAt || undefined,
      }),
    onSuccess: () => {
      invalidate();
      setShowNew(false);
      setForm({
        name: "",
        address: "",
        intervalDays: 180,
        remindDaysBefore: 7,
        nextDueAt: "",
        notes: "",
      });
    },
  });

  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      mutateJson(`/api/maintenance/${id}`, "PATCH", { active }),
    onSuccess: invalidate,
  });

  const serviced = useMutation({
    mutationFn: (id: string) => mutateJson(`/api/maintenance/${id}/serviced`, "POST"),
    onSuccess: invalidate,
  });

  const del = useMutation({
    mutationFn: (id: string) => mutateJson(`/api/maintenance/${id}`, "DELETE"),
    onSuccess: invalidate,
  });

  if (plans.isLoading) return <FullLoader label="Loading maintenance plans…" />;
  const list = plans.data?.plans ?? [];
  const dueSoon = list.filter(
    (p) => p.active && (daysUntil(p.nextDueAt) ?? 999) <= 30,
  ).length;

  return (
    <PageWrap>
      <PageHead
        title="Maintenance Plans"
        subtitle={`Recurring service agreements — reminders go out automatically before each ${jobNoun.toLowerCase()} is due`}
        actions={
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-deep"
          >
            <Plus className="h-4 w-4" /> New plan
          </button>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <div className="nvc-card p-4">
          <p className="font-display text-2xl font-bold text-white">
            {list.filter((p) => p.active).length}
          </p>
          <p className="text-xs text-slate-500">Active plans</p>
        </div>
        <div className="nvc-card p-4">
          <p className="font-display text-2xl font-bold text-amber-warn">{dueSoon}</p>
          <p className="text-xs text-slate-500">Due within 30 days</p>
        </div>
        <div className="nvc-card p-4">
          <p className="font-display text-2xl font-bold text-white">
            {list.reduce((s, p) => s + (p.remindersSent ?? 0), 0)}
          </p>
          <p className="text-xs text-slate-500">Reminders sent</p>
        </div>
      </div>

      <div className="space-y-2.5">
        {list.map((p) => {
          const d = daysUntil(p.nextDueAt);
          const overdue = p.active && d != null && d < 0;
          const soon = p.active && d != null && d >= 0 && d <= 30;
          return (
            <div key={p.id} className="nvc-card flex flex-wrap items-center gap-4 p-4">
              <span
                className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${
                  overdue
                    ? "bg-red-500/15 text-red-400"
                    : soon
                      ? "bg-amber-warn/15 text-amber-warn"
                      : p.active
                        ? "bg-emerald-live/15 text-emerald-live"
                        : "bg-white/5 text-slate-600"
                }`}
              >
                {overdue ? (
                  <AlertTriangle className="h-5 w-5" />
                ) : (
                  <CalendarSync className="h-5 w-5" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-white">{p.name || "Untitled plan"}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                  {p.address && (
                    <span className="flex items-center gap-1">
                      <MapPin className="h-3 w-3" /> {p.address}
                    </span>
                  )}
                  <span>Every {p.intervalDays} days</span>
                  <span>
                    Next due {fmt(p.nextDueAt)}
                    {d != null &&
                      (overdue
                        ? ` (${Math.abs(d)}d overdue)`
                        : ` (in ${d}d)`)}
                  </span>
                  <span>Reminder {p.remindDaysBefore}d before</span>
                </p>
              </div>
              <button
                onClick={() => serviced.mutate(p.id)}
                className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-ink-3 px-2.5 py-1.5 text-xs font-semibold text-slate-300 hover:border-emerald-live/40 hover:text-white"
              >
                <CheckCircle2 className="h-3.5 w-3.5" /> Mark serviced
              </button>
              <button
                type="button"
                aria-label={p.active ? "Pause plan" : "Activate plan"}
                onClick={() => toggle.mutate({ id: p.id, active: !p.active })}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                  p.active ? "bg-emerald-live" : "bg-white/10"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                    p.active ? "left-[22px]" : "left-0.5"
                  }`}
                />
              </button>
              <button
                onClick={() => del.mutate(p.id)}
                aria-label="Delete plan"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-red-500/10 hover:text-red-400"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          );
        })}
        {list.length === 0 && (
          <div className="nvc-card p-12 text-center">
            <p className="text-sm text-slate-400">
              No maintenance plans yet.
            </p>
            <p className="mt-1 text-xs text-slate-600">
              Turn a one-off visit into recurring revenue — every {customerNoun.toLowerCase()} with
              equipment that needs servicing is a plan.
            </p>
          </div>
        )}
      </div>

      {showNew && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-white/10 bg-ink-2 p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold text-white">
                New maintenance plan
              </h3>
              <button
                onClick={() => setShowNew(false)}
                aria-label="Close"
                className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-white/5 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3">
              <input
                aria-label="Plan name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Bi-annual furnace tune-up"
                className={inputCls}
              />
              <input
                aria-label="Address"
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                placeholder="Service address"
                className={inputCls}
              />
              <div>
                <span className="mb-1 block text-xs text-slate-500">How often</span>
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {PRESETS.map((p) => (
                    <button
                      key={p.days}
                      onClick={() => setForm({ ...form, intervalDays: p.days })}
                      className={`rounded-lg border px-2.5 py-1 text-xs font-semibold transition ${
                        form.intervalDays === p.days
                          ? "border-brand bg-brand/15 text-cyan-glow"
                          : "border-white/10 bg-ink-3 text-slate-400 hover:text-white"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <input
                  aria-label="Interval days"
                  type="number"
                  min={1}
                  value={form.intervalDays}
                  onChange={(e) =>
                    setForm({ ...form, intervalDays: Number(e.target.value) || 180 })
                  }
                  className={inputCls}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="mb-1 block text-xs text-slate-500">
                    Remind days before
                  </span>
                  <input
                    aria-label="Remind days before"
                    type="number"
                    min={0}
                    value={form.remindDaysBefore}
                    onChange={(e) =>
                      setForm({ ...form, remindDaysBefore: Number(e.target.value) || 0 })
                    }
                    className={inputCls}
                  />
                </div>
                <div>
                  <span className="mb-1 block text-xs text-slate-500">
                    First due date
                  </span>
                  <input
                    aria-label="First due date"
                    type="date"
                    value={form.nextDueAt}
                    onChange={(e) => setForm({ ...form, nextDueAt: e.target.value })}
                    className={inputCls}
                  />
                </div>
              </div>
              <textarea
                aria-label="Notes"
                rows={2}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Notes (equipment, model, access details…)"
                className={`${inputCls} resize-none`}
              />
              <button
                disabled={!form.name || create.isPending}
                onClick={() => create.mutate()}
                className="w-full rounded-lg bg-brand py-2.5 text-sm font-semibold text-white hover:bg-brand-deep disabled:opacity-50"
              >
                {create.isPending ? "Creating…" : "Create plan"}
              </button>
            </div>
          </div>
        </div>
      )}
    </PageWrap>
  );
}
