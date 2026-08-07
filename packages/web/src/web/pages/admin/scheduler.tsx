import { useState } from "react";
import { useConfirm } from "../../components/confirm-dialog";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { FullLoader } from "../../components/loader";
import { PageWrap, StatusBadge } from "../../components/brand";
import { PageHead } from "./shell";
import { PRIORITY_META } from "../../lib/utils";
import { WorkOrderModal } from "../../components/work-order-modal";
import {
  Sparkles,
  MapPin,
  GripVertical,
  Inbox,
  Pencil,
  Trash2,
  Plus,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  CalendarDays,
  Loader2,
  AlertTriangle,
  UserPlus,
} from "lucide-react";
import { useWorkerNoun } from "../../lib/use-brand";
import { TechAvatar } from "../../components/tech-avatar";

type CalView = "day" | "week" | "month";

function startOfWeek(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay());
  return x;
}
function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function SchedulerPage() {
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { noun, nounPlural } = useWorkerNoun();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overTech, setOverTech] = useState<string | null>(null);
  const [aiFor, setAiFor] = useState<string | null>(null);
  // touch-friendly manual assign (alternative to drag-and-drop)
  const [assignFor, setAssignFor] = useState<string | null>(null);
  // skill class filter for board view
  const [skillFilter, setSkillFilter] = useState<string>("");
  const [mode, setMode] = useState<"board" | "calendar">("board");
  const [calView, setCalView] = useState<CalView>("week");
  const [anchor, setAnchor] = useState(() => new Date());
  const [newDate, setNewDate] = useState<Date | null>(null);
  const [editJob, setEditJob] = useState<any | null>(null);
  const [, navigate] = useLocation();
  // Completed jobs are historical now — open the read-only report instead
  // of the editable work order. Everything else (including cancelled)
  // keeps the existing edit-modal behavior.
  const openJob = (b: any) => {
    if (b.status === "completed") navigate(`/admin/jobs/${b.id}/report`);
    else setEditJob(b);
  };

  const bookings = useQuery({
    queryKey: ["bookings"],
    queryFn: async () => (await api.bookings.$get()).json(),
    refetchInterval: 8000,
  });
  const riders = useQuery({
    queryKey: ["riders"],
    queryFn: async () => (await api.riders.$get()).json(),
  });

  const skillClassesQ = useQuery({
    queryKey: ["msg-skill-classes"],
    queryFn: async () => { const r = await fetch("/api/messages/skill-classes"); return r.json(); },
  });
  const boardSkillClasses: string[] = (skillClassesQ.data?.skillClasses ?? []).map((s: any) => s.name);

  const assign = useMutation({
    mutationFn: async ({ id, riderId }: { id: string; riderId: string }) =>
      (await api.bookings[":id"].assign.$post({
        param: { id },
        json: { riderId },
      })).json(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bookings"] });
      qc.invalidateQueries({ queryKey: ["fleet"] });
    },
  });

  // jobs projected to run late (live tech position + this tenant's own history)
  const risk = useQuery({
    queryKey: ["delay-risk"],
    queryFn: async () => (await api.ai["delay-risk"].$get()).json(),
    refetchInterval: 60_000,
  });

  const suggest = useMutation({
    mutationFn: async (bookingId: string) =>
      (await api.ai["suggest-tech"][":bookingId"].$post({
        param: { bookingId },
      })).json(),
  });

  const del = useMutation({
    mutationFn: async (id: string) =>
      api.jobs[":id"].$delete({ param: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bookings"] });
      qc.invalidateQueries({ queryKey: ["fleet"] });
      qc.invalidateQueries({ queryKey: ["riders"] });
    },
  });

  const removeJob = async (b: any) => {
    const ok = await confirm({
      title: `Archive "${b.title || b.service?.name || "this work order"}"?`,
      message: "It will be moved to the archive and can be restored later from Work Orders.",
      confirmLabel: "Archive",
    });
    if (ok) del.mutate(b.id);
  };

  const reschedule = useMutation({
    mutationFn: async ({ id, scheduledAt }: { id: string; scheduledAt: string }) =>
      (await api.bookings[":id"].schedule.$post({
        param: { id },
        json: { scheduledAt },
      })).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bookings"] }),
  });

  // calendar drag-and-drop: drop an unscheduled job onto a day -> set its date
  const [calDragId, setCalDragId] = useState<string | null>(null);
  const [overDay, setOverDay] = useState<string | null>(null);
  // live half-hour time preview while dragging over a week/day column
  const [hoverTime, setHoverTime] = useState<{ key: string; mins: number } | null>(null);

  // day time window the column represents (7:00 AM -> 8:00 PM)
  const DAY_START_MIN = 7 * 60;
  const DAY_END_MIN = 20 * 60;

  // map a cursor Y within a day column to a snapped half-hour time (minutes from midnight)
  function timeFromOffset(el: HTMLElement, clientY: number): number {
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    const raw = DAY_START_MIN + frac * (DAY_END_MIN - DAY_START_MIN);
    const snapped = Math.round(raw / 30) * 30; // 30-min blocks
    return Math.min(DAY_END_MIN, Math.max(DAY_START_MIN, snapped));
  }

  function fmtMins(mins: number): string {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
  }

  // drop onto a day -> default 9:00 AM (month view / no time grid)
  function dropOnDay(d: Date) {
    if (calDragId) {
      const dt = new Date(d);
      dt.setHours(9, 0, 0, 0);
      reschedule.mutate({ id: calDragId, scheduledAt: dt.toISOString() });
    }
    setCalDragId(null);
    setOverDay(null);
    setHoverTime(null);
  }

  // drop onto a week/day column at a precise half-hour block
  function dropOnDayAtTime(d: Date, mins: number) {
    if (calDragId) {
      const dt = new Date(d);
      dt.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
      reschedule.mutate({ id: calDragId, scheduledAt: dt.toISOString() });
    }
    setCalDragId(null);
    setOverDay(null);
    setHoverTime(null);
  }

  if (bookings.isLoading || riders.isLoading)
    return <FullLoader label="Loading scheduler…" />;

  const all = bookings.data?.bookings ?? [];
  const techs = riders.data?.riders ?? [];
  // skill-class-filtered techs for board view
  const filteredTechs = skillFilter ? techs.filter((t: any) => t.skillClass === skillFilter) : techs;
  const unassigned = all.filter((b) => !b.riderId && b.status !== "completed" && b.status !== "cancelled");
  // dragging job for skill highlight
  const draggedJob = dragId ? all.find((b) => b.id === dragId) : null;
  const dragSkillClass = (draggedJob as any)?.requiredSkillClass ?? "";
  // calendar backlog: active jobs that still need scheduling OR a tech assigned.
  // drag one onto a day to (re)set its date, then dispatch from the Board.
  const undated = all.filter(
    (b) =>
      !["completed", "cancelled"].includes(b.status) &&
      (!b.scheduledAt || !b.riderId),
  );
  const byTech = (tid: string) =>
    all.filter((b) => b.riderId === tid && !["completed", "cancelled"].includes(b.status));

  function onDrop(riderId: string) {
    if (dragId) assign.mutate({ id: dragId, riderId });
    setDragId(null);
    setOverTech(null);
  }

  // ---- calendar helpers ----
  const scheduled = all.filter(
    (b) => b.scheduledAt && !["cancelled"].includes(b.status),
  );
  const jobsOn = (d: Date) =>
    scheduled
      .filter((b) => sameDay(new Date(b.scheduledAt as any), d))
      .sort(
        (a, b) =>
          new Date(a.scheduledAt as any).getTime() -
          new Date(b.scheduledAt as any).getTime(),
      );

  function shift(dir: number) {
    const x = new Date(anchor);
    if (calView === "day") x.setDate(x.getDate() + dir);
    else if (calView === "week") x.setDate(x.getDate() + dir * 7);
    else x.setMonth(x.getMonth() + dir);
    setAnchor(x);
  }

  let calDays: Date[] = [];
  if (calView === "day") calDays = [new Date(anchor)];
  else if (calView === "week") {
    const s = startOfWeek(anchor);
    calDays = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(s);
      d.setDate(s.getDate() + i);
      return d;
    });
  } else {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const gridStart = startOfWeek(first);
    calDays = Array.from({ length: 42 }, (_, i) => {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      return d;
    });
  }

  const calLabel =
    calView === "month"
      ? anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" })
      : calView === "day"
        ? anchor.toLocaleDateString(undefined, {
            weekday: "long",
            month: "short",
            day: "numeric",
          })
        : `${calDays[0].toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${calDays[6].toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;

  const today = new Date();

  return (
    <PageWrap>
      <WorkOrderModal
        open={newDate !== null}
        defaultDate={newDate ?? undefined}
        onClose={() => setNewDate(null)}
      />
      <WorkOrderModal
        open={editJob !== null}
        editBooking={editJob ?? undefined}
        onClose={() => setEditJob(null)}
      />
      <PageHead
        title="Scheduler"
        subtitle={`Drag work orders onto a ${noun.toLowerCase()} to dispatch — or let AI suggest the best match`}
        actions={
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-white/10 bg-ink-2 p-0.5">
              <button
                onClick={() => setMode("board")}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold ${mode === "board" ? "bg-brand text-white" : "text-slate-400 hover:text-white"}`}
              >
                <LayoutGrid className="h-3.5 w-3.5" /> Board
              </button>
              <button
                onClick={() => setMode("calendar")}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold ${mode === "calendar" ? "bg-brand text-white" : "text-slate-400 hover:text-white"}`}
              >
                <CalendarDays className="h-3.5 w-3.5" /> Calendar
              </button>
            </div>
            <button
              onClick={() => setNewDate(new Date())}
              className="flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-deep"
            >
              <Plus className="h-4 w-4" /> New Work Order
            </button>
          </div>
        }
      />

      {((risk.data as any)?.risks ?? []).length > 0 && (
        <div className="mb-4 rounded-xl border border-amber-warn/25 bg-amber-warn/[0.06] p-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-warn" />
            <h3 className="text-sm font-bold text-amber-warn">
              {(risk.data as any).risks.length} job
              {(risk.data as any).risks.length === 1 ? "" : "s"} projected to run
              late
            </h3>
          </div>
          <div className="mt-2 space-y-1.5">
            {((risk.data as any).risks as any[]).slice(0, 4).map((r) => (
              <button
                key={r.bookingId}
                onClick={() => {
                  const b = (bookings.data?.bookings ?? []).find(
                    (x: any) => x.id === r.bookingId,
                  );
                  if (b) setEditJob(b);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-1 py-0.5 text-left text-xs hover:bg-white/5"
              >
                <span className="font-semibold text-slate-200">
                  {r.title || "Work order"}
                </span>
                <span className="rounded-full bg-amber-warn/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-warn">
                  ~{r.minutesLate} min late
                </span>
                <span className="truncate text-slate-500">
                  {r.techName ? `${r.techName} — ` : ""}
                  {r.reason}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {mode === "calendar" ? (
        <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
        {/* far-left unscheduled queue — drag onto a day to set its date */}
        <div className="nvc-card flex h-fit flex-col">
          <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
            <Inbox className="h-4 w-4 text-amber-warn" />
            <h2 className="font-bold text-white">Work Queue</h2>
            <span className="ml-auto rounded-full bg-amber-warn/15 px-2 py-0.5 text-xs font-bold text-amber-warn">
              {undated.length}
            </span>
          </div>
          <div className="space-y-2 p-3">
            {undated.length === 0 ? (
              <p className="py-8 text-center text-xs text-slate-500">
                All caught up — every active job is scheduled and assigned.
              </p>
            ) : (
              undated.map((b) => (
                <div
                  key={b.id}
                  draggable
                  onDragStart={() => setCalDragId(b.id)}
                  onDragEnd={() => {
                    setCalDragId(null);
                    setOverDay(null);
                  }}
                  className={`group cursor-grab rounded-xl border border-white/10 bg-ink-3/60 p-2.5 transition active:cursor-grabbing ${
                    calDragId === b.id ? "dragging" : ""
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <GripVertical className="mt-0.5 h-4 w-4 shrink-0 text-slate-600 group-hover:text-slate-400" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-white">
                        {b.title || b.service?.name}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-slate-500">
                        <MapPin className="h-3 w-3 shrink-0" />
                        {b.address || "No address"}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {b.priority && (
                          <span
                            className="inline-block rounded-full px-1.5 py-0.5 text-[9px] font-bold"
                            style={{
                              color: PRIORITY_META[b.priority]?.color,
                              background: `${PRIORITY_META[b.priority]?.color}22`,
                            }}
                          >
                            {PRIORITY_META[b.priority]?.label}
                          </span>
                        )}
                        {!b.scheduledAt && (
                          <span className="inline-block rounded-full bg-amber-warn/15 px-1.5 py-0.5 text-[9px] font-bold text-amber-warn">
                            No date
                          </span>
                        )}
                        {!b.riderId && (
                          <span className="inline-block rounded-full bg-brand/15 px-1.5 py-0.5 text-[9px] font-bold text-brand">
                            Unassigned
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
          <p className="border-t border-white/5 px-3 py-2 text-[10px] text-slate-600">
            Drag a card onto any calendar day to schedule it for 9:00 AM, then assign a tech from the Board.
          </p>
        </div>

        <div className="nvc-card overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-white/5 px-4 py-3">
            <div className="flex items-center gap-1">
              <button
                onClick={() => shift(-1)}
                className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                onClick={() => shift(1)}
                className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
              <button
                onClick={() => setAnchor(new Date())}
                className="ml-1 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-white/5"
              >
                Today
              </button>
            </div>
            <h3 className="font-display text-base font-bold text-white">
              {calLabel}
            </h3>
            <div className="ml-auto flex rounded-lg border border-white/10 bg-ink-2 p-0.5">
              {(["day", "week", "month"] as CalView[]).map((v) => (
                <button
                  key={v}
                  onClick={() => setCalView(v)}
                  className={`rounded-md px-3 py-1 text-xs font-semibold capitalize ${calView === v ? "bg-brand text-white" : "text-slate-400 hover:text-white"}`}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>

          {calView === "month" ? (
            <div className="grid grid-cols-7">
              {DOW.map((d) => (
                <div
                  key={d}
                  className="border-b border-white/5 px-2 py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-slate-500"
                >
                  {d}
                </div>
              ))}
              {calDays.map((d, i) => {
                const jobs = jobsOn(d);
                const inMonth = d.getMonth() === anchor.getMonth();
                const dayKey = d.toISOString().slice(0, 10);
                return (
                  <button
                    key={i}
                    onClick={() => {
                      const dt = new Date(d);
                      dt.setHours(9, 0, 0, 0);
                      setNewDate(dt);
                    }}
                    onDragOver={(e) => {
                      if (!calDragId) return;
                      e.preventDefault();
                      setOverDay(dayKey);
                    }}
                    onDragLeave={() => setOverDay((v) => (v === dayKey ? null : v))}
                    onDrop={() => dropOnDay(d)}
                    className={`min-h-[92px] border-b border-r border-white/5 p-1.5 text-left transition hover:bg-white/[0.03] ${inMonth ? "" : "opacity-40"} ${overDay === dayKey ? "drop-active" : ""}`}
                  >
                    <span
                      className={`inline-grid h-6 w-6 place-items-center rounded-full text-xs font-semibold ${sameDay(d, today) ? "bg-brand text-white" : "text-slate-400"}`}
                    >
                      {d.getDate()}
                    </span>
                    <div className="mt-1 space-y-1">
                      {jobs.slice(0, 3).map((b) => (
                        <div tabIndex={0}
                          key={b.id}
                          // nested clickable chip inside an already-clickable
                          // day cell — a real <button> can't be nested here.
                          // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
                          role="button"
                          title="Click to edit"
                          aria-label={`Edit job ${b.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            openJob(b);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              e.stopPropagation();
                              openJob(b);
                            }
                          }}
                          className="group/chip flex cursor-pointer items-center gap-1 truncate rounded px-1 py-0.5 text-[10px] font-medium text-white hover:brightness-125"
                          style={{
                            background: `${PRIORITY_META[b.priority]?.color ?? "#3b82f6"}33`,
                          }}
                        >
                          <span className="truncate">
                            {new Date(
                              b.scheduledAt as any,
                            ).toLocaleTimeString([], {
                              hour: "numeric",
                              minute: "2-digit",
                            })}{" "}
                            {b.title || b.service?.name}
                          </span>
                          <button
                            type="button"
                            aria-label="Delete work order"
                            title="Delete"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeJob(b);
                            }}
                            className="ml-auto hidden shrink-0 rounded p-0.5 text-white/70 hover:bg-black/30 hover:text-rose-300 group-hover/chip:block"
                          >
                            <Trash2 className="h-2.5 w-2.5" />
                          </button>
                        </div>
                      ))}
                      {jobs.length > 3 && (
                        <p className="px-1 text-[10px] text-slate-500">
                          +{jobs.length - 3} more
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div
              className={`grid ${calView === "day" ? "grid-cols-1" : "grid-cols-7"}`}
            >
              {calDays.map((d, i) => {
                const jobs = jobsOn(d);
                const dayKey = d.toISOString().slice(0, 10);
                return (
                  <div
                    key={i}
                    className={`border-r border-white/5 last:border-r-0 transition ${overDay === dayKey ? "drop-active" : ""}`}
                  >
                    <button
                      onClick={() => {
                        const dt = new Date(d);
                        dt.setHours(9, 0, 0, 0);
                        setNewDate(dt);
                      }}
                      className="flex w-full items-center justify-between border-b border-white/5 px-2 py-2 hover:bg-white/[0.03]"
                    >
                      <span className="text-[11px] font-semibold uppercase text-slate-500">
                        {DOW[d.getDay()]}
                      </span>
                      <span
                        className={`grid h-6 w-6 place-items-center rounded-full text-xs font-semibold ${sameDay(d, today) ? "bg-brand text-white" : "text-slate-300"}`}
                      >
                        {d.getDate()}
                      </span>
                    </button>
                    {/* time-aware drop grid: drag a job here to place it at a half-hour block */}
                    <div
                      onDragOver={(e) => {
                        if (!calDragId) return;
                        e.preventDefault();
                        setOverDay(dayKey);
                        setHoverTime({
                          key: dayKey,
                          mins: timeFromOffset(e.currentTarget as HTMLElement, e.clientY),
                        });
                      }}
                      onDragLeave={() => {
                        setOverDay((v) => (v === dayKey ? null : v));
                        setHoverTime((v) => (v?.key === dayKey ? null : v));
                      }}
                      onDrop={(e) => {
                        const mins = timeFromOffset(e.currentTarget as HTMLElement, e.clientY);
                        dropOnDayAtTime(d, mins);
                      }}
                      className="relative min-h-[420px] space-y-1.5 p-1.5"
                    >
                      {/* half-hour gridlines while dragging */}
                      {calDragId && (
                        <div className="pointer-events-none absolute inset-0">
                          {Array.from(
                            { length: (DAY_END_MIN - DAY_START_MIN) / 30 + 1 },
                            (_, k) => {
                              const mins = DAY_START_MIN + k * 30;
                              const top = `${(k / ((DAY_END_MIN - DAY_START_MIN) / 30)) * 100}%`;
                              const onHour = mins % 60 === 0;
                              return (
                                <div
                                  key={k}
                                  className={`absolute left-0 right-0 border-t ${onHour ? "border-white/10" : "border-white/[0.04]"}`}
                                  style={{ top }}
                                >
                                  {onHour && (
                                    <span className="absolute -top-1.5 left-0.5 text-[8px] text-slate-600">
                                      {fmtMins(mins)}
                                    </span>
                                  )}
                                </div>
                              );
                            },
                          )}
                        </div>
                      )}
                      {/* live placement indicator */}
                      {calDragId && hoverTime?.key === dayKey && (
                        <div
                          className="pointer-events-none absolute left-0 right-0 z-10 flex items-center"
                          style={{
                            top: `${((hoverTime.mins - DAY_START_MIN) / (DAY_END_MIN - DAY_START_MIN)) * 100}%`,
                          }}
                        >
                          <div className="h-0.5 flex-1 bg-brand" />
                          <span className="rounded bg-brand px-1.5 py-0.5 text-[10px] font-bold text-white shadow">
                            {fmtMins(hoverTime.mins)}
                          </span>
                        </div>
                      )}
                      {jobs.length === 0 ? (
                        <button
                          onClick={() => {
                            const dt = new Date(d);
                            dt.setHours(9, 0, 0, 0);
                            setNewDate(dt);
                          }}
                          className="grid h-16 w-full place-items-center rounded-lg border border-dashed border-white/10 text-[11px] text-slate-600 hover:border-brand/40 hover:text-slate-400"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      ) : (
                        jobs.map((b) => (
                          <div tabIndex={0}
                            key={b.id}
                            // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
                            role="button"
                            onClick={() => openJob(b)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                openJob(b);
                              }
                            }}
                            title="Click to edit"
                            className="group/chip relative block w-full cursor-pointer rounded-lg border-l-2 bg-ink-3/60 p-2 text-left transition hover:bg-ink-3"
                            style={{
                              borderColor:
                                PRIORITY_META[b.priority]?.color ?? "#3b82f6",
                            }}
                          >
                            <button
                              type="button"
                              aria-label="Delete work order"
                              title="Delete"
                              onClick={(e) => {
                                e.stopPropagation();
                                removeJob(b);
                              }}
                              className="absolute right-1 top-1 hidden rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-400 group-hover/chip:block"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                            <p className="text-[11px] font-bold text-cyan-glow">
                              {new Date(b.scheduledAt as any).toLocaleTimeString(
                                [],
                                { hour: "numeric", minute: "2-digit" },
                              )}
                            </p>
                            <p className="truncate pr-5 text-xs font-semibold text-white">
                              {b.title || b.service?.name}
                            </p>
                            <p className="truncate text-[10px] text-slate-500">
                              {b.customer?.name}
                            </p>
                            <div className="mt-1">
                              <StatusBadge status={b.status} />
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        </div>
      ) : (
      <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
        {/* unassigned queue */}
        <div className="nvc-card flex h-fit flex-col">
          <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
            <Inbox className="h-4 w-4 text-amber-warn" />
            <h2 className="font-bold text-white">Unassigned</h2>
            <span className="ml-auto rounded-full bg-amber-warn/15 px-2 py-0.5 text-xs font-bold text-amber-warn">
              {unassigned.length}
            </span>
          </div>
          <div className="space-y-2 p-3">
            {unassigned.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-500">
                All work orders dispatched
              </p>
            ) : (
              unassigned.map((b) => (
                <div
                  key={b.id}
                  draggable
                  // oxlint-disable-next-line prefer-tag-over-role -- a draggable div cannot be a <button>
                  role="button"
                  tabIndex={0}
                  title="Click to view & edit"
                  onClick={() => {
                    if (!dragId) openJob(b);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openJob(b);
                    }
                  }}
                  onDragStart={() => setDragId(b.id)}
                  onDragEnd={() => {
                    setDragId(null);
                    setOverTech(null);
                  }}
                  className={`group cursor-grab rounded-xl border border-white/10 bg-ink-3/60 p-3 transition hover:border-brand/40 active:cursor-grabbing ${
                    dragId === b.id ? "dragging" : ""
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <GripVertical className="mt-0.5 h-4 w-4 shrink-0 cursor-grab text-slate-600 group-hover:text-slate-400" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-sm font-semibold text-white">
                          {b.title || b.service?.name}
                        </p>
                        {b.priority && (
                          <span
                            className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold"
                            style={{
                              color: PRIORITY_META[b.priority]?.color,
                              background: `${PRIORITY_META[b.priority]?.color}22`,
                            }}
                          >
                            {PRIORITY_META[b.priority]?.label}
                          </span>
                        )}
                        {(b as any).requiredSkillClass && (
                          <span className="shrink-0 rounded-full bg-brand/20 px-1.5 py-0.5 text-[9px] font-bold text-brand">
                            {(b as any).requiredSkillClass}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-slate-500">
                        <MapPin className="h-3 w-3 shrink-0" />
                        {b.address}
                      </p>
                      {(b as any).requiredSkills && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {((b as any).requiredSkills as string).split(",").filter(Boolean).map((sk: string) => (
                            <span key={sk} className="rounded-full bg-cyan-glow/10 px-1.5 py-0.5 text-[9px] font-semibold text-cyan-glow">{sk}</span>
                          ))}
                        </div>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setAssignFor((v) => (v === b.id ? null : b.id));
                            setAiFor(null);
                          }}
                          className="flex items-center gap-1 text-xs font-semibold text-slate-300 hover:text-white"
                        >
                          <UserPlus className="h-3 w-3" /> Assign
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setAiFor(b.id);
                            setAssignFor(null);
                            suggest.mutate(b.id);
                          }}
                          className="flex items-center gap-1 text-xs font-semibold text-cyan-glow hover:text-brand"
                        >
                          <Sparkles className="h-3 w-3" /> AI suggest
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            openJob(b);
                          }}
                          className="flex items-center gap-1 text-xs font-semibold text-slate-400 hover:text-white"
                        >
                          <Pencil className="h-3 w-3" /> Edit
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            removeJob(b);
                          }}
                          aria-label="Delete work order"
                          className="ml-auto flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-rose-400"
                        >
                          <Trash2 className="h-3 w-3" /> Delete
                        </button>
                      </div>
                      {assignFor === b.id && (
                        <div className="mt-2 rounded-lg border border-white/10 bg-ink-3/60 p-2">
                          <p className="mb-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                            Assign to {noun.toLowerCase()}
                          </p>
                          <div className="max-h-44 space-y-1 overflow-y-auto">
                            {(() => {
                              const reqSc = (b as any).requiredSkillClass ?? "";
                              const matchedTechs = reqSc ? techs.filter((t: any) => t.skillClass === reqSc) : techs;
                              const otherTechs = reqSc ? techs.filter((t: any) => t.skillClass !== reqSc) : [];
                              const renderTech = (t: any, dimmed = false) => (
                                <button
                                  key={t.id}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    assign.mutate({ id: b.id, riderId: t.id });
                                    setAssignFor(null);
                                  }}
                                  className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-xs hover:bg-white/5 ${dimmed ? "opacity-50" : ""}`}
                                >
                                  <TechAvatar
                                    name={t.name}
                                    photoUrl={(t as any).photoUrl}
                                    color={t.color}
                                    className="h-5 w-5"
                                    textClassName="text-[9px]"
                                  />
                                  <span className="font-medium text-slate-200">{t.name}</span>
                                  {t.skillClass && <span className={`rounded-full px-1 py-0.5 text-[9px] font-semibold ${!dimmed ? "bg-brand/20 text-brand" : "bg-white/10 text-slate-500"}`}>{t.skillClass}</span>}
                                  <span className="ml-auto capitalize text-[10px] text-slate-500">{t.status}</span>
                                </button>
                              );
                              if (techs.length === 0) return <p className="px-1 py-2 text-xs text-slate-500">No {nounPlural.toLowerCase()} found.</p>;
                              return (
                                <>
                                  {matchedTechs.map((t: any) => renderTech(t, false))}
                                  {otherTechs.length > 0 && reqSc && (
                                    <>
                                      <p className="px-1 pt-1 text-[10px] text-slate-600">— other {nounPlural.toLowerCase()} —</p>
                                      {otherTechs.map((t: any) => renderTech(t, true))}
                                    </>
                                  )}
                                </>
                              );
                            })()}
                          </div>
                        </div>
                      )}
                      {aiFor === b.id && suggest.isPending && (
                        <div className="mt-2 flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] p-2 text-xs text-slate-400">
                          <Loader2 className="h-3 w-3 animate-spin" /> Finding the
                          best {noun.toLowerCase()}…
                        </div>
                      )}
                      {aiFor === b.id &&
                        !suggest.isPending &&
                        suggest.data &&
                        !suggest.data.best && (
                          <div className="mt-2 rounded-lg border border-amber-warn/20 bg-amber-warn/5 p-2 text-xs text-amber-warn">
                            No {nounPlural.toLowerCase()} available to suggest right now.
                          </div>
                        )}
                      {aiFor === b.id && !suggest.isPending && suggest.data?.best && (
                        <div
                          className={`mt-2 rounded-lg border p-2 text-xs ${
                            suggest.data.confident
                              ? "border-brand/20 bg-brand/5"
                              : "border-amber-warn/25 bg-amber-warn/[0.06]"
                          }`}
                        >
                          {!suggest.data.confident && (
                            <p className="mb-1 flex items-center gap-1 font-semibold text-amber-warn">
                              <AlertTriangle className="h-3 w-3" /> Low-confidence
                              match
                            </p>
                          )}
                          <p className="mb-1 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-cyan-glow">
                            <Sparkles className="h-3 w-3" />
                            {(suggest.data as any).source === "ai"
                              ? "AI dispatch"
                              : "Best match"}
                          </p>
                          <p className="text-slate-300">
                            {suggest.data.reasoning}
                          </p>
                          {((suggest.data as any).ranked ?? [])
                            .slice(1, 3)
                            .filter((r: any) => r.rationale)
                            .map((r: any) => (
                              <p
                                key={r.techId}
                                className="mt-1 border-t border-white/5 pt-1 text-[11px] leading-snug text-slate-500"
                              >
                                <span className="font-semibold text-slate-400">
                                  {r.name}:
                                </span>{" "}
                                {r.rationale}
                              </p>
                            ))}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              assign.mutate({
                                id: b.id,
                                riderId: suggest.data!.best!.techId,
                              });
                            }}
                            className={`mt-1.5 w-full rounded-md py-1 font-semibold text-white ${
                              suggest.data.confident
                                ? "bg-brand hover:bg-brand-deep"
                                : "bg-white/10 hover:bg-white/15"
                            }`}
                          >
                            Assign {suggest.data.best.name}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* technician lanes */}
        <div className="space-y-3">
          {/* skill class filter bar */}
          {boardSkillClasses.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/5 bg-ink-3/60 px-3 py-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Filter by skill:</span>
              <button
                type="button"
                onClick={() => setSkillFilter("")}
                className={`rounded-full px-2.5 py-0.5 text-xs font-semibold transition ${skillFilter === "" ? "bg-brand text-white" : "bg-white/10 text-slate-300 hover:bg-white/15"}`}
              >
                All
              </button>
              {boardSkillClasses.map((sc) => (
                <button
                  key={sc}
                  type="button"
                  onClick={() => setSkillFilter(sc === skillFilter ? "" : sc)}
                  className={`rounded-full px-2.5 py-0.5 text-xs font-semibold transition ${skillFilter === sc ? "bg-brand text-white" : "bg-white/10 text-slate-300 hover:bg-white/15"}`}
                >
                  {sc}
                </button>
              ))}
              {skillFilter && (
                <span className="ml-auto text-xs text-slate-500">{filteredTechs.length} of {techs.length} shown</span>
              )}
            </div>
          )}
          {filteredTechs.map((t) => {
            const jobs = byTech(t.id);
            const over = overTech === t.id;
            // dim this lane if dragging a job that requires a different skill class
            const skillMismatch = dragSkillClass && (t as any).skillClass !== dragSkillClass;
            return (
              <div
                key={t.id}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOverTech(t.id);
                }}
                onDragLeave={() => setOverTech((v) => (v === t.id ? null : v))}
                onDrop={() => onDrop(t.id)}
                className={`nvc-card p-3 transition ${over ? "drop-active" : ""} ${skillMismatch ? "opacity-40 pointer-events-none" : ""}`}
              >
                <div className="mb-2 flex items-center gap-3">
                  <TechAvatar
                    name={t.name}
                    photoUrl={(t as any).photoUrl}
                    color={t.color}
                    className="h-9 w-9"
                    textClassName="text-xs"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-white">
                      {t.name}
                    </p>
                    <p className="text-xs text-slate-500">
                      {t.skillClass} · {jobs.length} jobs
                    </p>
                  </div>
                  <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] capitalize text-slate-400">
                    {t.status}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {jobs.length === 0 ? (
                    <p className="px-1 py-3 text-xs text-slate-600">
                      Drop a work order here to dispatch
                    </p>
                  ) : (
                    jobs.map((b) => (
                      <div
                        key={b.id}
                        className="group/chip flex items-center gap-1.5 rounded-lg border border-white/10 bg-ink-3/60 pl-2.5 pr-1.5 py-1.5 text-xs transition hover:border-brand/50 hover:bg-ink-3"
                      >
                        <button
                          onClick={() => openJob(b)}
                          title="Click to edit"
                          className="flex items-center gap-2"
                        >
                          <span className="font-medium text-slate-200">
                            {b.title || b.service?.name}
                          </span>
                          <StatusBadge status={b.status} />
                        </button>
                        <button
                          onClick={() => removeJob(b)}
                          aria-label="Delete work order"
                          title="Delete work order"
                          className="rounded p-0.5 text-slate-600 transition hover:bg-rose-500/10 hover:text-rose-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      )}
    </PageWrap>
  );
}
