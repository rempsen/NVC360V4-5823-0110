import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getToken } from "../lib/auth";
import { TechAvatar } from "./tech-avatar";
import { TECH_STATUS } from "../lib/utils";
import {
  MessageSquare,
  X,
  Send,
  ChevronLeft,
  Search,
  Megaphone,
  Users,
  ChevronDown,
  CheckCircle2,
} from "lucide-react";
import { useWorkerNoun } from "../lib/use-brand";

const API = "";

async function jget(path: string) {
  const token = getToken();
  const res = await fetch(`${API}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}
async function jpost(path: string, body: any) {
  const token = getToken();
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

type Tag = { id: string; label: string; color: string };

type Thread = {
  techId: string;
  name: string;
  photoUrl: string | null;
  color: string;
  status: string;
  skillClass: string | null;
  tags: Tag[];
  lastMessage: string | null;
  lastSenderRole: string | null;
  lastAt: string | null;
  unread: number;
};

const STATUS_ORDER: Record<string, number> = {
  enroute: 0,
  onsite: 1,
  busy: 2,
  available: 3,
  break: 4,
  offline: 5,
};

// ── Broadcast compose panel ──────────────────────────────────────────────────
type BroadcastTarget =
  | { type: "all" }
  | { type: "available" }
  | { type: "tag"; tagId: string; tagLabel: string }
  | { type: "skillClass"; skillClass: string }
  | { type: "skill"; skill: string };

function BroadcastView({
  threads,
  onClose,
  onSent,
}: {
  threads: Thread[];
  onClose: () => void;
  onSent: () => void;
}) {
  const [body, setBody] = useState("");
  const [target, setTarget] = useState<BroadcastTarget>({ type: "all" });
  const [sent, setSent] = useState<number | null>(null);
  const [dropOpen, setDropOpen] = useState(false);

  const tagsQ = useQuery({
    queryKey: ["msg-tags"],
    queryFn: () => jget("/api/messages/tags"),
  });
  const skillClassesQ = useQuery({
    queryKey: ["msg-skill-classes"],
    queryFn: () => jget("/api/messages/skill-classes"),
  });
  const skillsQ = useQuery({
    queryKey: ["msg-skills"],
    queryFn: () => jget("/api/messages/skills"),
  });

  const tags: Tag[] = tagsQ.data?.tags ?? [];
  const skillClasses: { name: string; count: number }[] = skillClassesQ.data?.skillClasses ?? [];
  const skills: { name: string; count: number }[] = skillsQ.data?.skills ?? [];

  const availableCount = threads.filter((t) => t.status === "available").length;
  const allCount = threads.length;

  const targetCount = (() => {
    if (target.type === "all") return allCount;
    if (target.type === "available") return availableCount;
    if (target.type === "tag") {
      return threads.filter((t) =>
        t.tags.some((tg) => tg.id === (target as any).tagId),
      ).length;
    }
    if (target.type === "skillClass") {
      const sc = (target as any).skillClass?.toLowerCase();
      return threads.filter(
        (t) => (t.skillClass ?? "General").toLowerCase() === sc,
      ).length;
    }
    if (target.type === "skill") {
      const needle = (target as any).skill?.toLowerCase();
      // threads don't carry individual skills csv — use server count (show count from skillsQ)
      const found = skills.find((s) => s.name.toLowerCase() === needle);
      return found?.count ?? 0;
    }
    return 0;
  })();

  const broadcast = useMutation({
    mutationFn: () =>
      jpost("/api/messages/broadcast", { body, target }),
    onSuccess: (data) => {
      setSent(data.sent ?? 0);
      onSent();
    },
  });

  const targetLabel = (() => {
    if (target.type === "all") return `All drivers (${allCount})`;
    if (target.type === "available") return `Available only (${availableCount})`;
    if (target.type === "tag") return `Tag: ${(target as any).tagLabel}`;
    if (target.type === "skillClass") return `Skill class: ${(target as any).skillClass}`;
    if (target.type === "skill") return `Skill: ${(target as any).skill}`;
    return "Select…";
  })();

  if (sent !== null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <CheckCircle2 className="h-12 w-12 text-green-400" />
        <p className="text-lg font-bold text-white">Broadcast sent!</p>
        <p className="text-sm text-slate-400">
          Delivered to <span className="font-bold text-white">{sent}</span> driver
          {sent !== 1 ? "s" : ""}
        </p>
        <button
          onClick={onClose}
          className="mt-2 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-deep"
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {/* target selector */}
        <div>
          <p className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">
            Send to
          </p>
          <div className="relative">
            <button
              onClick={() => setDropOpen((o) => !o)}
              className="flex w-full items-center justify-between rounded-lg border border-white/10 bg-ink px-3 py-2.5 text-sm text-white hover:border-brand"
            >
              <span className="flex items-center gap-2">
                <Users className="h-3.5 w-3.5 text-brand" />
                {targetLabel}
              </span>
              <ChevronDown
                className={`h-3.5 w-3.5 text-slate-400 transition-transform ${dropOpen ? "rotate-180" : ""}`}
              />
            </button>
            {dropOpen && (
              <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-72 overflow-y-auto rounded-lg border border-white/10 bg-ink-2 shadow-xl">
                {/* All */}
                <button
                  onClick={() => { setTarget({ type: "all" }); setDropOpen(false); }}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-white hover:bg-white/5"
                >
                  <span className="h-2 w-2 rounded-full bg-slate-400" />
                  All drivers ({allCount})
                </button>
                {/* Available */}
                <button
                  onClick={() => { setTarget({ type: "available" }); setDropOpen(false); }}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-white hover:bg-white/5"
                >
                  <span className="h-2 w-2 rounded-full bg-green-400" />
                  Available only ({availableCount})
                </button>

                {/* Skill Classes */}
                {skillClasses.length > 0 && (
                  <>
                    <div className="mx-3 my-1 border-t border-white/10" />
                    <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                      By skill class
                    </p>
                    {skillClasses.map((sc) => (
                      <button
                        key={sc.name}
                        onClick={() => {
                          setTarget({ type: "skillClass", skillClass: sc.name });
                          setDropOpen(false);
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-white hover:bg-white/5"
                      >
                        <span className="h-2 w-2 rounded-full bg-brand" />
                        {sc.name} ({sc.count})
                      </button>
                    ))}
                  </>
                )}

                {/* Individual Skills */}
                {skills.length > 0 && (
                  <>
                    <div className="mx-3 my-1 border-t border-white/10" />
                    <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                      By skill tag
                    </p>
                    {skills.map((sk) => (
                      <button
                        key={sk.name}
                        onClick={() => {
                          setTarget({ type: "skill", skill: sk.name });
                          setDropOpen(false);
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-white hover:bg-white/5"
                      >
                        <span className="h-2 w-2 rounded-full bg-purple-400" />
                        {sk.name} ({sk.count})
                      </button>
                    ))}
                  </>
                )}

                {/* Entity Tags */}
                {tags.length > 0 && (
                  <>
                    <div className="mx-3 my-1 border-t border-white/10" />
                    <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                      By tag
                    </p>
                    {tags.map((tg) => {
                      const cnt = threads.filter((th) =>
                        th.tags.some((t2) => t2.id === tg.id),
                      ).length;
                      return (
                        <button
                          key={tg.id}
                          onClick={() => {
                            setTarget({ type: "tag", tagId: tg.id, tagLabel: tg.label });
                            setDropOpen(false);
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-white hover:bg-white/5"
                        >
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ background: tg.color }}
                          />
                          {tg.label} ({cnt})
                        </button>
                      );
                    })}
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* message */}
        <div>
          <label htmlFor="broadcast-msg" className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">
            Message
          </label>
          <textarea
            id="broadcast-msg"
            aria-label="Broadcast message"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Type your broadcast message…"
            rows={5}
            className="w-full resize-none rounded-lg border border-white/10 bg-ink px-3 py-2.5 text-sm text-white outline-none placeholder:text-slate-600 focus:border-brand"
          />
        </div>

        {/* recipient preview */}
        {targetCount > 0 && (
          <p className="text-xs text-slate-500">
            This message will be sent to{" "}
            <span className="font-semibold text-white">{targetCount}</span> driver
            {targetCount !== 1 ? "s" : ""}.
          </p>
        )}
        {targetCount === 0 && (
          <p className="text-xs text-amber-400">
            No drivers match this target right now.
          </p>
        )}
      </div>

      <div className="border-t border-white/10 p-3">
        <button
          onClick={() => broadcast.mutate()}
          disabled={broadcast.isPending || !body.trim() || targetCount === 0}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand py-2.5 text-sm font-bold text-white hover:bg-brand-deep disabled:opacity-50"
        >
          <Megaphone className="h-4 w-4" />
          {broadcast.isPending
            ? "Sending…"
            : `Send to ${targetCount} driver${targetCount !== 1 ? "s" : ""}`}
        </button>
      </div>
    </div>
  );
}

// ── Main messenger ───────────────────────────────────────────────────────────
type View = "list" | "chat" | "broadcast";

export function DispatchMessenger() {
  const qc = useQueryClient();
  const { nounPlural } = useWorkerNoun();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("list");
  const [activeTech, setActiveTech] = useState<Thread | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [q, setQ] = useState("");

  // poll the thread list always (so the badge & red dots update even when closed)
  const threadsQ = useQuery({
    queryKey: ["dispatch-threads"],
    queryFn: () => jget("/api/messages/dispatch/threads"),
    refetchInterval: 5000,
  });

  const threads: Thread[] = threadsQ.data?.threads ?? [];
  const totalUnread: number = threadsQ.data?.totalUnread ?? 0;

  function openThread(t: Thread) {
    setActiveTech(t);
    setView("chat");
  }

  function backToList() {
    setActiveTech(null);
    setView("list");
  }

  function close() {
    setOpen(false);
    setActiveTech(null);
    setView("list");
  }

  // sort + filter for the list
  let list = threads.slice();
  if (statusFilter === "all") {
    list.sort((a, b) => {
      if (b.unread !== a.unread) return b.unread - a.unread;
      return (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    });
  } else {
    list = list.filter((t) => t.status === statusFilter);
  }
  if (q.trim()) {
    const qt = q.toLowerCase();
    list = list.filter((x) => x.name.toLowerCase().includes(qt));
  }

  const headerTitle = view === "broadcast"
    ? "Broadcast"
    : view === "chat" && activeTech
      ? activeTech.name
      : "Messages";

  return (
    <>
      {/* floating launcher */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-[900] flex h-14 w-14 items-center justify-center rounded-full bg-brand text-white shadow-2xl shadow-brand/30 transition hover:bg-brand-deep"
          title="Messages"
          aria-label="Open messages"
        >
          <MessageSquare className="h-6 w-6" />
          {totalUnread > 0 && (
            <span className="absolute -right-1 -top-1 grid h-6 min-w-6 place-items-center rounded-full border-2 border-ink bg-red-500 px-1.5 text-xs font-bold text-white">
              {totalUnread > 99 ? "99+" : totalUnread}
            </span>
          )}
        </button>
      )}

      {/* docked panel */}
      {open && (
        <div className="fixed bottom-0 right-0 top-0 z-[900] flex w-full flex-col border-l border-white/10 bg-ink-2 shadow-2xl sm:w-[380px]">
          {/* header */}
          <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
            {(view === "chat" || view === "broadcast") && (
              <button
                onClick={backToList}
                aria-label="Back to conversations"
                className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            )}
            {view === "broadcast" ? (
              <Megaphone className="h-4 w-4 text-amber-400" />
            ) : (
              <MessageSquare className="h-4 w-4 text-cyan-glow" />
            )}
            <h3 className="flex-1 font-bold text-white">
              {headerTitle}
              {view === "list" && totalUnread > 0 && (
                <span className="ml-2 rounded-full bg-red-500 px-2 py-0.5 text-[11px] font-bold text-white">
                  {totalUnread}
                </span>
              )}
            </h3>
            {/* broadcast button — only on list view */}
            {view === "list" && (
              <button
                onClick={() => setView("broadcast")}
                title="Broadcast to all drivers"
                aria-label="Broadcast"
                className="grid h-8 w-8 place-items-center rounded-lg text-amber-400 hover:bg-white/5 hover:text-amber-300"
              >
                <Megaphone className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={close}
              title="Close"
              aria-label="Close messages"
              className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* views */}
          {view === "broadcast" && (
            <BroadcastView
              threads={threads}
              onClose={backToList}
              onSent={() => {
                qc.invalidateQueries({ queryKey: ["dispatch-threads"] });
              }}
            />
          )}

          {view === "chat" && activeTech && (
            <ChatView
              tech={activeTech}
              onSent={() => {
                qc.invalidateQueries({ queryKey: ["dispatch-threads"] });
              }}
            />
          )}

          {view === "list" && (
            <>
              {/* search */}
              <div className="border-b border-white/5 px-3 py-2.5">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                  <input
                    aria-label={`Search ${nounPlural.toLowerCase()}…`}
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={`Search ${nounPlural.toLowerCase()}…`}
                    className="w-full rounded-lg border border-white/10 bg-ink py-1.5 pl-8 pr-3 text-sm text-white outline-none placeholder:text-slate-600 focus:border-brand"
                  />
                </div>
              </div>

              {/* status filter chips */}
              <div className="flex flex-wrap gap-1.5 border-b border-white/5 px-3 py-2">
                {["all", "available", "enroute", "onsite", "busy", "offline"].map((s) => {
                  const active = statusFilter === s;
                  const meta = TECH_STATUS[s];
                  return (
                    <button
                      key={s}
                      onClick={() => setStatusFilter(s)}
                      className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                        active
                          ? "bg-brand text-white"
                          : "bg-ink text-slate-400 hover:bg-white/5"
                      }`}
                    >
                      {meta && (
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ background: meta.color }}
                        />
                      )}
                      {meta?.label ?? "All"}
                    </button>
                  );
                })}
              </div>

              {/* tech list */}
              <div className="flex-1 divide-y divide-white/5 overflow-y-auto">
                {list.length === 0 ? (
                  <p className="py-10 text-center text-sm text-slate-500">
                    No {nounPlural.toLowerCase()}
                  </p>
                ) : (
                  list.map((t) => {
                    const meta = TECH_STATUS[t.status] ?? {
                      label: t.status,
                      color: "#64748b",
                    };
                    const isAvailable = t.status === "available";
                    return (
                      <button
                        key={t.techId}
                        onClick={() => openThread(t)}
                        className={`flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-white/[0.03] ${
                          isAvailable ? "border-l-2 border-green-500" : ""
                        }`}
                      >
                        <div className="relative">
                          <TechAvatar
                            name={t.name}
                            photoUrl={t.photoUrl}
                            color={t.color}
                            className={`h-10 w-10 ${isAvailable ? "ring-2 ring-green-500 ring-offset-1 ring-offset-ink-2" : ""}`}
                            textClassName="text-sm"
                          />
                          <span
                            className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-ink-2"
                            style={{ background: meta.color }}
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p
                              className={`truncate text-sm ${t.unread > 0 ? "font-bold text-white" : "font-semibold text-slate-200"}`}
                            >
                              {t.name}
                            </p>
                            <span
                              className="shrink-0 text-[10px] font-semibold"
                              style={{ color: meta.color }}
                            >
                              {meta.label}
                            </span>
                          </div>
                          {/* tags row */}
                          {t.tags.length > 0 && (
                            <div className="mb-0.5 flex flex-wrap gap-1">
                              {t.tags.slice(0, 3).map((tg) => (
                                <span
                                  key={tg.id}
                                  className="rounded-full px-1.5 py-px text-[10px] font-bold"
                                  style={{
                                    background: tg.color + "33",
                                    color: tg.color,
                                  }}
                                >
                                  {tg.label}
                                </span>
                              ))}
                            </div>
                          )}
                          <p
                            className={`truncate text-xs ${t.unread > 0 ? "text-slate-200" : "text-slate-500"}`}
                          >
                            {t.lastSenderRole === "dispatch" && "You: "}
                            {t.lastMessage ?? "No messages yet"}
                          </p>
                        </div>
                        {t.unread > 0 && (
                          <span className="grid h-5 min-w-5 place-items-center rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white">
                            {t.unread}
                          </span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

// ── Chat view ─────────────────────────────────────────────────────────────────
function ChatView({
  tech,
  onSent,
}: {
  tech: Thread;
  onSent: () => void;
}) {
  const [body, setBody] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const threadQ = useQuery({
    queryKey: ["dispatch-thread", tech.techId],
    queryFn: () => jget(`/api/messages/dispatch/${tech.techId}`),
    refetchInterval: 4000,
  });
  const messages: any[] = threadQ.data?.messages ?? [];

  const post = useMutation({
    mutationFn: () =>
      jpost(`/api/messages/dispatch/${tech.techId}`, { body }),
    onSuccess: () => {
      setBody("");
      threadQ.refetch();
      onSent();
    },
  });

  // Explicitly ack read ONCE when this thread is opened (tech.techId changes)
  // — not on every poll. The GET no longer marks-as-read as a side effect
  // (it used to, which meant a background poll for an already-open thread
  // could silently clear unread state before a dispatcher ever looked).
  useEffect(() => {
    jpost(`/api/messages/dispatch/${tech.techId}/mark-read`, {}).finally(onSent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tech.techId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length]);

  const meta = TECH_STATUS[tech.status] ?? { label: tech.status, color: "#64748b" };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* tech status sub-header */}
      <div className="flex items-center gap-2 border-b border-white/5 px-4 py-2">
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: meta.color }}
        />
        <span className="text-xs" style={{ color: meta.color }}>
          {meta.label}
        </span>
        {tech.tags.length > 0 && (
          <>
            <span className="text-slate-700">·</span>
            {tech.tags.slice(0, 3).map((tg) => (
              <span
                key={tg.id}
                className="rounded-full px-1.5 py-px text-[10px] font-bold"
                style={{ background: tg.color + "33", color: tg.color }}
              >
                {tg.label}
              </span>
            ))}
          </>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <p className="py-10 text-center text-xs text-slate-600">
            No messages yet. Start the conversation 👋
          </p>
        ) : (
          messages.map((m) => {
            const mine = m.senderRole === "dispatch";
            const isBroadcast = m.channel === "broadcast";
            return (
              <div
                key={m.id}
                className={`flex ${mine ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${
                    isBroadcast
                      ? "bg-amber-500/20 text-amber-100"
                      : mine
                        ? "bg-brand text-white"
                        : "bg-ink-3 text-slate-200"
                  }`}
                >
                  {isBroadcast && (
                    <p className="mb-1 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-amber-400">
                      <Megaphone className="h-3 w-3" /> Broadcast
                    </p>
                  )}
                  <p className="whitespace-pre-wrap break-words">{m.body}</p>
                  <p className="mt-0.5 text-[10px] opacity-60">
                    {m.senderName} ·{" "}
                    {new Date(m.createdAt).toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-white/10 p-3">
        <input
          aria-label={`Message ${tech.name.split(" ")[0]}…`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && body.trim() && post.mutate()}
          placeholder={`Message ${tech.name.split(" ")[0]}…`}
          className="flex-1 rounded-lg border border-white/10 bg-ink px-3 py-2 text-sm text-white outline-none placeholder:text-slate-600 focus:border-brand"
        />
        <button
          onClick={() => post.mutate()}
          disabled={post.isPending || !body.trim()}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-brand text-white hover:bg-brand-deep disabled:opacity-50"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
