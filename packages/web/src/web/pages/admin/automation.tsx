import { useState } from "react";
import { DialogPanel } from "../../components/dialog-panel";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { FullLoader } from "../../components/loader";
import { PageWrap } from "../../components/brand";
import { PageHead } from "./shell";
import {
  Sparkles,
  Zap,
  Plus,
  Trash2,
  Bot,
  ArrowRight,
  X,
} from "lucide-react";

// These keys MUST match services/automation.ts — the engine matches on the
// stored string, so a label-only mismatch means a rule that silently never runs.
const TRIGGERS = [
  { key: "wo_created", label: "Work order created" },
  { key: "tech_enroute", label: "Technician en route" },
  { key: "wo_completed", label: "Work order completed" },
  { key: "tech_idle", label: "Technician idle (time-based)" },
  { key: "sla_risk", label: "SLA at risk (time-based)" },
] as const;

const ACTIONS = [
  { key: "notify_dispatch", label: "Notify dispatch" },
  { key: "send_sms", label: "Send SMS" },
  { key: "escalate", label: "Escalate to office" },
  { key: "auto_assign", label: "Suggest auto-assign" },
  { key: "reroute", label: "Suggest reroute" },
] as const;

const TRIGGER_LABEL: Record<string, string> = Object.fromEntries(
  TRIGGERS.map((t) => [t.key, t.label]),
);
const ACTION_LABEL: Record<string, string> = Object.fromEntries(
  ACTIONS.map((a) => [a.key, a.label]),
);

const labelize = (s: string) =>
  TRIGGER_LABEL[s] ??
  ACTION_LABEL[s] ??
  s.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

const PRIORITIES = ["", "low", "normal", "high", "urgent"];

export default function AutomationPage() {
  const qc = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({
    name: "",
    trigger: TRIGGERS[0].key as string,
    action: ACTIONS[0].key as string,
    description: "",
    priority: "",
    minMinutes: "",
    message: "",
  });

  const rules = useQuery({
    queryKey: ["automation"],
    queryFn: async () => (await api.automation.$get()).json(),
  });

  const isTimeTrigger =
    form.trigger === "tech_idle" || form.trigger === "sla_risk";

  const create = useMutation({
    mutationFn: async () =>
      (
        await api.automation.$post({
          json: {
            name: form.name,
            description: form.description,
            trigger: form.trigger,
            action: form.action,
            enabled: true,
            conditions: {
              ...(form.priority ? { priority: form.priority } : {}),
              ...(isTimeTrigger && form.minMinutes
                ? { minMinutes: Number(form.minMinutes) }
                : {}),
            },
            actionConfig: {
              title: form.name,
              message: form.message || form.description,
            },
          },
        })
      ).json(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["automation"] });
      setShowNew(false);
      setForm({
        name: "",
        trigger: TRIGGERS[0].key,
        action: ACTIONS[0].key,
        description: "",
        priority: "",
        minMinutes: "",
        message: "",
      });
    },
  });

  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) =>
      (await api.automation[":id"].$patch({ param: { id }, json: { enabled } })).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["automation"] }),
  });

  const del = useMutation({
    mutationFn: async (id: string) =>
      (await api.automation[":id"].$delete({ param: { id } })).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["automation"] }),
  });

  if (rules.isLoading) return <FullLoader label="Loading automations…" />;
  const list = rules.data?.rules ?? [];

  return (
    <PageWrap>
      <PageHead
        title="Automation & AI"
        subtitle="No-code rules that run your operation on autopilot"
        actions={
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-deep"
          >
            <Plus className="h-4 w-4" /> New rule
          </button>
        }
      />

      {/* AI capabilities banner */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <div className="nvc-card flex items-start gap-3 border-brand/20 bg-brand/5 p-4">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/15 text-cyan-glow">
            <Bot className="h-5 w-5" />
          </span>
          <div>
            <p className="font-semibold text-white">AI Smart Dispatch</p>
            <p className="text-sm text-slate-400">
              Ranks technicians by distance, skill match and availability the
              moment a job lands.
            </p>
          </div>
        </div>
        <div className="nvc-card flex items-start gap-3 border-emerald-live/20 bg-emerald-live/5 p-4">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-live/15 text-emerald-live">
            <Sparkles className="h-5 w-5" />
          </span>
          <div>
            <p className="font-semibold text-white">Route Optimization</p>
            <p className="text-sm text-slate-400">
              Re-sequences each tech's stops to cut drive time and fuel.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-2.5">
        {list.map((r) => (
          <div
            key={r.id}
            className="nvc-card flex items-center gap-4 p-4"
          >
            <span
              className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${
                r.enabled
                  ? "bg-emerald-live/15 text-emerald-live"
                  : "bg-white/5 text-slate-600"
              }`}
            >
              <Zap className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-white">{r.name}</p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                <span className="rounded-md bg-amber-warn/10 px-2 py-0.5 font-medium text-amber-warn">
                  {labelize(r.trigger)}
                </span>
                <ArrowRight className="h-3 w-3 text-slate-600" />
                <span className="rounded-md bg-brand/10 px-2 py-0.5 font-medium text-cyan-glow">
                  {labelize(r.action)}
                </span>
              </div>
            </div>
            <button
              type="button"
              aria-label={r.enabled ? "Disable automation" : "Enable automation"}
              onClick={() => toggle.mutate({ id: r.id, enabled: !r.enabled })}
              className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                r.enabled ? "bg-emerald-live" : "bg-white/10"
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                  r.enabled ? "left-[22px]" : "left-0.5"
                }`}
              />
            </button>
            <button
              onClick={() => del.mutate(r.id)}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-red-500/10 hover:text-red-400"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        {list.length === 0 && (
          <p className="py-12 text-center text-sm text-slate-500">
            No automation rules yet
          </p>
        )}
      </div>

      {/* new rule modal */}
      {showNew && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm">
          <DialogPanel onClose={() => setShowNew(false)} label="New automation rule" className="w-full max-w-md rounded-2xl border border-white/10 bg-ink-2 p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold text-white">
                New automation rule
              </h3>
              <button
                onClick={() => setShowNew(false)}
                className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-white/5 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3">
              <input aria-label="Rule name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Rule name"
                className="w-full rounded-lg border border-white/10 bg-ink-3/60 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-brand focus:outline-none"
              />
              <div>
                <span className="mb-1 block text-xs text-slate-500">When (trigger)</span>
                <select aria-label="When (trigger)"
                  value={form.trigger}
                  onChange={(e) => setForm({ ...form, trigger: e.target.value })}
                  className="w-full rounded-lg border border-white/10 bg-ink-3/60 px-3 py-2 text-sm text-white focus:border-brand focus:outline-none"
                >
                  {TRIGGERS.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <span className="mb-1 block text-xs text-slate-500">Then (action)</span>
                <select aria-label="Then (action)"
                  value={form.action}
                  onChange={(e) => setForm({ ...form, action: e.target.value })}
                  className="w-full rounded-lg border border-white/10 bg-ink-3/60 px-3 py-2 text-sm text-white focus:border-brand focus:outline-none"
                >
                  {ACTIONS.map((a) => (
                    <option key={a.key} value={a.key}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Optional filter — blank means "every job of this trigger" */}
              <div>
                <span className="mb-1 block text-xs text-slate-500">
                  Only when priority is
                </span>
                <select
                  aria-label="Priority filter"
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: e.target.value })}
                  className="w-full rounded-lg border border-white/10 bg-ink-3/60 px-3 py-2 text-sm text-white focus:border-brand focus:outline-none"
                >
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p === "" ? "Any priority" : labelize(p)}
                    </option>
                  ))}
                </select>
              </div>

              {isTimeTrigger && (
                <div>
                  <span className="mb-1 block text-xs text-slate-500">
                    After how many minutes?
                  </span>
                  <input
                    aria-label="Minutes threshold"
                    type="number"
                    min={5}
                    value={form.minMinutes}
                    onChange={(e) => setForm({ ...form, minMinutes: e.target.value })}
                    placeholder={form.trigger === "tech_idle" ? "30" : "60"}
                    className="w-full rounded-lg border border-white/10 bg-ink-3/60 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-brand focus:outline-none"
                  />
                </div>
              )}

              <div>
                <span className="mb-1 block text-xs text-slate-500">
                  Message {form.action === "send_sms" ? "(sent to the customer)" : "(shown to dispatch)"}
                </span>
                <textarea
                  aria-label="Message"
                  rows={2}
                  value={form.message}
                  onChange={(e) => setForm({ ...form, message: e.target.value })}
                  placeholder="Use {{customerName}}, {{techName}}, {{address}}, {{shortId}}, {{trackUrl}}"
                  className="w-full resize-none rounded-lg border border-white/10 bg-ink-3/60 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-brand focus:outline-none"
                />
              </div>
              <button
                disabled={!form.name || create.isPending}
                onClick={() => create.mutate()}
                className="w-full rounded-lg bg-brand py-2.5 text-sm font-semibold text-white hover:bg-brand-deep disabled:opacity-50"
              >
                {create.isPending ? "Creating…" : "Create rule"}
              </button>
            </div>
          </DialogPanel>
        </div>
      )}
    </PageWrap>
  );
}
