import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, apiHeaders } from "../../lib/api";
import { dismiss } from "../../lib/utils";
import { FullLoader } from "../../components/loader";
import { PageWrap } from "../../components/brand";
import { PageHead } from "./shell";
import { Modal, Field, inputCls, BtnPrimary, BtnGhost, ConfirmModal } from "../../components/modal";
import {
  Bell, Webhook, ScrollText, Send, Plus, Trash2, Check, X, Smartphone,
  Mail, MessageSquare, Globe, RefreshCw, UserPlus, Copy, Sliders, Pencil,
  RotateCcw, Moon, Sparkles, Image as ImageIcon, Palette, AlignLeft,
  Bold, Italic, Link as LinkIcon, PenLine, Loader2,
} from "lucide-react";
import { useWorkerNoun, useCustomerNoun, useIndustryNotificationGuidance } from "../../lib/use-brand";
const recipLabel = (r: { key: string; label: string }, noun: string, customerNoun: string) =>
  r.key === "tech" ? noun : r.key === "client" ? customerNoun : r.label;
import { EmailEditor, type EmailBlock } from "../../components/email-editor";
import { starterDesignForRecipient } from "../../lib/email-starters";

type Channel = "inApp" | "email" | "sms" | "webhook";
const CHANNELS: { key: Channel; label: string; icon: any }[] = [
  { key: "inApp", label: "In-app", icon: Smartphone },
  { key: "email", label: "Email", icon: Mail },
  { key: "sms", label: "SMS", icon: MessageSquare },
  { key: "webhook", label: "Webhook", icon: Globe },
];
const RECIPIENTS = [
  { key: "client", label: "Client" },
  { key: "tech", label: "Technician" },
  { key: "office", label: "Office" },
];

const TABS = [
  { id: "rules", label: "Notification Rules", icon: Bell },
  { id: "channels", label: "Channels", icon: Sliders },
  { id: "webhooks", label: "Webhooks", icon: Webhook },
  { id: "invites", label: "Technician Invites", icon: UserPlus },
  { id: "log", label: "Delivery Log", icon: ScrollText },
];

export default function AdminNotifications() {
  const [tab, setTab] = useState("rules");
  const { noun } = useWorkerNoun();
  const tabLabel = (t: { id: string; label: string }) => (t.id === "invites" ? `${noun} Invites` : t.label);
  return (
    <PageWrap>
      <PageHead title="Notifications" subtitle="Configure who gets notified, how, and on which events" />
      <div className="mb-6 flex flex-wrap gap-1.5 rounded-xl border border-white/5 bg-ink-2 p-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition ${
              tab === t.id ? "bg-brand text-white shadow-lg shadow-brand/30" : "text-slate-400 hover:text-white hover:bg-white/5"
            }`}
          >
            <t.icon className="h-4 w-4" /> {tabLabel(t)}
          </button>
        ))}
      </div>
      {tab === "rules" && <RulesMatrix />}
      {tab === "channels" && <Channels />}
      {tab === "webhooks" && <Webhooks />}
      {tab === "invites" && <Invites />}
      {tab === "log" && <DeliveryLog />}
    </PageWrap>
  );
}

/* ---------------- Rules matrix ---------------- */
function RulesMatrix() {
  const qc = useQueryClient();
  const { noun } = useWorkerNoun();
  const { noun: customerNoun } = useCustomerNoun();
  const [openEvent, setOpenEvent] = useState<{ event: string; label: string } | null>(null);
  const rules = useQuery({
    queryKey: ["notif-rules"],
    queryFn: async () => (await api["notif-config"].rules.$get()).json(),
  });

  const patch = useMutation({
    mutationFn: async (p: { id: string; body: any }) =>
      (await api["notif-config"].rules[":id"].$patch({ param: { id: p.id }, json: p.body })).json(),
    onMutate: async (p) => {
      await qc.cancelQueries({ queryKey: ["notif-rules"] });
      const prev = qc.getQueryData(["notif-rules"]);
      qc.setQueryData(["notif-rules"], (old: any) => {
        if (!old) return old;
        return { ...old, rules: old.rules.map((r: any) => (r.id === p.id ? { ...r, ...p.body } : r)) };
      });
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(["notif-rules"], ctx.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: ["notif-rules"] }),
  });

  const test = useMutation({
    mutationFn: async (event: string) => (await api["notif-config"].test[":event"].$post({ param: { event }, json: {} })).json(),
  });

  if (rules.isLoading) return <FullLoader label="Loading rules…" />;
  const data = rules.data as any;
  const events = data?.events ?? [];
  const allRules = data?.rules ?? [];
  const byKey = (event: string, recipient: string) => allRules.find((r: any) => r.event === event && r.recipient === recipient);

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-400">
        Toggle a channel for each recipient on each event. Changes save instantly and apply to the whole work-order lifecycle.
      </p>
      <div className="overflow-x-auto rounded-2xl border border-white/5 nvc-card">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b border-white/5 bg-ink/40 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3 font-semibold" rowSpan={2}>Event</th>
              {RECIPIENTS.map((r, i) => (
                <th key={r.key} className={`px-4 pt-3 pb-1.5 text-center font-bold text-slate-300 ${i > 0 ? "border-l border-white/5" : ""}`}>{recipLabel(r, noun, customerNoun)}</th>
              ))}
              <th className="px-4 py-3 text-center font-semibold" rowSpan={2}>Copy</th>
              <th className="px-4 py-3 text-right font-semibold" rowSpan={2}>Test</th>
            </tr>
            <tr className="border-b border-white/5 bg-ink/40 text-[10px] text-slate-500">
              {RECIPIENTS.map((r, i) => (
                <th key={r.key} className={`px-4 pb-2 font-medium ${i > 0 ? "border-l border-white/5" : ""}`}>
                  <div className="flex items-center justify-center gap-1.5">
                    {CHANNELS.map((ch) => (
                      <span key={ch.key} className="grid h-9 w-9 place-items-center" title={ch.label}>
                        <ch.icon className="h-3 w-3 text-slate-600" />
                      </span>
                    ))}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {events.map((ev: any) => (
              <tr key={ev.event} className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]">
                <td className="px-4 py-3 font-semibold text-white whitespace-nowrap">{ev.label}</td>
                {RECIPIENTS.map((rc, i) => {
                  const rule = byKey(ev.event, rc.key);
                  return (
                    <td key={rc.key} className={`px-4 py-3 ${i > 0 ? "border-l border-white/5" : ""}`}>
                      <div className="flex items-center justify-center gap-1.5">
                        {CHANNELS.map((ch) => {
                          const on = rule?.[ch.key];
                          return (
                            <button
                              key={ch.key}
                              aria-label={`${on ? "Disable" : "Enable"} ${ch.label} → ${rc.label}`}
                              title={`${on ? "Disable" : "Enable"} ${ch.label} → ${rc.label}`}
                              disabled={!rule}
                              onClick={() => rule && patch.mutate({ id: rule.id, body: { [ch.key]: !on } })}
                              className={`grid h-9 w-9 place-items-center rounded-lg border transition ${
                                on
                                  ? "border-brand/60 bg-brand/25 text-cyan-glow shadow-sm shadow-brand/20"
                                  : "border-white/5 bg-ink/60 text-slate-700 hover:text-slate-400 hover:border-white/10"
                              }`}
                            >
                              <ch.icon className="h-4 w-4" />
                            </button>
                          );
                        })}
                      </div>
                    </td>
                  );
                })}
                <td className="px-4 py-3 text-center">
                  <button
                    onClick={() => setOpenEvent({ event: ev.event, label: ev.label })}
                    title="Edit message copy"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-ink px-3 py-1.5 text-xs font-semibold text-slate-300 hover:border-brand/40 hover:text-cyan-glow"
                  >
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </button>
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => test.mutate(ev.event)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-ink px-3 py-1.5 text-xs font-semibold text-slate-300 hover:border-brand/40 hover:text-cyan-glow"
                  >
                    <Send className="h-3.5 w-3.5" /> Test
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-4 px-1 text-xs text-slate-500">
        <span className="font-semibold uppercase tracking-wide">Channels:</span>
        {CHANNELS.map((c) => (
          <span key={c.key} className="inline-flex items-center gap-1.5"><c.icon className="h-3.5 w-3.5" /> {c.label}</span>
        ))}
      </div>
      {test.isSuccess && <p className="px-1 text-xs text-green-400">Test event fired against the latest work order — check the Delivery Log.</p>}
      {openEvent && <EventDrawer event={openEvent.event} label={openEvent.label} onClose={() => setOpenEvent(null)} />}
    </div>
  );
}

/* ---------------- Per-event detail drawer + template editor ---------------- */
function EventDrawer({ event, label, onClose }: { event: string; label: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { noun } = useWorkerNoun();
  const { noun: customerNoun } = useCustomerNoun();
  const detail = useQuery({
    queryKey: ["notif-event", event],
    queryFn: async () => (await api["notif-config"].events[":event"].$get({ param: { event } })).json(),
  });

  const patch = useMutation({
    mutationFn: async (p: { id: string; body: any }) =>
      (await api["notif-config"].rules[":id"].$patch({ param: { id: p.id }, json: p.body })).json(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notif-event", event] });
      qc.invalidateQueries({ queryKey: ["notif-rules"] });
    },
  });

  const data = detail.data as any;
  const rules: any[] = data?.rules ?? [];
  const defaults: Record<string, string> = data?.defaults ?? {};
  const vars: { key: string; label: string }[] = data?.vars ?? [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end" {...dismiss(onClose)}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" aria-hidden="true" />
      <div className="relative h-full w-full max-w-2xl overflow-y-auto border-l border-white/10 bg-ink-2 p-6 shadow-2xl">
        <div className="mb-5 flex items-start justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-brand">Event</div>
            <h2 className="text-xl font-bold text-white">{label}</h2>
            <p className="mt-1 text-xs text-slate-500">Edit channels and message copy for each recipient.</p>
          </div>
          <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        {detail.isLoading ? (
          <FullLoader label="Loading…" />
        ) : (
          <div className="space-y-4">
            {RECIPIENTS.map((rc) => {
              const rule = rules.find((r) => r.recipient === rc.key);
              if (!rule) return null;
              return (
                <RecipientCard
                  key={rc.key}
                  rule={rule}
                  recipientLabel={recipLabel(rc, noun, customerNoun)}
                  eventLabel={label}
                  fallback={defaults[rc.key] || ""}
                  vars={vars}
                  onSave={(body) => patch.mutate({ id: rule.id, body })}
                  saving={patch.isPending}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function MessageComposer({
  value, fallback, vars, smsOn, contextLabel, saving,
  onSave, onReset, onClose,
}: {
  value: string; fallback: string;
  vars: { key: string; label: string }[];
  smsOn: boolean; contextLabel: string; saving: boolean;
  onSave: (v: string) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const [tpl, setTpl] = useState(value);
  const [preview, setPreview] = useState<string>("");
  const [tab, setTab] = useState<"write" | "preview">("write");
  const taRef = useRef<HTMLTextAreaElement>(null);

  const doPreview = useMutation({
    mutationFn: async (template: string) =>
      (await api["notif-config"].preview.$post({ json: { template } })).json(),
    onSuccess: (d: any) => setPreview(d.rendered),
  });

  const effective = tpl || fallback;
  const charCount = effective.length;
  const smsSegments = charCount === 0 ? 0 : Math.ceil(charCount / 160);
  const dirty = value !== tpl;

  const wrap = (before: string, after: string) => {
    const ta = taRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const sel = tpl.slice(start, end);
    const next = tpl.slice(0, start) + before + sel + after + tpl.slice(end);
    setTpl(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + before.length, start + before.length + sel.length);
    });
  };

  const insertVar = (k: string) => {
    const ta = taRef.current;
    const pos = ta ? ta.selectionStart : tpl.length;
    const token = `{{${k}}}`;
    const next = tpl.slice(0, pos) + (pos > 0 && tpl[pos - 1] !== " " ? " " : "") + token + tpl.slice(pos);
    setTpl(next);
    requestAnimationFrame(() => ta?.focus());
  };

  // Use refs so we can access latest values without adding to deps
  const _doPreviewRef = useRef(doPreview);
  _doPreviewRef.current = doPreview;
  const _effectiveRef = useRef(effective);
  _effectiveRef.current = effective;
  useEffect(() => {
    if (tab === "preview") _doPreviewRef.current.mutate(_effectiveRef.current);
  }, [tab]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div
        className="flex w-full max-w-4xl flex-col rounded-2xl border border-white/10 bg-[#0d1117] shadow-2xl"
        style={{ height: "min(88vh, 680px)" }}
      >
        {/* header */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
          <div>
            <div className="text-sm font-semibold text-white">Edit message</div>
            <div className="text-[11px] text-slate-500">{contextLabel}</div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:text-white hover:bg-white/5">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* tab bar */}
        <div className="flex border-b border-white/10 px-5">
          {(["write", "preview"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`border-b-2 px-4 py-2.5 text-xs font-semibold capitalize transition ${
                tab === t
                  ? "border-brand text-cyan-glow"
                  : "border-transparent text-slate-500 hover:text-slate-300"
              }`}
            >
              {t === "write" ? "Write" : "Preview"}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === "write" ? (
            <div className="flex h-full flex-col p-5 gap-3">
              {/* toolbar */}
              <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-ink px-2 py-1.5">
                <button
                  onClick={() => wrap("**", "**")}
                  title="Bold"
                  className="rounded p-1.5 text-slate-400 hover:text-white hover:bg-white/5"
                >
                  <Bold className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => wrap("_", "_")}
                  title="Italic"
                  className="rounded p-1.5 text-slate-400 hover:text-white hover:bg-white/5"
                >
                  <Italic className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => wrap("[", "](url)")}
                  title="Link"
                  className="rounded p-1.5 text-slate-400 hover:text-white hover:bg-white/5"
                >
                  <LinkIcon className="h-3.5 w-3.5" />
                </button>
                <div className="mx-2 h-4 w-px bg-white/10" />
                {smsOn && (
                  <span className={`ml-auto font-mono text-[10px] ${charCount > 160 ? "text-amber-400" : "text-slate-500"}`}>
                    {charCount} char{smsSegments > 1 ? ` · ${smsSegments} SMS segments` : ""}
                  </span>
                )}
              </div>

              {/* textarea */}
              <textarea
                ref={taRef}
                aria-label="Message template"
                value={tpl}
                onChange={(e) => setTpl(e.target.value)}
                placeholder={fallback || "Leave blank to use the default copy…"}
                className={`${inputCls} flex-1 resize-none font-mono text-sm leading-relaxed`}
                style={{ minHeight: 0 }}
              />

              {/* token chips */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Insert:</span>
                {vars.map((v) => (
                  <button
                    key={v.key}
                    onClick={() => insertVar(v.key)}
                    title={v.label}
                    className="rounded-md border border-white/10 bg-ink px-2 py-1 text-[11px] font-mono text-slate-300 hover:border-brand/40 hover:text-cyan-glow"
                  >
                    {`{{${v.key}}}`}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="h-full overflow-y-auto p-5">
              {doPreview.isPending && (
                <div className="flex items-center gap-2 text-sm text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" /> Rendering…
                </div>
              )}
              {!doPreview.isPending && (
                <div className="grid gap-4 md:grid-cols-3">
                  {/* SMS bubble */}
                  <div>
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">SMS</div>
                    <div className="rounded-2xl bg-[#1c1c1e] p-3 text-sm text-white leading-relaxed max-w-xs shadow-inner">
                      <div className="rounded-xl bg-[#2c2c2e] px-3 py-2 text-[13px] leading-snug">
                        {preview || effective}
                      </div>
                    </div>
                  </div>
                  {/* In-app */}
                  <div>
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">In-app</div>
                    <div className="rounded-xl border border-brand/30 bg-brand/5 p-3 text-sm text-slate-200 leading-relaxed">
                      {preview || effective}
                    </div>
                  </div>
                  {/* Plain email */}
                  <div>
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Plain email</div>
                    <div className="rounded-xl border border-white/10 bg-ink p-3 font-mono text-[12px] text-slate-300 leading-relaxed whitespace-pre-wrap">
                      {preview || effective}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* footer */}
        <div className="flex items-center justify-between border-t border-white/10 px-5 py-3">
          <button
            onClick={() => { onReset(); setTpl(""); }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-ink px-3 py-1.5 text-xs font-semibold text-slate-400 hover:text-white"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Use default
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-white/10 bg-ink px-4 py-1.5 text-xs font-semibold text-slate-400 hover:text-white"
            >
              Cancel
            </button>
            <BtnPrimary onClick={() => { onSave(tpl); onClose(); }} disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save message"}
            </BtnPrimary>
          </div>
        </div>
      </div>
    </div>
  );
}

function RecipientCard({
  rule, recipientLabel, fallback, vars, onSave, saving, eventLabel,
}: {
  rule: any; recipientLabel: string; fallback: string;
  vars: { key: string; label: string }[];
  onSave: (body: any) => void; saving: boolean; eventLabel: string;
}) {
  const [composerOpen, setComposerOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);

  const parsedDesign: EmailBlock[] = (() => {
    try { const d = JSON.parse(rule.emailDesign || "[]"); return Array.isArray(d) && d.length ? d : []; } catch { return []; }
  })();
  const hasDesign = parsedDesign.length > 0;

  const tpl: string = rule.template || "";
  const effective = tpl || fallback;
  const emailMode: "html" | "text" = hasDesign ? "html" : "text";
  const smsOn = !!rule.sms;
  const charCount = effective.length;
  const smsSegments = charCount === 0 ? 0 : Math.ceil(charCount / 160);

  return (
    <div className="rounded-2xl border border-white/5 nvc-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold text-white">{recipientLabel}</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {CHANNELS.map((ch) => {
            const on = rule[ch.key];
            return (
              <button
                key={ch.key}
                title={`${on ? "Disable" : "Enable"} ${ch.label}`}
                onClick={() => onSave({ [ch.key]: !on })}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition ${
                  on ? "border-brand/50 bg-brand/20 text-cyan-glow" : "border-white/5 bg-ink text-slate-500 hover:text-slate-300 hover:border-white/10"
                }`}
              >
                <ch.icon className="h-3.5 w-3.5" /> {ch.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* EMAIL format chooser */}
      {rule.email && (
        <div className="mb-3 rounded-xl border border-brand/30 bg-brand/5 p-3">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            <Mail className="h-3.5 w-3.5" /> Email format
          </div>
          <div className="mb-2.5 inline-flex rounded-lg border border-white/10 bg-ink p-1">
            <button
              onClick={() => hasDesign && onSave({ emailDesign: "" })}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${emailMode === "text" ? "bg-brand text-white" : "text-slate-400 hover:text-white"}`}
            >
              <AlignLeft className="h-3.5 w-3.5" /> Plain text
            </button>
            <button
              onClick={() => !hasDesign && setEmailOpen(true)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${emailMode === "html" ? "bg-brand text-white" : "text-slate-400 hover:text-white"}`}
            >
              <Sparkles className="h-3.5 w-3.5" /> Branded HTML
            </button>
          </div>
          {emailMode === "html" ? (
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1 text-[11px] text-slate-400">
                Sends a designed HTML email &middot; <span className="text-slate-300">{parsedDesign.length} block{parsedDesign.length > 1 ? "s" : ""}</span>
                {rule.emailSubject ? <> &middot; subject "{rule.emailSubject}"</> : null}
              </div>
              <button onClick={() => setEmailOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-bold text-white hover:bg-brand-deep">
                <Pencil className="h-3.5 w-3.5" /> Edit design
              </button>
              <button onClick={() => onSave({ emailDesign: "" })} title="Switch back to plain text" className="rounded-lg border border-white/10 bg-ink px-2.5 py-1.5 text-[11px] font-semibold text-slate-400 hover:text-red-400">Discard design</button>
            </div>
          ) : (
            <p className="text-[11px] text-slate-400">Email uses the <span className="text-slate-200">plain-text message below</span> — same copy as SMS / in-app. Switch to Branded HTML for a designed layout with logo, buttons and tables.</p>
          )}
        </div>
      )}

      {/* message preview row + edit button */}
      <div className="flex items-start gap-3 rounded-xl border border-white/5 bg-ink/60 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Message text
            <span className="font-medium normal-case text-slate-600">
              {[rule.sms && "SMS", rule.inApp && "in-app", rule.email && emailMode === "text" && "email"].filter(Boolean).join(" \u00b7 ") || "fallback only"}
            </span>
            {smsOn && (
              <span className={`ml-auto font-mono text-[10px] ${charCount > 160 ? "text-amber-400" : "text-slate-500"}`}>
                {charCount} char{smsSegments > 1 ? ` \u00b7 ${smsSegments} SMS` : ""}
              </span>
            )}
          </div>
          <p className={`line-clamp-2 text-sm leading-snug ${tpl ? "text-slate-200" : "italic text-slate-500"}`}>
            {tpl || fallback || "No default copy."}
          </p>
          {!tpl && <p className="mt-0.5 text-[10px] text-slate-600">Using default copy</p>}
        </div>
        <button
          onClick={() => setComposerOpen(true)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-ink px-3 py-1.5 text-xs font-semibold text-slate-300 hover:border-brand/40 hover:text-cyan-glow"
        >
          <PenLine className="h-3.5 w-3.5" /> Edit
        </button>
      </div>

      {composerOpen && (
        <MessageComposer
          value={tpl}
          fallback={fallback}
          vars={vars}
          smsOn={smsOn}
          contextLabel={`${eventLabel} \u2192 ${recipientLabel}`}
          saving={saving}
          onSave={(v) => onSave({ template: v })}
          onReset={() => onSave({ template: "" })}
          onClose={() => setComposerOpen(false)}
        />
      )}

      {emailOpen && (
        <EmailEditor
          contextLabel={`${eventLabel} \u2192 ${recipientLabel}`}
          initialDesign={hasDesign ? parsedDesign : starterDesignForRecipient(rule.recipient, eventLabel)}
          initialSubject={rule.emailSubject || ""}
          saving={saving}
          onSave={(subject, design) => { onSave({ emailSubject: subject, emailDesign: JSON.stringify(design) }); setEmailOpen(false); }}
          onClose={() => setEmailOpen(false)}
        />
      )}
    </div>
  );
}


/* token palette for default body templates (matches backend TEMPLATE_VARS) */
const BODY_TOKENS: { key: string; label: string }[] = [
  { key: "firstName", label: "Customer first name" },
  { key: "address", label: "Job address" },
  { key: "jobName", label: "Job name" },
  { key: "jobNumber", label: "Job number" },
  { key: "company", label: "Company name" },
  { key: "service", label: "Service name" },
  { key: "techName", label: "Technician name" },
  { key: "when", label: "Scheduled date/time" },
  { key: "price", label: "Price" },
  { key: "trackUrl", label: "Tracking link" },
];

function BodyTemplateCard({
  icon: Icon, title, hint, value, onChange, rows, placeholder,
}: {
  icon: any; title: string; hint: string; value: string;
  onChange: (v: string) => void; rows: number; placeholder: string;
}) {
  const insert = (k: string) => onChange((value ? value + " " : "") + `{{${k}}}`);
  const { noun: customerNoun } = useCustomerNoun();
  const tokenLabel = (t: { key: string; label: string }) => (t.key === "firstName" ? `${customerNoun} first name` : t.label);
  return (
    <div className="rounded-2xl border border-white/5 nvc-card p-5">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-300"><Icon className="h-4 w-4" /> {title}</h3>
      <p className="mb-3 text-[11px] text-slate-500">{hint}</p>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Insert:</span>
        {BODY_TOKENS.map((t) => (
          <button
            key={t.key}
            onClick={() => insert(t.key)}
            title={tokenLabel(t)}
            className="rounded-md border border-white/10 bg-ink px-2 py-1 text-[11px] font-mono text-slate-300 hover:border-brand/40 hover:text-cyan-glow"
          >
            {`{{${t.key}}}`}
          </button>
        ))}
      </div>
      <textarea aria-label={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className={`${inputCls} font-mono text-xs leading-relaxed`}
      />
    </div>
  );
}

/* ---------------- Email brand identity card ---------------- */
function EmailBrandCard({ f, set }: { f: any; set: (k: string, v: any) => void }) {
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const logo = f.emailLogoUrl || "";
  const color = f.emailBrandColor || "#06B6D4";
  const headerStyle = f.emailHeaderStyle || "gradient";

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/notif-config/email/logo", { method: "POST", body: fd, credentials: "include", headers: apiHeaders() });
      const d = await res.json();
      if (d.url) set("emailLogoUrl", d.url);
    } finally { setUploading(false); }
  };

  const styles = [
    { key: "gradient", label: "Gradient" },
    { key: "solid", label: "Solid" },
    { key: "minimal", label: "Minimal (white)" },
  ];

  return (
    <div className="rounded-2xl border border-white/5 nvc-card p-5">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-300"><Palette className="h-4 w-4" /> Email branding</h3>
      <p className="mb-4 text-[11px] text-slate-500">Logo, color, and header style applied to every branded HTML email.</p>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* logo */}
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Header logo</div>
          <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-ink p-3">
            <div className="grid h-14 w-24 place-items-center rounded-lg bg-white/90 p-1">
              {logo ? <img src={logo} alt="logo" className="max-h-12 max-w-full object-contain" /> : <span className="text-[10px] text-slate-400">No logo</span>}
            </div>
            <div className="flex-1 space-y-1.5">
              <button onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-bold text-white hover:bg-brand-deep">
                <ImageIcon className="h-3.5 w-3.5" /> {uploading ? "Uploading…" : "Upload"}
              </button>
              {logo && <button onClick={() => set("emailLogoUrl", "")} className="ml-1.5 text-[11px] font-semibold text-slate-400 hover:text-red-400">Remove</button>}
            </div>
          </div>
          <input aria-label="…or paste a logo URL" className={`${inputCls} mt-1.5 text-xs`} value={logo} onChange={(e) => set("emailLogoUrl", e.target.value)} placeholder="…or paste a logo URL" />
          <input aria-label="File upload" ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </div>

        {/* color + style */}
        <div className="space-y-3">
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Brand color</div>
            <div className="flex items-center gap-2">
              <input aria-label="Color" type="color" value={color} onChange={(e) => set("emailBrandColor", e.target.value)} className="h-10 w-12 cursor-pointer rounded-lg border border-white/10 bg-ink p-1" />
              <input aria-label="#06B6D4" className={inputCls} value={color} onChange={(e) => set("emailBrandColor", e.target.value)} placeholder="#06B6D4" />
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Header style</div>
            <div className="flex gap-1.5">
              {styles.map((s) => (
                <button key={s.key} onClick={() => set("emailHeaderStyle", s.key)} className={`flex-1 rounded-lg border px-2 py-2 text-[11px] font-semibold ${headerStyle === s.key ? "border-brand/50 bg-brand/15 text-cyan-glow" : "border-white/10 bg-ink text-slate-400 hover:text-white"}`}>{s.label}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* mini header preview */}
      <div className="mt-4 overflow-hidden rounded-xl border border-white/10">
        <div className="px-4 py-5 text-center" style={{
          background: headerStyle === "gradient" ? `linear-gradient(135deg, ${color}, ${color}cc)` : headerStyle === "solid" ? color : "#ffffff",
          borderBottom: headerStyle === "minimal" ? "1px solid #e2e8f0" : "none",
        }}>
          {logo ? <img src={logo} alt="" className="mx-auto max-h-9" /> : <span className="text-lg font-extrabold" style={{ color: headerStyle === "minimal" ? "#0f172a" : "#fff" }}>{f.emailFromName || "NVC 360"}</span>}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Email sender identity card (per-tenant From/Reply-to + test send) ---------------- */
function EmailSenderCard({ f, set, onSave, saving, dirty }: { f: any; set: (k: string, v: any) => void; onSave: () => void; saving: boolean; dirty: boolean }) {
  const qc = useQueryClient();
  const [testTo, setTestTo] = useState("dan@nvc360.com");
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [newDomain, setNewDomain] = useState("");
  const [domErr, setDomErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const fromName = (f.emailFromName || "").trim();
  const fromAddr = (f.emailFromAddress || "").trim();
  const fromLine = fromAddr ? (fromName ? `${fromName} <${fromAddr}>` : fromAddr) : "(not set — shared sender used)";
  const domain = fromAddr.includes("@") ? fromAddr.split("@")[1] : "yourdomain.com";

  const domainsQ = useQuery({
    queryKey: ["email-domains"],
    queryFn: async () => {
      const res = await (api["notif-config"] as any)["email-domains"].$get();
      return res.json() as Promise<{ domains: any[]; resendAvailable: boolean }>;
    },
  });
  const domains = domainsQ.data?.domains || [];
  const fromDomainVerified = domains.some(
    (d: any) => d.status === "verified" && d.domain.toLowerCase() === domain.toLowerCase(),
  );

  const addDomain = useMutation({
    mutationFn: async (dom: string) => {
      const res = await (api["notif-config"] as any)["email-domains"].$post({ json: { domain: dom } });
      const body = await res.json();
      if (!res.ok) throw new Error((body as any)?.message || "Failed");
      return body;
    },
    onSuccess: () => { setNewDomain(""); setDomErr(null); qc.invalidateQueries({ queryKey: ["email-domains"] }); },
    onError: (e: any) => setDomErr(e?.message || "Failed to submit"),
  });
  const checkDomain = useMutation({
    mutationFn: async (id: string) => {
      const res = await (api["notif-config"] as any)["email-domains"][":id"].check.$post({ param: { id } });
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["email-domains"] }),
  });
  const delDomain = useMutation({
    mutationFn: async (id: string) => {
      const res = await (api["notif-config"] as any)["email-domains"][":id"].$delete({ param: { id } });
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["email-domains"] }),
  });
  const copy = (txt: string, key: string) => {
    navigator.clipboard?.writeText(txt).then(() => { setCopied(key); setTimeout(() => setCopied(null), 1500); });
  };
  const statusBadge = (s: string) => {
    const map: Record<string, string> = {
      verified: "bg-green-500/15 text-green-400 border-green-500/30",
      verifying: "bg-amber-500/15 text-amber-400 border-amber-500/30",
      pending: "bg-slate-500/15 text-slate-300 border-slate-500/30",
      failed: "bg-red-500/15 text-red-400 border-red-500/30",
    };
    const label: Record<string, string> = { verified: "Verified", verifying: "Verifying DNS…", pending: "Pending approval", failed: "Failed" };
    return <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${map[s] || map.pending}`}>{label[s] || s}</span>;
  };

  const sendTest = useMutation({
    mutationFn: async () => {
      const design = [
        { id: "h", type: "heading", text: "Test email from your NVC 360 sender" },
        { id: "p", type: "text", text: `If you can read this, your "From" identity (${fromLine}) is delivering correctly.` },
      ];
      const res = await api["notif-config"].email.test.$post({ json: { to: testTo, subject: "NVC 360 sender test", design } });
      return res.json() as any;
    },
    onSuccess: (r: any) => {
      if (r?.ok) setTestMsg({ ok: true, text: `Sent to ${testTo}. Check the inbox (and spam).` });
      else if (r?.skipped) setTestMsg({ ok: false, text: "Email is disabled or no API key — enable email + configure Resend first." });
      else setTestMsg({ ok: false, text: r?.error || "Send failed — usually means the From domain isn't verified in Resend." });
    },
    onError: () => setTestMsg({ ok: false, text: "Request failed. Try again." }),
  });

  return (
    <div className="rounded-2xl border border-white/5 nvc-card p-5">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-300"><Mail className="h-4 w-4" /> Email sender</h3>
      <p className="mb-3 text-xs text-slate-500">Controls the From name, address and Reply-to on every outgoing email for this company.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From name"><input aria-label="NVC360" className={inputCls} value={f.emailFromName ?? ""} onChange={(e) => set("emailFromName", e.target.value)} placeholder="NVC360" /></Field>
        <Field label="From address"><input aria-label="contact@nvc360.com" className={inputCls} value={f.emailFromAddress ?? ""} onChange={(e) => set("emailFromAddress", e.target.value)} placeholder="contact@nvc360.com" /></Field>
        <Field label="Reply-to"><input aria-label="contact@nvc360.com" className={inputCls} value={f.emailReplyTo ?? ""} onChange={(e) => set("emailReplyTo", e.target.value)} placeholder="contact@nvc360.com" /></Field>
        <Field label="Footer line"><input aria-label="NVC 360 · 423 Main St, Winnipeg" className={inputCls} value={f.emailFooter ?? ""} onChange={(e) => set("emailFooter", e.target.value)} placeholder="NVC 360 · 423 Main St, Winnipeg" /></Field>
      </div>

      {/* live From: preview */}
      <div className="mt-3 rounded-xl border border-white/5 bg-ink px-3.5 py-2.5">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Recipients will see</div>
        <div className="mt-0.5 font-mono text-sm text-cyan-glow">From: {fromLine}</div>
        {f.emailReplyTo ? <div className="font-mono text-[11px] text-slate-500">Reply-To: {f.emailReplyTo}</div> : null}
      </div>

      {/* domain-verified warning */}
      {fromAddr.includes("@") && !domain.endsWith("resend.dev") && !fromDomainVerified && (
        <p className="mt-2 text-[11px] text-amber-400/90">
          ⚠ Until <span className="font-semibold">{domain}</span> is verified below, emails are sent from our shared address. Add it and complete DNS to send as <span className="font-mono">{fromAddr}</span>.
        </p>
      )}
      {fromDomainVerified && (
        <p className="mt-2 text-[11px] text-green-400/90">✓ {domain} is verified — emails send as your own address.</p>
      )}

      {/* ---- live sending-domain manager ---- */}
      <div className="mt-4 border-t border-white/5 pt-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Sending domains</span>
          {domainsQ.data && !domainsQ.data.resendAvailable && (
            <span className="text-[10px] text-amber-400">Email service not configured</span>
          )}
        </div>

        {/* submit a domain */}
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="mail.yourdomain.com"
            className={`${inputCls} max-w-xs flex-1`}
            value={newDomain}
            onChange={(e) => { setNewDomain(e.target.value); setDomErr(null); }}
            placeholder={domain !== "yourdomain.com" ? domain : "mail.yourdomain.com"}
          />
          <BtnGhost
            onClick={() => newDomain.trim() && addDomain.mutate(newDomain.trim())}
            disabled={addDomain.isPending || !newDomain.trim()}
          >
            {addDomain.isPending ? "Submitting…" : "Add domain"}
          </BtnGhost>
        </div>
        {domErr && <p className="mt-1.5 text-[11px] font-semibold text-amber-400">{domErr}</p>}
        <p className="mt-1.5 text-[11px] text-slate-600">
          Submit the domain you want to send from. Once approved, the exact DNS records appear here — add them at your registrar (GoDaddy, Namecheap, Cloudflare…). We auto-verify within minutes.
        </p>

        {/* list of domains */}
        <div className="mt-3 space-y-3">
          {domains.length === 0 && (
            <p className="text-[11px] text-slate-600">No domains yet. Add one above to start sending from your own address.</p>
          )}
          {domains.map((d: any) => (
            <div key={d.id} className="rounded-xl border border-white/5 bg-ink p-3.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-slate-200">{d.domain}</span>
                  {statusBadge(d.status)}
                </div>
                <div className="flex items-center gap-2">
                  {d.resendDomainId && d.status !== "verified" && (
                    <button
                      type="button"
                      onClick={() => checkDomain.mutate(d.id)}
                      disabled={checkDomain.isPending}
                      className="rounded-lg border border-white/10 px-2.5 py-1 text-[11px] font-semibold text-slate-300 hover:bg-white/5"
                    >
                      {checkDomain.isPending ? "Checking…" : "Check verification"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => delDomain.mutate(d.id)}
                    className="rounded-lg border border-white/10 px-2 py-1 text-[11px] text-slate-500 hover:bg-white/5 hover:text-red-400"
                    aria-label="Remove domain"
                  >
                    Remove
                  </button>
                </div>
              </div>

              {d.status === "pending" && !d.resendDomainId && (
                <p className="mt-2 text-[11px] text-slate-500">Submitted — waiting for an administrator to approve and generate your DNS records.</p>
              )}

              {Array.isArray(d.records) && d.records.length > 0 && (
                <div className="mt-3 space-y-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Add these DNS records</div>
                  {d.records.map((r: any, i: number) => (
                    <div key={i} className="rounded-lg border border-white/5 bg-black/30 p-2.5">
                      <div className="mb-1 flex items-center gap-2">
                        <span className="text-[10px] font-semibold text-cyan-glow">{r.record || r.type}</span>
                        <span className="text-[10px] text-slate-500">{r.type}</span>
                        {r.priority != null && <span className="text-[10px] text-slate-500">priority {r.priority}</span>}
                        {r.status && r.status.toLowerCase() === "verified" && <span className="text-[10px] text-green-400">✓ live</span>}
                      </div>
                      <RecordRow label="Name" value={r.name} copied={copied === `${d.id}-${i}-name`} onCopy={() => copy(r.name, `${d.id}-${i}-name`)} />
                      <RecordRow label="Value" value={r.value} copied={copied === `${d.id}-${i}-val`} onCopy={() => copy(r.value, `${d.id}-${i}-val`)} />
                    </div>
                  ))}
                  <p className="text-[11px] text-slate-600">
                    DNS usually propagates in 5–30 min (up to 24h). The MX/SPF sit on a subdomain and won’t affect your normal inbox.
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* inline test send */}
      <div className="mt-4 border-t border-white/5 pt-4">
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Send a test</div>
        <div className="flex flex-wrap items-center gap-2">
          <input aria-label="dan@nvc360.com"
            className={`${inputCls} max-w-xs flex-1`}
            type="email"
            value={testTo}
            onChange={(e) => { setTestTo(e.target.value); setTestMsg(null); }}
            placeholder="dan@nvc360.com"
          />
          <BtnGhost
            onClick={async () => { if (dirty) onSave(); sendTest.mutate(); }}
            disabled={sendTest.isPending || saving || !testTo.includes("@")}
          >
            <Send className="h-4 w-4" /> {sendTest.isPending ? "Sending…" : "Send test email"}
          </BtnGhost>
        </div>
        <p className="mt-1.5 text-[11px] text-slate-600">Saves current settings first, then sends using this exact sender identity.</p>
        {testMsg && (
          <p className={`mt-1.5 text-[11px] font-semibold ${testMsg.ok ? "text-green-400" : "text-amber-400"}`}>{testMsg.text}</p>
        )}
      </div>
    </div>
  );
}

/* one copyable DNS record field */
function RecordRow({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className="w-12 shrink-0 pt-0.5 text-[10px] font-semibold uppercase text-slate-500">{label}</span>
      <code className="min-w-0 flex-1 break-all font-mono text-[10.5px] text-slate-300">{value}</code>
      <button
        type="button"
        onClick={onCopy}
        className="shrink-0 rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-white/5"
        aria-label={`Copy ${label}`}
      >
        {copied ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  );
}

/* ---------------- Channels (sender identity, master switches, quiet hours) ---------------- */
function Channels() {
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ["notif-channels"], queryFn: async () => (await api["notif-config"].channels.$get()).json() });
  const [form, setForm] = useState<any>(null);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: async (body: any) => (await api["notif-config"].channels.$patch({ json: body })).json(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["notif-channels"] }); setSaved(true); setTimeout(() => setSaved(false), 1800); },
  });

  if (cfg.isLoading) return <FullLoader label="Loading channel settings…" />;
  const data = (cfg.data as any)?.channels;
  const f = form ?? data;
  const set = (k: string, v: any) => setForm({ ...f, [k]: v });

  const masters: { key: string; label: string; icon: any; desc: string }[] = [
    { key: "inAppEnabled", label: "In-app", icon: Smartphone, desc: "Push + bell notifications" },
    { key: "emailEnabled", label: "Email", icon: Mail, desc: "Transactional email via Resend" },
    { key: "smsEnabled", label: "SMS", icon: MessageSquare, desc: "Text messages via Twilio" },
    { key: "webhookEnabled", label: "Webhooks", icon: Globe, desc: "Outbound HTTP POSTs" },
  ];

  const industryGuidance = useIndustryNotificationGuidance();

  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-400">Global delivery configuration. Master switches and quiet hours apply on top of every per-event rule.</p>

      {industryGuidance && (
        <div className="flex items-start gap-2.5 rounded-2xl border border-brand/20 bg-brand/5 p-4 text-sm text-cyan-100">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-cyan-glow" />
          <div>
            <span className="font-semibold text-cyan-glow">Recommended for your industry: </span>
            {industryGuidance}
          </div>
        </div>
      )}

      {/* master switches */}
      <div className="rounded-2xl border border-white/5 nvc-card p-5">
        <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-300">Channel master switches</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {masters.map((m) => {
            const on = f[m.key];
            return (
              <button
                key={m.key}
                onClick={() => set(m.key, !on)}
                aria-label={m.label}
                className={`flex items-center gap-3 rounded-xl border p-3 text-left transition ${
                  on ? "border-brand/40 bg-brand/10" : "border-white/5 bg-ink hover:border-white/10"
                }`}
              >
                <div className={`grid h-10 w-10 place-items-center rounded-lg ${on ? "bg-brand/20 text-cyan-glow" : "bg-white/5 text-slate-600"}`}>
                  <m.icon className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-white">{m.label}</div>
                  <div className="text-[11px] text-slate-500">{m.desc}</div>
                </div>
                <div className={`h-6 w-11 rounded-full p-0.5 transition ${on ? "bg-brand" : "bg-white/10"}`}>
                  <div className={`h-5 w-5 rounded-full bg-white transition ${on ? "translate-x-5" : ""}`} />
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* email sender */}
      <EmailSenderCard f={f} set={set} onSave={() => save.mutate(f)} saving={save.isPending} dirty={!!form} />


      {/* email brand identity (logo, color, header style) */}
      <EmailBrandCard f={f} set={set} />

      {/* email default body template */}
      <BodyTemplateCard
        icon={Mail}
        title="Email body template"
        hint="Default message body for transactional emails. Per-event copy in the Rules tab overrides this. Insert tokens with the chips below."
        value={f.emailBodyTemplate ?? ""}
        onChange={(v) => set("emailBodyTemplate", v)}
        rows={5}
        placeholder={"Hi {{firstName}},\n\nYour job {{jobName}} (#{{jobNumber}}) at {{address}} has an update.\n\n— {{company}}"}
      />

      {/* sms sender */}
      <div className="rounded-2xl border border-white/5 nvc-card p-5">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-300"><MessageSquare className="h-4 w-4" /> SMS sender</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From number"><input aria-label="+1 204 555 0100" className={inputCls} value={f.smsFromNumber} onChange={(e) => set("smsFromNumber", e.target.value)} placeholder="+1 204 555 0100" /></Field>
          <Field label="Sender ID (alphanumeric, where supported)"><input aria-label="NVC360" className={inputCls} value={f.smsSenderId} onChange={(e) => set("smsSenderId", e.target.value)} placeholder="NVC360" /></Field>
        </div>
      </div>

      {/* sms default body template */}
      <BodyTemplateCard
        icon={MessageSquare}
        title="SMS body template"
        hint="Default SMS body. Keep it short — tokens expand to live job data."
        value={f.smsBodyTemplate ?? ""}
        onChange={(v) => set("smsBodyTemplate", v)}
        rows={3}
        placeholder={"{{company}}: Hi {{firstName}}, update on {{jobName}} #{{jobNumber}} at {{address}}."}
      />

      {/* quiet hours */}
      <div className="rounded-2xl border border-white/5 nvc-card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-300"><Moon className="h-4 w-4" /> Quiet hours</h3>
          <button onClick={() => set("quietHoursEnabled", !f.quietHoursEnabled)} aria-label="Toggle quiet hours" className={`h-6 w-11 rounded-full p-0.5 transition ${f.quietHoursEnabled ? "bg-brand" : "bg-white/10"}`}>
            <div className={`h-5 w-5 rounded-full bg-white transition ${f.quietHoursEnabled ? "translate-x-5" : ""}`} />
          </button>
        </div>
        <p className="mb-3 text-xs text-slate-500">Suppress selected channels overnight. In-app notifications always queue regardless.</p>
        <div className={`grid gap-3 sm:grid-cols-2 ${f.quietHoursEnabled ? "" : "pointer-events-none opacity-40"}`}>
          <Field label="Start"><input aria-label="Quiet Start" type="time" className={inputCls} value={f.quietStart} onChange={(e) => set("quietStart", e.target.value)} /></Field>
          <Field label="End"><input aria-label="Quiet End" type="time" className={inputCls} value={f.quietEnd} onChange={(e) => set("quietEnd", e.target.value)} /></Field>
        </div>
        <div className={`mt-3 ${f.quietHoursEnabled ? "" : "pointer-events-none opacity-40"}`}>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Channels affected</div>
          <div className="flex flex-wrap gap-2">
            {CHANNELS.map((ch) => {
              const list = (f.quietChannels || "").split(",").map((s: string) => s.trim()).filter(Boolean);
              const on = list.includes(ch.key);
              return (
                <button
                  key={ch.key}
                  onClick={() => {
                    const next = on ? list.filter((x: string) => x !== ch.key) : [...list, ch.key];
                    set("quietChannels", next.join(","));
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                    on ? "border-brand/40 bg-brand/15 text-cyan-glow" : "border-white/10 bg-ink text-slate-500 hover:text-slate-300"
                  }`}
                >
                  <ch.icon className="h-3.5 w-3.5" /> {ch.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-3">
        {saved && <span className="text-xs font-semibold text-green-400">Saved</span>}
        <BtnPrimary onClick={() => save.mutate(f)} disabled={save.isPending || !form}>{save.isPending ? "Saving…" : "Save settings"}</BtnPrimary>
      </div>
    </div>
  );
}

/* ---------------- Webhooks ---------------- */
function Webhooks() {
  const qc = useQueryClient();
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ label: "", url: "", secret: "", events: "*" });
  const [del, setDel] = useState<string | null>(null);

  const list = useQuery({ queryKey: ["webhooks"], queryFn: async () => (await api["notif-config"].webhooks.$get()).json() });
  const create = useMutation({
    mutationFn: async () => (await api["notif-config"].webhooks.$post({ json: form })).json(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["webhooks"] }); setModal(false); setForm({ label: "", url: "", secret: "", events: "*" }); },
  });
  const toggle = useMutation({
    mutationFn: async (p: { id: string; active: boolean }) => (await api["notif-config"].webhooks[":id"].$patch({ param: { id: p.id }, json: { active: p.active } })).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["webhooks"] }),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => (await api["notif-config"].webhooks[":id"].$delete({ param: { id } })).json(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["webhooks"] }); setDel(null); },
  });
  const ping = useMutation({
    mutationFn: async (id: string) => (await api["notif-config"].webhooks[":id"].test.$post({ param: { id } })).json(),
  });

  if (list.isLoading) return <FullLoader label="Loading webhooks…" />;
  const hooks = (list.data as any)?.webhooks ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-400">POST endpoints that receive event payloads (Zapier, Make, your CRM, Slack relays…).</p>
        <BtnPrimary onClick={() => setModal(true)}><Plus className="h-4 w-4" /> Add webhook</BtnPrimary>
      </div>
      {hooks.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-sm text-slate-500">No webhooks yet.</div>
      ) : (
        <div className="space-y-2.5">
          {hooks.map((h: any) => (
            <div key={h.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/5 nvc-card p-4">
              <div className={`grid h-10 w-10 place-items-center rounded-xl ${h.active ? "bg-brand/20 text-cyan-glow" : "bg-white/5 text-slate-600"}`}>
                <Webhook className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-white">{h.label || "Webhook"}</div>
                <div className="truncate text-xs text-slate-500">{h.url}</div>
                <div className="mt-1 text-[11px] text-slate-600">Events: {h.events === "*" ? "all" : h.events}</div>
              </div>
              <button onClick={() => ping.mutate(h.id)} className="rounded-lg border border-white/10 bg-ink px-3 py-1.5 text-xs font-semibold text-slate-300 hover:text-cyan-glow">
                {ping.isPending ? "…" : "Test"}
              </button>
              <button onClick={() => toggle.mutate({ id: h.id, active: !h.active })} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${h.active ? "bg-green-500/15 text-green-400" : "bg-white/5 text-slate-500"}`}>
                {h.active ? "Active" : "Paused"}
              </button>
              <button onClick={() => setDel(h.id)} className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-red-500/10 hover:text-red-400">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
      {ping.data && (
        <p className={`text-xs ${(ping.data as any).ok ? "text-green-400" : "text-red-400"}`}>
          Test {(ping.data as any).ok ? `OK (HTTP ${(ping.data as any).status})` : `failed: ${(ping.data as any).error || (ping.data as any).status}`}
        </p>
      )}

      <Modal open={modal} onClose={() => setModal(false)} title="Add webhook">
        <div className="space-y-3">
          <Field label="Label"><input aria-label="My CRM" className={inputCls} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="My CRM" /></Field>
          <Field label="POST URL"><input aria-label="https://hooks.example.com/nvc" className={inputCls} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://hooks.example.com/nvc" /></Field>
          <Field label="Secret (sent as X-Webhook-Secret)"><input aria-label="optional" className={inputCls} value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} placeholder="optional" /></Field>
          <Field label="Events (comma-separated, or * for all)"><input aria-label="*" className={inputCls} value={form.events} onChange={(e) => setForm({ ...form, events: e.target.value })} placeholder="*" /></Field>
          <div className="flex justify-end gap-2 pt-1">
            <BtnGhost onClick={() => setModal(false)}>Cancel</BtnGhost>
            <BtnPrimary onClick={() => create.mutate()} disabled={!form.url || create.isPending}>{create.isPending ? "Saving…" : "Add webhook"}</BtnPrimary>
          </div>
        </div>
      </Modal>
      <ConfirmModal open={!!del} onClose={() => setDel(null)} onConfirm={() => del && remove.mutate(del)} title="Delete webhook?" message="This endpoint will stop receiving events." />
    </div>
  );
}

/* ---------------- Technician invites ---------------- */
function Invites() {
  const qc = useQueryClient();
  const { noun, nounPlural } = useWorkerNoun();
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", phone: "", skillClass: "General" });
  const [copied, setCopied] = useState<string | null>(null);

  const list = useQuery({ queryKey: ["invites"], queryFn: async () => (await api.invites.$get()).json() });
  const create = useMutation({
    mutationFn: async () => (await api.invites.$post({ json: form })).json(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["invites"] }); setModal(false); setForm({ name: "", email: "", phone: "", skillClass: "General" }); },
  });
  const resend = useMutation({ mutationFn: async (id: string) => (await api.invites[":id"].resend.$post({ param: { id } })).json() });
  const revoke = useMutation({
    mutationFn: async (id: string) => (await api.invites[":id"].revoke.$post({ param: { id } })).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invites"] }),
  });

  if (list.isLoading) return <FullLoader label="Loading invites…" />;
  const invites = (list.data as any)?.invites ?? [];
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-400">Invite-only onboarding. {nounPlural} get an email + SMS link to set their password and go active.</p>
        <BtnPrimary onClick={() => setModal(true)}><UserPlus className="h-4 w-4" /> Invite {noun.toLowerCase()}</BtnPrimary>
      </div>
      {invites.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-sm text-slate-500">No invites sent yet.</div>
      ) : (
        <div className="space-y-2.5">
          {invites.map((i: any) => {
            const link = `${origin}/join/${i.token}`;
            return (
              <div key={i.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/5 nvc-card p-4">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-white">{i.name || i.email}</div>
                  <div className="truncate text-xs text-slate-500">{i.email} · {i.skillClass}{i.phone ? ` · ${i.phone}` : ""}</div>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
                  i.status === "accepted" ? "bg-green-500/15 text-green-400" : i.status === "revoked" ? "bg-red-500/10 text-red-400" : "bg-amber-500/15 text-amber-400"
                }`}>{i.status}</span>
                {i.status === "pending" && (
                  <>
                    <button onClick={() => { navigator.clipboard?.writeText(link); setCopied(i.id); setTimeout(() => setCopied(null), 1500); }} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-ink px-3 py-1.5 text-xs font-semibold text-slate-300 hover:text-cyan-glow">
                      <Copy className="h-3.5 w-3.5" /> {copied === i.id ? "Copied!" : "Copy link"}
                    </button>
                    <button onClick={() => resend.mutate(i.id)} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-ink px-3 py-1.5 text-xs font-semibold text-slate-300 hover:text-cyan-glow">
                      <RefreshCw className="h-3.5 w-3.5" /> Resend
                    </button>
                    <button onClick={() => revoke.mutate(i.id)} className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-red-500/10 hover:text-red-400"><X className="h-4 w-4" /></button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Modal open={modal} onClose={() => setModal(false)} title={`Invite ${noun.toLowerCase()}`}>
        <div className="space-y-3">
          <Field label="Name"><input aria-label="Jordan Lee" className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Jordan Lee" /></Field>
          <Field label="Email *"><input aria-label="jordan@email.com" className={inputCls} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="jordan@email.com" /></Field>
          <Field label="Phone (for SMS invite)"><input aria-label="+1 204 555 0199" className={inputCls} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+1 204 555 0199" /></Field>
          <Field label="Skill class">
            <select className={inputCls} value={form.skillClass} onChange={(e) => setForm({ ...form, skillClass: e.target.value })}>
              {["General", "HVAC", "Electrical", "Plumbing", "Appliance", "Landscaping"].map((s) => <option key={s}>{s}</option>)}
            </select>
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <BtnGhost onClick={() => setModal(false)}>Cancel</BtnGhost>
            <BtnPrimary onClick={() => create.mutate()} disabled={!form.email || create.isPending}>{create.isPending ? "Sending…" : "Send invite"}</BtnPrimary>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/* ---------------- Delivery log ---------------- */
const CHAN_ICON: Record<string, any> = { in_app: Smartphone, email: Mail, sms: MessageSquare, webhook: Globe };
function DeliveryLog() {
  const list = useQuery({
    queryKey: ["notif-deliveries"],
    queryFn: async () => (await api["notif-config"].deliveries.$get({ query: {} })).json(),
    refetchInterval: 5000,
  });
  if (list.isLoading) return <FullLoader label="Loading log…" />;
  const rows = (list.data as any)?.deliveries ?? [];
  return (
    <div className="overflow-x-auto rounded-2xl border border-white/5 nvc-card">
      <table className="w-full min-w-[680px] text-sm">
        <thead>
          <tr className="border-b border-white/5 bg-ink/40 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="px-4 py-3 font-semibold">When</th>
            <th className="px-4 py-3 font-semibold">Event</th>
            <th className="px-4 py-3 font-semibold">To</th>
            <th className="px-4 py-3 font-semibold">Channel</th>
            <th className="px-4 py-3 font-semibold">Target</th>
            <th className="px-4 py-3 font-semibold">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-500">No deliveries yet. Fire a test from the Rules tab.</td></tr>
          ) : rows.map((r: any) => {
            const Icon = CHAN_ICON[r.channel] ?? Bell;
            return (
              <tr key={r.id} className="border-b border-white/5 last:border-0">
                <td className="px-4 py-3 whitespace-nowrap text-xs text-slate-500">{new Date(r.createdAt).toLocaleString()}</td>
                <td className="px-4 py-3 font-medium text-white">{r.event}</td>
                <td className="px-4 py-3 capitalize text-slate-300">{r.recipient}</td>
                <td className="px-4 py-3"><span className="inline-flex items-center gap-1.5 text-slate-300"><Icon className="h-3.5 w-3.5" /> {r.channel}</span></td>
                <td className="px-4 py-3 max-w-[200px] truncate text-xs text-slate-500">{r.target}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${
                    r.status === "sent" ? "bg-green-500/15 text-green-400" : r.status === "skipped" ? "bg-slate-500/15 text-slate-400" : "bg-red-500/10 text-red-400"
                  }`}>
                    {r.status === "sent" ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />} {r.status}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
