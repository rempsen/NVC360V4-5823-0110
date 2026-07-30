import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { TechAvatar } from "../../components/tech-avatar";
import { FleetMap } from "../../components/fleet-map";
import { WorkOrderModal } from "../../components/work-order-modal";
import { Modal, inputCls, BtnGhost, BtnPrimary } from "../../components/modal";
import { TECH_STATUS, PRIORITY_META, STATUS_META } from "../../lib/utils";
import {
  Wrench,
  MapPin,
  Phone,
  Star,
  Navigation,
  Sparkles,
  X,
  Gauge,
  Clock,
  MessageSquare,
  Send,
  Smartphone,
  Users,
  Briefcase,
  Layers,
} from "lucide-react";
import { useWorkerNoun } from "../../lib/use-brand";

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function FleetPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const [smsFor, setSmsFor] = useState<any>(null);
  const [chatFor, setChatFor] = useState<any>(null);
  const [jobFor, setJobFor] = useState<any>(null);
  const [, navigate] = useLocation();

  // map filters
  const [showDrivers, setShowDrivers] = useState(true);
  const [showJobs, setShowJobs] = useState(true);
  const [dateFrom, setDateFrom] = useState(todayStr());
  const [dateTo, setDateTo] = useState(todayStr());

  const fleet = useQuery({
    queryKey: ["fleet"],
    queryFn: async () => (await api.fleet.$get()).json(),
    refetchInterval: 5000,
  });

  const bookingsQ = useQuery({
    queryKey: ["fleet-bookings", dateFrom, dateTo],
    queryFn: async () => {
      // Use the paginated search endpoint (batch-enriched, no N+1 per booking).
      const from = new Date(`${dateFrom}T00:00:00`);
      const to = new Date(`${dateTo}T23:59:59`);
      const p = new URLSearchParams({
        pageSize: "500",
        page: "1",
        sort: "scheduledAt",
        dir: "desc",
        schedFrom: String(from.getTime()),
        schedTo: String(to.getTime()),
      });
      const res = await fetch(`/api/jobs/search?${p.toString()}`, {
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) return { bookings: [] };
      const data = await res.json();
      return { bookings: data.jobs ?? [] };
    },
    refetchInterval: 15000,
  });

  const techs = fleet.data?.fleet ?? [];
  const active = techs.find((t) => t.id === selected) ?? null;

  // shape for the map markers (rich hover card)
  const mapTechs = techs.map((t: any) => ({
    id: t.id,
    name: t.name,
    color: t.color,
    photoUrl: t.photoUrl,
    status: t.status,
    lat: t.lat,
    lng: t.lng,
    skillClass: t.skillClass,
    phone: t.phone,
    jobsToday: t.completedJobs ?? null,
    task: t.task
      ? {
          title: t.task.title,
          address: t.task.address,
          eta: t.task.etaMins != null ? `~${t.task.etaMins} min` : null,
          destLat: t.task.destLat,
          destLng: t.task.destLng,
        }
      : null,
  }));

  // job markers: filter by date range + has coords + not cancelled
  // bookingsQ now uses job-search which returns flat fields (customerName, technician, lat, lng)
  const allBookings = (bookingsQ.data as any)?.bookings ?? [];
  const jobs = allBookings
    .filter((b: any) => b.lat != null && b.lng != null && b.status !== "cancelled")
    .map((b: any) => ({
      id: b.id,
      title: b.title || b.service || jobNoun,
      status: b.status,
      color: STATUS_META[b.status]?.color ?? "#0ea5e9",
      lat: b.lat,
      lng: b.lng,
      address: b.address,
      customerName: b.customerName ?? null,
      techName: b.technician !== "Unassigned" ? b.technician : null,
      scheduledAt: b.scheduledAt,
      priority: b.priority ?? null,
      total: b.total ?? null,
    }));

  const setMode = (drivers: boolean, jobsOn: boolean) => {
    setShowDrivers(drivers);
    setShowJobs(jobsOn);
  };
  const mode = showDrivers && showJobs ? "both" : showDrivers ? "drivers" : "jobs";

  // poll unread count for the currently selected tech's direct thread
  const unreadQuery = useQuery({
    queryKey: ["fleet-unread", selected],
    queryFn: async () =>
      (await api.fleet[":techId"].unread.$get({ param: { techId: selected! } })).json(),
    enabled: !!selected,
    refetchInterval: 5000,
  });
  const unreadCount = (unreadQuery.data as any)?.count ?? 0;

  const optimize = useMutation({
    mutationFn: async (techId: string) =>
      (await api.ai["optimize-route"][":techId"].$get({ param: { techId } })).json(),
  });

  const counts = techs.reduce<Record<string, number>>((a, t) => {
    a[t.status] = (a[t.status] ?? 0) + 1;
    return a;
  }, {});

  return (
    <div className="relative h-[calc(100vh-0px)] md:h-screen">
      <FleetMap
        techs={mapTechs as any}
        jobs={jobs}
        showTechs={showDrivers}
        showJobs={showJobs}
        selectedId={selected}
        onSelect={(id) => {
          setSelected(id);
          optimize.reset();
        }}
        onSelectJob={(id) => {
          const b = allBookings.find((x: any) => x.id === id) ?? jobs.find((x: any) => x.id === id);
          if (!b) return;
          // Completed jobs are historical now — open the read-only report
          // instead of the editable work order.
          if (b.status === "completed") navigate(`/admin/jobs/${b.id}/report`);
          else setJobFor(b);
        }}
        className="h-full w-full"
      />

      {showDrivers && techs.length - (counts.offline ?? 0) === 0 && (
        <div className="pointer-events-none absolute inset-0 z-[1000] grid place-items-center">
          <div className="pointer-events-none rounded-xl border border-white/10 bg-ink/90 px-4 py-3 text-center shadow-lg backdrop-blur-sm">
            <p className="text-sm font-semibold text-slate-300">No technicians active right now</p>
            <p className="mt-0.5 text-xs text-slate-500">
              {techs.length === 0 ? "No technicians on the team yet." : "Everyone on the team is currently offline."}
            </p>
          </div>
        </div>
      )}

      <WorkOrderModal
        open={jobFor !== null}
        editBooking={jobFor ?? undefined}
        onClose={() => setJobFor(null)}
      />

      {/* top overlay bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-wrap items-center gap-2 p-4">
        <div className="nvc-glass pointer-events-auto flex items-center gap-2 rounded-xl px-4 py-2.5">
          <Navigation className="h-4 w-4 text-cyan-glow" />
          <span className="font-display text-sm font-bold text-white">Map</span>
          <span className="ml-1 flex h-2 w-2">
            <span className="absolute inline-flex h-2 w-2 animate-ping rounded-full bg-emerald-live opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-live" />
          </span>
        </div>

        {/* view toggle: drivers / jobs / both */}
        <div className="nvc-glass pointer-events-auto flex items-center gap-1 rounded-xl p-1">
          <ToggleChip
            active={mode === "drivers"}
            onClick={() => setMode(true, false)}
            icon={Users}
            label="Drivers"
          />
          <ToggleChip
            active={mode === "jobs"}
            onClick={() => setMode(false, true)}
            icon={Briefcase}
            label="Jobs"
          />
          <ToggleChip
            active={mode === "both"}
            onClick={() => setMode(true, true)}
            icon={Layers}
            label="Both"
          />
        </div>

        {/* date range — only relevant when jobs are visible */}
        {showJobs && (
          <div className="nvc-glass pointer-events-auto flex items-center gap-2 rounded-xl px-3 py-2 text-xs">
            <Clock className="h-3.5 w-3.5 text-cyan-glow" />
            <input aria-label="Date From"
              type="date"
              value={dateFrom}
              max={dateTo}
              onChange={(e) => setDateFrom(e.target.value)}
              className="rounded-md bg-ink-3/70 px-2 py-1 text-slate-200 outline-none [color-scheme:dark]"
            />
            <span className="text-slate-500">→</span>
            <input aria-label="Date To"
              type="date"
              value={dateTo}
              min={dateFrom}
              onChange={(e) => setDateTo(e.target.value)}
              className="rounded-md bg-ink-3/70 px-2 py-1 text-slate-200 outline-none [color-scheme:dark]"
            />
            <button
              onClick={() => {
                setDateFrom(todayStr());
                setDateTo(todayStr());
              }}
              className="rounded-md bg-white/5 px-2 py-1 font-semibold text-slate-300 hover:bg-white/10"
            >
              Today
            </button>
            <span className="ml-0.5 rounded-md bg-cyan-glow/15 px-1.5 py-0.5 font-bold text-cyan-glow">
              {jobs.length}
            </span>
          </div>
        )}

        {/* tech status legend */}
        {showDrivers && (
          <div className="nvc-glass pointer-events-auto flex items-center gap-3 rounded-xl px-4 py-2.5 text-xs">
            {Object.entries(TECH_STATUS).map(([k, m]) => (
              <span key={k} className="flex items-center gap-1.5">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: m.color }}
                />
                <span className="text-slate-300">{m.label}</span>
                <span className="font-bold text-white">{counts[k] ?? 0}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* tech detail panel */}
      {active && (
        <div className="absolute right-4 top-20 bottom-4 z-20 w-[340px] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-2xl border border-white/10 bg-ink-2/95 backdrop-blur-xl shadow-2xl">
          <div className="flex items-center gap-3 border-b border-white/5 p-4">
            <TechAvatar
              name={active.name}
              photoUrl={(active as any).photoUrl}
              color={active.color}
              className="h-11 w-11"
              textClassName="text-sm"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate font-bold text-white">{active.name}</p>
              <p className="text-xs text-slate-400">{active.skillClass}</p>
            </div>
            <button
              onClick={() => setSelected(null)}
              className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-white/5 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-4 p-4">
            <div className="grid grid-cols-3 gap-2 text-center">
              <Stat
                icon={Gauge}
                label="Status"
                value={TECH_STATUS[active.status]?.label ?? active.status}
                color={TECH_STATUS[active.status]?.color}
              />
              <Stat
                icon={Star}
                label="Rating"
                value={active.rating?.toFixed(1) ?? "—"}
              />
              <Stat
                icon={Wrench}
                label="Jobs"
                value={String(active.completedJobs ?? 0)}
              />
            </div>

            <div className="rounded-xl bg-ink-3/60 p-3 text-sm">
              <p className="text-xs text-slate-500">Vehicle</p>
              <p className="font-medium text-slate-200">
                {active.vehicle || "—"}
              </p>
            </div>

            {active.task ? (
              <div className="rounded-xl border border-brand/20 bg-brand/5 p-3">
                <div className="mb-1 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wide text-cyan-glow">
                    Current Job
                  </p>
                  {active.task.priority && (
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-bold"
                      style={{
                        color: PRIORITY_META[active.task.priority]?.color,
                        background: `${PRIORITY_META[active.task.priority]?.color}22`,
                      }}
                    >
                      {PRIORITY_META[active.task.priority]?.label}
                    </span>
                  )}
                </div>
                <p className="font-semibold text-white">{active.task.title}</p>
                <p className="mt-1 flex items-start gap-1.5 text-xs text-slate-400">
                  <MapPin className="mt-0.5 h-3 w-3 shrink-0" />
                  {active.task.address}
                </p>
                {active.task.etaMins != null && (
                  <p className="mt-1.5 flex items-center gap-1.5 text-xs text-emerald-live">
                    <Clock className="h-3 w-3" /> ETA ~{active.task.etaMins} min
                  </p>
                )}
              </div>
            ) : (
              <div className="rounded-xl bg-ink-3/60 p-3 text-center text-sm text-slate-500">
                No active job
              </div>
            )}

            <div className="grid grid-cols-3 gap-2">
              {active.phone && (
                <a
                  href={`tel:${active.phone}`}
                  className="flex items-center justify-center gap-1.5 rounded-xl bg-white/5 py-2.5 text-sm font-semibold text-slate-200 hover:bg-white/10"
                >
                  <Phone className="h-4 w-4" /> Call
                </a>
              )}
              <button
                onClick={() => setSmsFor(active)}
                className="flex items-center justify-center gap-1.5 rounded-xl bg-white/5 py-2.5 text-sm font-semibold text-slate-200 hover:bg-white/10"
              >
                <Smartphone className="h-4 w-4" /> Text
              </button>
              <button
                onClick={() => { setChatFor(active); unreadQuery.refetch(); }}
                className="relative flex items-center justify-center gap-1.5 rounded-xl bg-white/5 py-2.5 text-sm font-semibold text-slate-200 hover:bg-white/10"
              >
                <MessageSquare className="h-4 w-4" /> Message
                {unreadCount > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-brand text-[10px] font-bold text-white">
                    {unreadCount}
                  </span>
                )}
              </button>
            </div>
            <button
              onClick={() => optimize.mutate(active.id)}
              disabled={optimize.isPending}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-brand py-2.5 text-sm font-semibold text-white hover:bg-brand-deep disabled:opacity-60"
            >
              <Sparkles className="h-4 w-4" />
              {optimize.isPending ? "Optimizing…" : "Optimize Route"}
            </button>

            {optimize.data && (
              <div className="rounded-xl border border-emerald-live/20 bg-emerald-live/5 p-3 text-sm">
                <p className="mb-2 flex items-center gap-1.5 font-semibold text-emerald-live">
                  <Sparkles className="h-3.5 w-3.5" /> Optimized route
                </p>
                {optimize.data.stops.length === 0 ? (
                  <p className="text-xs text-slate-400">No stops queued.</p>
                ) : (
                  <>
                    <ol className="space-y-1.5">
                      {optimize.data.stops.map((s, i) => (
                        <li
                          key={s.id}
                          className="flex items-center gap-2 text-xs"
                        >
                          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-emerald-live/20 text-[10px] font-bold text-emerald-live">
                            {i + 1}
                          </span>
                          <span className="flex-1 truncate text-slate-200">
                            {s.title}
                          </span>
                          <span className="text-slate-500">
                            {s.legKm}km · {s.legMins}m
                          </span>
                        </li>
                      ))}
                    </ol>
                    <div className="mt-2 flex justify-between border-t border-white/5 pt-2 text-xs">
                      <span className="text-slate-400">
                        Total {optimize.data.totalKm}km · {optimize.data.totalMins}m
                      </span>
                      {optimize.data.savedKm > 0 && (
                        <span className="font-semibold text-emerald-live">
                          saves {optimize.data.savedKm}km
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <SmsModal tech={smsFor} onClose={() => setSmsFor(null)} />
      <ChatDrawer tech={chatFor} onClose={() => setChatFor(null)} />
    </div>
  );
}

function SmsModal({ tech, onClose }: { tech: any; onClose: () => void }) {
  const [body, setBody] = useState("");
  const [done, setDone] = useState("");
  const send = useMutation({
    mutationFn: async () => {
      const res = await api.fleet[":techId"].sms.$post({
        param: { techId: tech.id },
        json: { body },
      });
      const j = await res.json();
      if (!res.ok) throw new Error((j as any).message || "Failed to send");
      return j as any;
    },
    onSuccess: (j) => {
      setBody("");
      setDone(j.skipped ? "Logged (SMS not configured)" : "SMS sent ✓");
      setTimeout(() => setDone(""), 2500);
    },
  });
  return (
    <Modal
      open={!!tech}
      onClose={onClose}
      title={`Text ${tech?.name ?? ""}`}
      subtitle={tech?.phone || "No number on file"}
      size="sm"
      footer={
        <>
          <BtnGhost onClick={onClose}>Close</BtnGhost>
          <BtnPrimary
            onClick={() => send.mutate()}
            disabled={send.isPending || !body.trim()}
          >
            <Send className="h-3.5 w-3.5" />
            {send.isPending ? "Sending…" : "Send SMS"}
          </BtnPrimary>
        </>
      }
    >
      <textarea aria-label="Type your message…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={4}
        placeholder="Type your message…"
        className={inputCls}
      />
      {send.error && (
        <p className="mt-2 text-sm text-red-400">
          {(send.error as Error).message}
        </p>
      )}
      {done && <p className="mt-2 text-sm text-emerald-live">{done}</p>}
    </Modal>
  );
}

function ChatDrawer({ tech, onClose }: { tech: any; onClose: () => void }) {
  const { noun } = useWorkerNoun();
  const [body, setBody] = useState("");
  const thread = useQuery({
    queryKey: ["fleet-thread", tech?.id],
    queryFn: async () =>
      (
        await api.fleet[":techId"].thread.$get({ param: { techId: tech.id } })
      ).json(),
    enabled: !!tech,
    refetchInterval: 4000,
  });
  const post = useMutation({
    mutationFn: async () => {
      const res = await api.fleet[":techId"].thread.$post({
        param: { techId: tech.id },
        json: { body },
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => {
      setBody("");
      thread.refetch();
    },
  });

  // Explicitly ack read ONCE when this drawer opens for a tech — not on every
  // poll. The GET no longer marks-as-read as a side effect (it used to, which
  // meant this drawer's own 4s poll could silently clear unread state before
  // a dispatcher ever actually looked at a new message).
  useEffect(() => {
    if (!tech?.id) return;
    api.fleet[":techId"]["thread"]["mark-read"].$post({ param: { techId: tech.id } }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tech?.id]);

  if (!tech) return null;
  const direct = (thread.data as any)?.direct ?? [];
  const job = (thread.data as any)?.job ?? null;

  const Bubble = ({ m }: { m: any }) => {
    const mine = m.senderRole === "dispatch";
    return (
      <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
        <div
          className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${mine ? "bg-brand text-white" : "bg-ink-3 text-slate-200"}`}
        >
          <p>{m.body}</p>
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
  };

  return (
    <div className="absolute inset-0 z-30 flex justify-end bg-black/40 backdrop-blur-sm">
      <div className="flex h-full w-full max-w-md flex-col border-l border-white/10 bg-ink-2 shadow-2xl">
        <div className="flex items-center gap-3 border-b border-white/5 p-4">
          <TechAvatar
            name={tech.name}
            photoUrl={(tech as any).photoUrl}
            color={tech.color}
            className="h-10 w-10"
            textClassName="text-sm"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate font-bold text-white">{tech.name}</p>
            <p className="text-xs text-slate-400">Direct message · in-app</p>
          </div>
          <button
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-white/5 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Direct chat
            </p>
            <div className="space-y-2">
              {direct.length === 0 ? (
                <p className="py-4 text-center text-xs text-slate-600">
                  No messages yet. Say hi 👋
                </p>
              ) : (
                direct.map((m: any) => <Bubble key={m.id} m={m} />)
              )}
            </div>
          </div>

          {job && (
            <div className="rounded-xl border border-brand/15 bg-brand/5 p-3">
              <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-cyan-glow">
                <Wrench className="h-3 w-3" /> Job thread · {job.title}
              </p>
              <div className="space-y-2">
                {job.messages.length === 0 ? (
                  <p className="py-2 text-center text-xs text-slate-600">
                    No job messages
                  </p>
                ) : (
                  job.messages.map((m: any) => <Bubble key={m.id} m={m} />)
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-white/5 p-3">
          <input aria-label={`Message ${noun.toLowerCase()}…`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) =>
              e.key === "Enter" && body.trim() && post.mutate()
            }
            placeholder={`Message ${noun.toLowerCase()}…`}
            className={inputCls}
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
    </div>
  );
}

function ToggleChip({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: any;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
        active
          ? "bg-brand text-white shadow"
          : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: any;
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="rounded-xl bg-ink-3/60 p-2.5">
      <Icon className="mx-auto mb-1 h-4 w-4 text-slate-500" />
      <p
        className="truncate text-sm font-bold"
        style={{ color: color ?? "#fff" }}
      >
        {value}
      </p>
      <p className="text-[10px] text-slate-500">{label}</p>
    </div>
  );
}
