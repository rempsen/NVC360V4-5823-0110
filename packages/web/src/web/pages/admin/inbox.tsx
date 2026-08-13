/**
 * Unified inbox — every conversation in the tenant on one screen.
 *
 * Three streams in one list:
 *   · client    — job threads, including messages the homeowner sent from the
 *                 public /t/:token tracking page (they have no login)
 *   · tech      — direct dispatcher <-> technician threads
 *   · broadcast — outbound sends to groups of techs (read-only here)
 *
 * Real-time rides the existing Redis pub/sub bus via
 * GET /api/messages/inbox/stream — a signal-only SSE channel that just says
 * "something changed, refetch". No parallel realtime system.
 *
 * Read state: fetching a thread NEVER marks it read. Opening a thread is an
 * explicit act, so that's when we POST mark-read — same rule the tech threads
 * already follow.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Inbox as InboxIcon,
  Search,
  Send,
  Loader2,
  User,
  Wrench,
  Megaphone,
  ExternalLink,
  MessageSquare,
} from "lucide-react";
import { apiHeaders } from "../../lib/api";
import { useWorkerNoun, useCustomerNoun, useJobNoun } from "../../lib/use-brand";
import { EmptyState } from "../../components/empty-state";

type Thread = {
  key: string;
  kind: "client" | "tech" | "broadcast";
  title: string;
  subtitle: string;
  bookingId: string | null;
  techId: string | null;
  jobTitle: string | null;
  jobStatus: string | null;
  photoUrl: string | null;
  color: string;
  lastMessage: string | null;
  lastSenderRole: string | null;
  lastAt: number | null;
  unread: number;
  messageCount: number;
};

type Msg = {
  id: string;
  senderRole: string;
  senderName: string;
  body: string;
  createdAt: any;
};

// Timestamps arrive in two shapes depending on the endpoint: the inbox list
// pre-converts to epoch ms, but the raw message rows come back as ISO strings.
// Number("2026-08-07T…") is NaN, which rendered "Invalid Date" in the thread.
function msgTime(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  const d =
    typeof v === "number"
      ? new Date(v)
      : typeof v === "string" && /^\d+$/.test(v)
        ? new Date(Number(v))
        : new Date(v as string);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

function relTime(ts: number | null): string {
  if (!ts) return "";
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return "now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  if (secs < 604800) return `${Math.floor(secs / 86400)}d`;
  return new Date(ts).toLocaleDateString();
}

const KIND_META = {
  client: { icon: User, label: "Clients", tone: "text-cyan-glow" },
  tech: { icon: Wrench, label: "Field", tone: "text-violet-400" },
  broadcast: { icon: Megaphone, label: "Broadcasts", tone: "text-amber-warn" },
} as const;

export default function InboxPage() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const { noun: workerNoun } = useWorkerNoun();
  const { noun: customerNoun } = useCustomerNoun();
  const { noun: jobNoun } = useJobNoun();

  const [filter, setFilter] = useState<"all" | "unread" | "client" | "tech" | "broadcast">("all");
  const [search, setSearch] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // ── Thread list ────────────────────────────────────────────────────────────
  const inbox = useQuery({
    queryKey: ["inbox"],
    queryFn: async () => {
      const res = await fetch("/api/messages/inbox", { headers: apiHeaders() });
      if (!res.ok) throw new Error("Failed to load inbox");
      return (await res.json()) as { threads: Thread[]; counts: Record<string, number> };
    },
    // SSE below pushes instant refetches; this is just a safety net.
    refetchInterval: 60_000,
  });

  // ── Live signal for the whole tenant inbox ────────────────────────────────
  useEffect(() => {
    const es = new EventSource("/api/messages/inbox/stream");
    const onPing = () => {
      qc.invalidateQueries({ queryKey: ["inbox"] });
      qc.invalidateQueries({ queryKey: ["inbox-thread"] });
    };
    es.addEventListener("new-message", onPing);
    es.onerror = () => {
      /* browser auto-reconnects; the 60s poll covers any gap */
    };
    return () => {
      es.removeEventListener("new-message", onPing);
      es.close();
    };
  }, [qc]);

  // Memoised so the `?? []` fallback doesn't hand a brand-new array to the
  // filter/sort memo below on every render (which would defeat it entirely).
  const threads = useMemo(() => inbox.data?.threads ?? [], [inbox.data?.threads]);
  const counts = inbox.data?.counts ?? {};

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = threads.filter((t) => {
      // the thread you're reading stays put even after opening it cleared its
      // unread badge — otherwise the list reshuffles under the cursor
      if (filter === "unread" && t.unread === 0 && t.key !== activeKey) return false;
      if (filter !== "all" && filter !== "unread" && t.kind !== filter) return false;
      if (!q) return true;
      return (
        t.title.toLowerCase().includes(q) ||
        (t.subtitle || "").toLowerCase().includes(q) ||
        (t.jobTitle || "").toLowerCase().includes(q) ||
        (t.lastMessage || "").toLowerCase().includes(q)
      );
    });
    // same rule for ordering: hold the open thread in the unread group so it
    // doesn't jump down the list the moment it's marked read
    const rank = (t: Thread) => (t.unread > 0 || t.key === activeKey ? 1 : 0);
    return [...rows].sort((a, b) => rank(b) - rank(a) || (b.lastAt ?? 0) - (a.lastAt ?? 0));
  }, [threads, filter, search, activeKey]);

  const active = threads.find((t) => t.key === activeKey) ?? null;

  // ── Active thread messages ────────────────────────────────────────────────
  const thread = useQuery({
    queryKey: ["inbox-thread", activeKey],
    enabled: !!active && active.kind !== "broadcast",
    queryFn: async () => {
      if (!active) return [] as Msg[];
      const url =
        active.kind === "client"
          ? `/api/messages/${active.bookingId}`
          : `/api/messages/dispatch/${active.techId}`;
      const res = await fetch(url, { headers: apiHeaders() });
      if (!res.ok) throw new Error("Failed to load thread");
      const data = await res.json();
      return (data.messages ?? []) as Msg[];
    },
  });

  // Opening a thread is the explicit read action — never a side effect of a poll.
  useEffect(() => {
    if (!active || active.unread === 0 || active.kind === "broadcast") return;
    const url =
      active.kind === "client"
        ? `/api/messages/${active.bookingId}/mark-read`
        : `/api/messages/dispatch/${active.techId}/mark-read`;
    fetch(url, { method: "POST", headers: apiHeaders() })
      .then(() => qc.invalidateQueries({ queryKey: ["inbox"] }))
      .catch(() => {});
  }, [activeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread.data?.length, activeKey]);

  async function send() {
    if (!active || !draft.trim() || sending) return;
    setSending(true);
    try {
      const url =
        active.kind === "client"
          ? `/api/messages/${active.bookingId}`
          : `/api/messages/dispatch/${active.techId}`;
      await fetch(url, {
        method: "POST",
        headers: { ...apiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ body: draft.trim() }),
      });
      setDraft("");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["inbox-thread", activeKey] }),
        qc.invalidateQueries({ queryKey: ["inbox"] }),
      ]);
    } finally {
      setSending(false);
    }
  }

  const FILTERS = [
    { key: "all", label: "All", n: counts.all },
    // every other chip counts threads, so this one must too — counts.unread is
    // a message total and made "All 8 / Unread 8" look contradictory
    { key: "unread", label: "Unread", n: threads.filter((t) => t.unread > 0).length },
    { key: "client", label: `${customerNoun}s`, n: counts.client },
    { key: "tech", label: `${workerNoun}s`, n: counts.tech },
    { key: "broadcast", label: "Broadcasts", n: counts.broadcast },
  ] as const;

  return (
    <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-6xl flex-col px-4 pt-6 md:px-8">
      <div className="mb-4">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-white">
          <InboxIcon className="h-6 w-6 text-brand" />
          Inbox
          {(counts.unread ?? 0) > 0 && (
            <span className="rounded-full bg-brand px-2 py-0.5 text-xs font-bold text-white">
              {counts.unread}
            </span>
          )}
        </h1>
        <p className="text-sm text-slate-500">
          Every conversation — {customerNoun.toLowerCase()}s, {workerNoun.toLowerCase()}s and
          broadcasts — in one place.
        </p>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">
        {/* ── Thread list ── */}
        <div className="flex min-h-0 flex-col rounded-2xl border border-white/10 bg-ink-2">
          <div className="border-b border-white/10 p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search people, jobs, messages…"
                aria-label="Search conversations"
                className="w-full rounded-lg border border-white/10 bg-ink-3 py-2 pl-9 pr-3 text-sm text-white placeholder:text-slate-600 focus:border-brand/50 focus:outline-none"
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key as any)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                    filter === f.key
                      ? "bg-brand/20 text-brand"
                      : "text-slate-400 hover:bg-white/5"
                  }`}
                >
                  {f.label}
                  {typeof f.n === "number" && f.n > 0 && (
                    <span className="ml-1 text-slate-500">{f.n}</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {inbox.isLoading ? (
              <div className="grid place-items-center py-16">
                <Loader2 className="h-5 w-5 animate-spin text-slate-600" />
              </div>
            ) : visible.length === 0 ? (
              search || filter !== "all" ? (
                <EmptyState
                  icon={MessageSquare}
                  title="No conversations match"
                  hint="Try a different search term, or switch the filter back to All."
                />
              ) : (
                <EmptyState
                  icon={MessageSquare}
                  title="No conversations yet"
                  hint="Client replies and technician messages land here as soon as someone writes in."
                />
              )
            ) : (
              visible.map((t) => {
                const Meta = KIND_META[t.kind];
                const Icon = Meta.icon;
                return (
                  <button
                    key={t.key}
                    onClick={() => setActiveKey(t.key)}
                    className={`flex w-full items-start gap-3 border-b border-white/5 px-3 py-3 text-left transition hover:bg-white/5 ${
                      activeKey === t.key ? "bg-brand/10" : ""
                    }`}
                  >
                    <span
                      className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full"
                      style={{ backgroundColor: `${t.color}22`, color: t.color }}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-white">{t.title}</span>
                        <span className="ml-auto shrink-0 text-[10px] text-slate-500">
                          {relTime(t.lastAt)}
                        </span>
                      </span>
                      {t.jobTitle && (
                        <span className="block truncate text-[11px] text-slate-500">
                          {jobNoun}: {t.jobTitle}
                        </span>
                      )}
                      <span className="mt-0.5 flex items-center gap-2">
                        <span className="truncate text-xs text-slate-400">
                          {t.lastSenderRole === "dispatch" ? "You: " : ""}
                          {t.lastMessage}
                        </span>
                        {t.unread > 0 && (
                          <span className="ml-auto shrink-0 rounded-full bg-brand px-1.5 text-[10px] font-bold text-white">
                            {t.unread}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* ── Thread view ── */}
        <div className="flex min-h-0 flex-col rounded-2xl border border-white/10 bg-ink-2">
          {!active ? (
            <div className="grid flex-1 place-items-center px-6 text-center">
              <div>
                <InboxIcon className="mx-auto mb-3 h-8 w-8 text-slate-700" />
                <p className="text-sm text-slate-500">Pick a conversation to read and reply.</p>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 border-b border-white/10 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-white">{active.title}</p>
                  <p className="truncate text-xs text-slate-500">
                    {active.kind === "client"
                      ? active.subtitle || active.jobTitle
                      : active.kind === "tech"
                        ? `Direct thread · ${active.subtitle || workerNoun}`
                        : `Sent to ${active.messageCount} ${workerNoun.toLowerCase()}s`}
                  </p>
                </div>
                {active.bookingId && (
                  <button
                    onClick={() => navigate(`/admin/work-orders?open=${active.bookingId}`)}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-semibold text-slate-300 hover:bg-white/5"
                  >
                    Open {jobNoun.toLowerCase()} <ExternalLink className="h-3 w-3" />
                  </button>
                )}
              </div>

              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
                {active.kind === "broadcast" ? (
                  <div className="rounded-xl border border-amber-warn/30 bg-amber-warn/5 p-4">
                    <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-amber-warn">
                      Broadcast · {active.messageCount} recipients
                    </p>
                    <p className="text-sm text-slate-200">{active.lastMessage}</p>
                    <p className="mt-2 text-xs text-slate-500">
                      Broadcasts are one-way. Replies arrive as individual{" "}
                      {workerNoun.toLowerCase()} threads.
                    </p>
                  </div>
                ) : thread.isLoading ? (
                  <div className="grid place-items-center py-16">
                    <Loader2 className="h-5 w-5 animate-spin text-slate-600" />
                  </div>
                ) : (
                  (thread.data ?? []).map((m) => {
                    const mine = m.senderRole === "dispatch";
                    return (
                      <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                        <div
                          className={`max-w-[75%] rounded-2xl px-3.5 py-2 ${
                            mine
                              ? "bg-brand/20 text-white"
                              : "border border-white/10 bg-ink-3 text-slate-200"
                          }`}
                        >
                          <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                            {m.senderName || m.senderRole}
                          </p>
                          <p className="whitespace-pre-wrap text-sm">{m.body}</p>
                          <p className="mt-1 text-[10px] text-slate-500">
                            {msgTime(m.createdAt)}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={bottomRef} />
              </div>

              {active.kind !== "broadcast" && (
                <div className="flex items-center gap-2 border-t border-white/10 p-3">
                  <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    placeholder={`Reply to ${active.title}…`}
                    aria-label="Reply"
                    className="flex-1 rounded-lg border border-white/10 bg-ink-3 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-brand/50 focus:outline-none"
                  />
                  <button
                    onClick={send}
                    disabled={!draft.trim() || sending}
                    className="grid h-9 w-9 place-items-center rounded-lg bg-brand text-white disabled:opacity-40"
                    aria-label="Send reply"
                  >
                    {sending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
