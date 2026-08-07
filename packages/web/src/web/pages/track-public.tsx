import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute } from "wouter";
import { api } from "../lib/api";
import { LiveMap } from "../components/live-map";
import { Logo } from "../components/brand";
import { TechAvatar } from "../components/tech-avatar";
import { STATUS_META } from "../lib/utils";
import {
  Phone,
  MessageCircle,
  Send,
  Star,
  Truck,
  Clock,
  MapPin,
  ShieldCheck,
  MessageSquare,
  CheckCircle2,
  Mail,
  Building2,
  AlertTriangle,
  Navigation,
  Wrench,
  CalendarCheck,
  UserCheck,
  Camera,
  PenLine,
  Package,
  History,
  X,
  FileText,
  ExternalLink,
} from "lucide-react";

// ─── Formatting helpers ───────────────────────────────────────────────────────
function fmtTime(v: string | number | null | undefined) {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtDate(v: string | number | null | undefined) {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}
function fmtDateTime(v: string | number | null | undefined) {
  if (!v) return "—";
  const s = `${fmtDate(v)} · ${fmtTime(v)}`;
  return s === " · " ? "—" : s;
}

/** Icon per timeline event kind. Unknown kinds fall back to a neutral dot. */
const EVENT_ICON: Record<string, typeof CheckCircle2> = {
  created: CalendarCheck,
  assigned: UserCheck,
  enroute: Navigation,
  arrived: MapPin,
  started: Wrench,
  completed: CheckCircle2,
  cancelled: AlertTriangle,
  photo_added: Camera,
  signature_captured: FileText,
  checklist_completed: CheckCircle2,
};

// ─── Job timeline ─────────────────────────────────────────────────────────────
// The narrative of the job: every customer-visible event, timestamped, newest
// last so it reads top-to-bottom like a story. Photos attached to an event get
// an inline thumbnail.
function JobTimeline({
  events,
  onPhoto,
}: {
  events: any[];
  onPhoto: (url: string) => void;
}) {
  if (!events?.length) return null;
  return (
    <div className="nvc-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <History className="h-4 w-4 text-cyan-glow" />
        <p className="font-bold text-white">Job timeline</p>
      </div>
      <ol className="relative space-y-4 pl-1">
        {events.map((e, i) => {
          const Icon = EVENT_ICON[e.kind] ?? Clock;
          const last = i === events.length - 1;
          const photoUrl = e.meta?.url as string | undefined;
          return (
            <li key={e.id ?? i} className="relative flex gap-3">
              {!last && (
                <span className="absolute left-[13px] top-7 h-[calc(100%+0.25rem)] w-px bg-white/10" />
              )}
              <span className="relative z-10 mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border border-white/10 bg-ink-3 text-cyan-glow">
                <Icon className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1 pb-1">
                <p className="text-sm font-semibold leading-tight text-white">
                  {e.label || e.kind}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {fmtTime(e.at)}
                  {e.actorName ? ` · ${e.actorName}` : ""}
                  {e.detail ? ` · ${e.detail}` : ""}
                </p>
                {photoUrl && (
                  <button
                    onClick={() => onPhoto(photoUrl)}
                    className="mt-2 block overflow-hidden rounded-lg border border-white/10 transition hover:border-cyan-glow/50"
                  >
                    <img src={photoUrl} alt="Job photo" className="h-20 w-28 object-cover" />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ─── Photo gallery ────────────────────────────────────────────────────────────
function PhotoGallery({
  photos,
  onPhoto,
}: {
  photos: any[];
  onPhoto: (url: string) => void;
}) {
  if (!photos?.length) return null;

  // Before/after is the whole point of job documentation — group it so the
  // customer can see the difference at a glance instead of a flat pile.
  const before = photos.filter((p: any) => p.phase === "before");
  const after = photos.filter((p: any) => p.phase === "after");
  const during = photos.filter((p: any) => p.phase !== "before" && p.phase !== "after");
  const grouped = before.length > 0 || after.length > 0;

  const Grid = ({ items }: { items: any[] }) => (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {items.map((p: any) => (
        <button
          key={p.id}
          onClick={() => onPhoto(p.url)}
          className="group relative overflow-hidden rounded-lg border border-white/10 transition hover:border-cyan-glow/50"
        >
          <img
            src={p.url}
            alt={p.caption || "Job photo"}
            className="aspect-square w-full object-cover transition group-hover:scale-105"
          />
          {p.caption && (
            <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-4 text-left text-[10px] text-white/90">
              {p.caption}
            </span>
          )}
        </button>
      ))}
    </div>
  );

  const Section = ({ label, items }: { label: string; items: any[] }) =>
    items.length ? (
      <div>
        <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-500">
          {label} <span className="text-slate-600">({items.length})</span>
        </p>
        <Grid items={items} />
      </div>
    ) : null;

  return (
    <div className="nvc-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Camera className="h-4 w-4 text-cyan-glow" />
        <p className="font-bold text-white">Photos</p>
        <span className="text-xs text-slate-500">({photos.length})</span>
      </div>
      {grouped ? (
        <div className="space-y-4">
          <Section label="Before" items={before} />
          <Section label="During" items={during} />
          <Section label="After" items={after} />
        </div>
      ) : (
        <Grid items={photos} />
      )}
    </div>
  );
}

// ─── Sign-off ─────────────────────────────────────────────────────────────────
function SignOff({ signature }: { signature: any }) {
  if (!signature?.url) return null;
  return (
    <div className="nvc-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <PenLine className="h-4 w-4 text-cyan-glow" />
        <p className="font-bold text-white">Sign-off</p>
      </div>
      <div className="rounded-lg bg-white p-3">
        <img src={signature.url} alt="Signature" className="mx-auto h-20 object-contain" />
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Signed by <span className="font-semibold text-slate-300">{signature.name}</span>
        {signature.at ? ` · ${new Date(Number(signature.at)).toLocaleString()}` : ""}
      </p>
    </div>
  );
}

// ─── Materials used ───────────────────────────────────────────────────────────
// Deliberately shows WHAT was used, never what it cost. Pricing never appears
// on a customer-facing surface.
function MaterialsUsed({ materials }: { materials: any[] }) {
  if (!materials?.length) return null;
  return (
    <div className="nvc-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Package className="h-4 w-4 text-cyan-glow" />
        <p className="font-bold text-white">Materials &amp; work performed</p>
      </div>
      <ul className="divide-y divide-white/5">
        {materials.map((m: any, i: number) => (
          <li key={i} className="flex items-center justify-between gap-3 py-2">
            <span className="text-sm text-slate-200">{m.name}</span>
            <span className="shrink-0 text-xs font-semibold text-slate-400">
              {m.qty}
              {m.unit ? ` ${m.unit}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Lightbox ─────────────────────────────────────────────────────────────────
function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[1000] grid place-items-center bg-black/85 p-4 backdrop-blur-sm"
    >
      <button
        onClick={onClose}
        aria-label="Close photo"
        className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20"
      >
        <X className="h-5 w-5" />
      </button>
      <img
        src={url}
        alt="Job photo"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] max-w-full rounded-xl object-contain"
      />
    </div>
  );
}

// ─── Status stepper ───────────────────────────────────────────────────────────
const STEPS = [
  { key: "pending",     label: "Confirmed",  Icon: CalendarCheck },
  { key: "assigned",   label: "Assigned",   Icon: UserCheck },
  { key: "enroute",    label: "En Route",   Icon: Navigation },
  { key: "arrived",    label: "Arrived",    Icon: MapPin },
  { key: "in_progress",label: "In Progress",Icon: Wrench },
  { key: "completed",  label: "Complete",   Icon: CheckCircle2 },
] as const;

// order index for each status (higher = further along)
const STATUS_ORDER: Record<string, number> = {
  pending: 0, assigned: 1, enroute: 2, arrived: 3, in_progress: 4, completed: 5,
};

function StatusStepper({ status }: { status: string }) {
  const current = STATUS_ORDER[status] ?? 0;
  // cancelled gets a special display — skip the stepper
  if (status === "cancelled") return null;

  return (
    <div className="nvc-card p-4">
      <div className="relative flex items-start justify-between">
        {/* connecting line */}
        <div className="absolute left-0 right-0 top-[18px] mx-[18px] h-0.5 bg-white/10" />
        <div
          className="absolute left-0 top-[18px] h-0.5 bg-cyan-glow transition-all duration-700"
          style={{
            marginLeft: 18,
            width: current === 0
              ? "0%"
              : `calc(${(current / (STEPS.length - 1)) * 100}% - ${current === STEPS.length - 1 ? 36 : 18}px)`,
          }}
        />
        {STEPS.map((step, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <div key={step.key} className="relative flex flex-col items-center gap-1.5" style={{ flex: 1 }}>
              <span
                className={`relative z-10 flex h-9 w-9 items-center justify-center rounded-full border-2 transition-all duration-500 ${
                  done
                    ? "border-cyan-glow bg-cyan-glow text-ink"
                    : active
                    ? "border-cyan-glow bg-ink text-cyan-glow shadow-[0_0_12px_rgba(14,165,233,0.5)]"
                    : "border-white/15 bg-ink text-slate-600"
                }`}
              >
                {done ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <step.Icon className="h-4 w-4" />
                )}
                {active && (
                  <span className="absolute inset-0 animate-ping rounded-full border-2 border-cyan-glow opacity-40" />
                )}
              </span>
              <span
                className={`text-center text-[10px] font-semibold leading-tight ${
                  active ? "text-cyan-glow" : done ? "text-slate-400" : "text-slate-600"
                }`}
              >
                {step.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Live ETA countdown ───────────────────────────────────────────────────────
// Takes the server-supplied etaMins and counts down second-by-second.
// Resets whenever etaMins changes (new server snapshot).
function useLiveEta(etaMins: number | null | undefined) {
  const [secsLeft, setSecsLeft] = useState<number | null>(null);
  const baseRef = useRef<{ at: number; secs: number } | null>(null);

  useEffect(() => {
    if (etaMins == null) { setSecsLeft(null); baseRef.current = null; return; }
    const secs = Math.round(etaMins * 60);
    baseRef.current = { at: Date.now(), secs };
    setSecsLeft(secs);
  }, [etaMins]);

  useEffect(() => {
    const id = setInterval(() => {
      if (!baseRef.current) return;
      const elapsed = Math.floor((Date.now() - baseRef.current.at) / 1000);
      const remaining = Math.max(0, baseRef.current.secs - elapsed);
      setSecsLeft(remaining);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  if (secsLeft == null) return null;
  const mins = Math.floor(secsLeft / 60);
  const secs = secsLeft % 60;
  if (mins >= 2) return `${mins} min`;
  if (secsLeft > 0) return `${mins}:${String(secs).padStart(2, "0")}`;
  return "Arriving now";
}

// ─── Proximity alert banner ───────────────────────────────────────────────────
// Haversine distance between two lat/lng points, returns metres.
function haversineM(
  lat1: number, lng1: number, lat2: number, lng2: number,
): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function TrackPublic() {
  const [, params] = useRoute("/t/:token");
  const token = params?.token ?? "";
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sseUp, setSseUp] = useState(false);
  const alertedRef = useRef(false);
  const [showProximityAlert, setShowProximityAlert] = useState(false);
  // Review state
  const [reviewRating, setReviewRating] = useState(0);
  const [reviewHover, setReviewHover] = useState(0);
  const [reviewComment, setReviewComment] = useState("");
  const [reviewSubmitted, setReviewSubmitted] = useState(false);
  // Set only for 4-5 star ratings when the tenant configured a public review
  // link. Lower ratings are never routed anywhere public.
  const [publicReviewUrl, setPublicReviewUrl] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const track = useQuery({
    queryKey: ["track", token],
    queryFn: async () =>
      (await api.track[":token"].$get({ param: { token } })).json(),
    refetchInterval: sseUp ? 20000 : 2500,
    enabled: !!token,
  });

  // SSE — pushes fresh snapshot on every driver ping / status change
  useEffect(() => {
    if (!token) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const connect = () => {
      if (stopped) return;
      es = new EventSource(`/api/track/${token}/stream`);
      es.addEventListener("snapshot", (ev) => {
        try {
          const snap = JSON.parse((ev as MessageEvent).data);
          qc.setQueryData(["track", token], snap);
          setSseUp(true);
        } catch { /* ignore */ }
      });
      es.onerror = () => {
        setSseUp(false);
        es?.close();
        if (!stopped) retry = setTimeout(connect, 4000);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }, [token, qc]);

  const messages = useQuery({
    queryKey: ["track-msgs", token],
    queryFn: async () =>
      (await api.track[":token"].messages.$get({ param: { token } })).json(),
    refetchInterval: 4000,
    enabled: !!token,
  });

  const send = useMutation({
    mutationFn: async (body: string) =>
      (
        await api.track[":token"].messages.$post({
          param: { token },
          json: { body, senderName: "Client" },
        })
      ).json(),
    onSuccess: () => {
      setDraft("");
      qc.invalidateQueries({ queryKey: ["track-msgs", token] });
    },
  });

  const submitReview = useMutation({
    mutationFn: async ({ rating, comment }: { rating: number; comment: string }) => {
      const res = await fetch(`/api/track/${token}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, comment }),
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: (res: any) => {
      setReviewSubmitted(true);
      setPublicReviewUrl(res?.publicReviewUrl ?? null);
    },
  });

  const msgs = (messages.data as any)?.messages ?? [];
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs.length]);

  const data = track.data as any;

  // proximity check — fire when driver enters 500m radius, once per session
  useEffect(() => {
    if (alertedRef.current || !data) return;
    const tl = data.techLocation;
    const dest = data.destination;
    if (!tl?.lat || !dest?.lat) return;
    const distM = haversineM(tl.lat, tl.lng, dest.lat, dest.lng);
    if (distM <= 500 && ["enroute", "assigned"].includes(data.status)) {
      alertedRef.current = true;
      setShowProximityAlert(true);
      // auto-dismiss after 8s
      setTimeout(() => setShowProximityAlert(false), 8000);
    }
  }, [data]);

  const liveEta = useLiveEta(data?.etaMins);

  // ── loading / not found ──
  if (track.isLoading)
    return (
      <div className="grid min-h-screen place-items-center bg-ink text-slate-400">
        Loading…
      </div>
    );

  if (!data || data.message === "Not found")
    return (
      <div className="grid min-h-screen place-items-center bg-ink px-6 text-center">
        <div>
          <Logo light className="mb-4 justify-center" />
          <p className="text-slate-400">
            This tracking link is invalid or has expired.
          </p>
        </div>
      </div>
    );

  const meta =
    STATUS_META[data.status] ?? { label: data.status, color: "#64748b" };
  const isDone =
    data.status === "completed" || data.status === "cancelled";
  const company = data.company as {
    name?: string;
    email?: string;
    phone?: string;
  } | null;
  const workerNoun: string = data.workerNoun || "Technician";
  const isEnroute = data.status === "enroute" || data.status === "assigned";
  const timeline: any[] = data.timeline ?? [];
  const photos: any[] = data.photos ?? [];
  const materials: any[] = data.materials ?? [];
  const isComplete = data.status === "completed";
  const isArrived = data.status === "arrived" || data.status === "in_progress";

  return (
    <div className="nvc-grid-bg min-h-screen bg-ink text-slate-200">
      {/* ── Header ── */}
      <header className="border-b border-white/5 bg-ink-2/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Logo light />
          <span className="flex items-center gap-1.5 text-xs text-slate-500">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-live" /> Secure live
            tracking
          </span>
        </div>
      </header>

      {/* ── Proximity alert banner ── */}
      {showProximityAlert && (
        <div className="animate-in slide-in-from-top border-b border-amber-warn/30 bg-amber-warn/10 px-4 py-3">
          <div className="mx-auto flex max-w-5xl items-center gap-3">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-warn" />
            <p className="text-sm font-semibold text-amber-warn">
              Your {workerNoun.toLowerCase()} is less than 5 minutes away — please be ready!
            </p>
            <button
              onClick={() => setShowProximityAlert(false)}
              className="ml-auto text-slate-400 hover:text-white"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <div className="mx-auto max-w-5xl px-4 py-6">
        {/* ── Title + status pill ── */}
        <div className="mb-4">
          <h1 className="font-display text-xl font-bold text-white">
            {data.title}
          </h1>
          <span
            className="mt-1 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
            style={{ color: meta.color, background: `${meta.color}22` }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: meta.color }}
            />
            {meta.label}
          </span>
        </div>

        {/* ── Status stepper ── */}
        {!isDone && <div className="mb-4"><StatusStepper status={data.status} /></div>}

        <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
          {/* ── Left column ── */}
          <div className="space-y-4">
            {isDone ? (
              /* Completion summary + review */
              <div className="space-y-4">
                <div className="nvc-card p-6 text-center">
                  <span
                    className="mx-auto grid h-14 w-14 place-items-center rounded-2xl"
                    style={{ background: `${meta.color}22`, color: meta.color }}
                  >
                    <CheckCircle2 className="h-7 w-7" />
                  </span>
                  <h2 className="mt-4 font-display text-lg font-bold text-white">
                    {data.status === "completed"
                      ? "Job complete — thanks for choosing us!"
                      : "This job was cancelled"}
                  </h2>
                  <p className="mt-1 text-sm text-slate-400">
                    {data.status === "completed"
                      ? "We hope everything went smoothly. If anything needs attention, reach out below."
                      : "If you have any questions, reach out to the company below."}
                  </p>
                  <div className="mt-5 space-y-3 text-left">
                    {company?.name && (
                      <div className="flex items-start gap-3 rounded-xl border border-white/10 bg-ink-3/50 p-3">
                        <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-cyan-glow" />
                        <div>
                          <p className="text-xs text-slate-500">Company</p>
                          <p className="text-sm font-semibold text-white">{company.name}</p>
                        </div>
                      </div>
                    )}
                    {data.tech?.name && (
                      <div className="flex items-start gap-3 rounded-xl border border-white/10 bg-ink-3/50 p-3">
                        <TechAvatar
                          name={data.tech.name}
                          photoUrl={data.tech.photoUrl}
                          color={data.tech.color}
                          className="h-9 w-9"
                          textClassName="text-sm"
                        />
                        <div>
                          <p className="text-xs text-slate-500">{workerNoun}</p>
                          <p className="text-sm font-semibold text-white">{data.tech.name}</p>
                        </div>
                      </div>
                    )}
                  </div>
                  {company?.email && (
                    <a
                      href={`mailto:${company.email}?subject=${encodeURIComponent(`Re: ${data.title}`)}`}
                      className="mt-5 flex items-center justify-center gap-2 rounded-xl bg-brand py-2.5 text-sm font-semibold text-white hover:bg-brand-deep"
                    >
                      <Mail className="h-4 w-4" /> Email {company.name || "the company"}
                    </a>
                  )}
                </div>

                {/* Star rating — only for completed jobs */}
                {data.status === "completed" && (
                  <div className="nvc-card p-5">
                    {reviewSubmitted ? (
                      <div className="flex flex-col items-center gap-2 py-3 text-center">
                        <CheckCircle2 className="h-8 w-8 text-emerald-live" />
                        <p className="font-bold text-white">Thanks for your feedback!</p>
                        <p className="text-sm text-slate-400">
                          {publicReviewUrl
                            ? "Glad we hit the mark. Would you share that publicly?"
                            : "Your review helps us improve."}
                        </p>
                        {publicReviewUrl && (
                          <a
                            href={publicReviewUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-brand py-2.5 text-sm font-semibold text-white hover:bg-brand-deep"
                          >
                            <Star className="h-4 w-4" /> Leave a Google review
                          </a>
                        )}
                      </div>
                    ) : (
                      <>
                        <p className="mb-1 text-center text-sm font-bold text-white">How was your experience?</p>
                        <p className="mb-4 text-center text-xs text-slate-500">
                          Rate your {workerNoun.toLowerCase()}{data.tech?.name ? `, ${data.tech.name}` : ""}
                        </p>
                        <div className="mb-4 flex justify-center gap-2">
                          {[1, 2, 3, 4, 5].map((n) => (
                            <button
                              key={n}
                              onClick={() => setReviewRating(n)}
                              onMouseEnter={() => setReviewHover(n)}
                              onMouseLeave={() => setReviewHover(0)}
                              className="transition-transform hover:scale-110"
                            >
                              <Star
                                className={`h-9 w-9 ${
                                  n <= (reviewHover || reviewRating)
                                    ? "fill-amber-warn text-amber-warn"
                                    : "text-slate-600"
                                }`}
                              />
                            </button>
                          ))}
                        </div>
                        {reviewRating > 0 && (
                          <>
                            <textarea
                              aria-label="Review comments"
                              value={reviewComment}
                              onChange={(e) => setReviewComment(e.target.value)}
                              placeholder="Any comments? (optional)"
                              rows={2}
                              className="mb-3 w-full resize-none rounded-xl border border-white/10 bg-ink-3/60 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-brand focus:outline-none"
                            />
                            <button
                              onClick={() => submitReview.mutate({ rating: reviewRating, comment: reviewComment })}
                              disabled={submitReview.isPending}
                              className="w-full rounded-xl bg-brand py-2.5 text-sm font-semibold text-white hover:bg-brand-deep disabled:opacity-50"
                            >
                              {submitReview.isPending ? "Submitting…" : "Submit review"}
                            </button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            ) : (
              /* Live tracking view */
              <>
                {/* Map */}
                <div className="overflow-hidden rounded-2xl border border-white/10">
                  <LiveMap
                    rider={data.techLocation}
                    destination={data.destination}
                    route={data.route}
                    etaMins={data.etaMins}
                    className="h-[340px] w-full"
                  />
                </div>

                {/* ETA card — live countdown while en route, arrived banner once there */}
                {isArrived ? (
                  <div className="nvc-card flex items-center gap-3 p-4">
                    <span className="grid h-11 w-11 place-items-center rounded-xl bg-emerald-live/15 text-emerald-live">
                      <MapPin className="h-5 w-5" />
                    </span>
                    <div>
                      <p className="font-display text-lg font-bold text-white">
                        {data.status === "in_progress" ? "Job in progress" : "Your tech has arrived!"}
                      </p>
                      <p className="text-xs text-slate-400">
                        {data.status === "in_progress"
                          ? "Work is underway at your location"
                          : "They are on-site and ready to begin"}
                      </p>
                    </div>
                  </div>
                ) : liveEta != null ? (
                  <div className="nvc-card flex items-center gap-3 p-4">
                    <span className="relative grid h-11 w-11 place-items-center rounded-xl bg-emerald-live/15 text-emerald-live">
                      <Clock className="h-5 w-5" />
                      {isEnroute && (
                        <span className="absolute inset-0 animate-ping rounded-xl bg-emerald-live/20" />
                      )}
                    </span>
                    <div className="flex-1">
                      <div className="flex items-baseline gap-2">
                        <p className="font-display text-2xl font-bold tabular-nums text-white">
                          {liveEta}
                        </p>
                        {liveEta !== "Arriving now" && (
                          <span className="text-xs text-slate-400">estimated arrival</span>
                        )}
                      </div>
                      {data.etaDistanceKm != null && (
                        <p className="text-xs text-slate-500">
                          {data.etaDistanceKm < 1
                            ? `${Math.round(data.etaDistanceKm * 1000)} m away`
                            : `${data.etaDistanceKm.toFixed(1)} km away`}
                        </p>
                      )}
                    </div>
                    {/* live pulse dot */}
                    {sseUp && (
                      <span className="flex items-center gap-1 text-[10px] text-emerald-live">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-live" />
                        Live
                      </span>
                    )}
                  </div>
                ) : null}

                {/* Destination */}
                <div className="nvc-card flex items-start gap-3 p-4">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-cyan-glow" />
                  <div>
                    <p className="text-xs text-slate-500">Destination</p>
                    <p className="text-sm text-slate-200">
                      {data.destination?.address}
                    </p>
                  </div>
                </div>
              </>
            )}

            {/* ── Permanent job record (completed jobs) ── */}
            {isComplete && (
              <div className="nvc-card p-4">
                <div className="mb-3 flex items-center gap-2">
                  <FileText className="h-4 w-4 text-cyan-glow" />
                  <p className="font-bold text-white">Service record</p>
                </div>
                <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                  <div>
                    <dt className="text-[11px] uppercase tracking-wide text-slate-500">Service</dt>
                    <dd className="text-sm text-slate-200">{data.service?.name || data.title}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-wide text-slate-500">{workerNoun}</dt>
                    <dd className="text-sm text-slate-200">{data.tech?.name || "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-wide text-slate-500">Scheduled</dt>
                    <dd className="text-sm text-slate-200">{fmtDateTime(data.scheduledAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-wide text-slate-500">Completed</dt>
                    <dd className="text-sm text-slate-200">{fmtDateTime(data.finishedAt)}</dd>
                  </div>
                  {data.onSiteMinutes > 0 && (
                    <div>
                      <dt className="text-[11px] uppercase tracking-wide text-slate-500">Time on site</dt>
                      <dd className="text-sm text-slate-200">
                        {data.onSiteMinutes >= 60
                          ? `${Math.floor(data.onSiteMinutes / 60)}h ${Math.round(data.onSiteMinutes % 60)}m`
                          : `${Math.round(data.onSiteMinutes)} min`}
                      </dd>
                    </div>
                  )}
                  {data.address && (
                    <div className="sm:col-span-2">
                      <dt className="text-[11px] uppercase tracking-wide text-slate-500">Address</dt>
                      <dd className="text-sm text-slate-200">{data.address}</dd>
                    </div>
                  )}
                </dl>
                <p className="mt-4 rounded-lg border border-white/5 bg-ink-3/40 px-3 py-2 text-[11px] text-slate-500">
                  This link is permanent — bookmark it to keep a record of this
                  visit.
                </p>
              </div>
            )}

            {/* ── Shared: narrative, photos, materials ── */}
            <JobTimeline events={timeline} onPhoto={setLightbox} />
            <PhotoGallery photos={photos} onPhoto={setLightbox} />
            <MaterialsUsed materials={materials} />
            <SignOff signature={data.signature} />

            {/* ── Property hub ── */}
            {data.propertyLink && (
              <a
                href={data.propertyLink}
                className="nvc-card flex items-center gap-3 p-4 transition hover:border-cyan-glow/40"
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-cyan-glow/15 text-cyan-glow">
                  <Building2 className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-white">
                    Full service history for this address
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    Every visit, photo and material — no login needed
                  </p>
                </div>
                <ExternalLink className="h-4 w-4 shrink-0 text-slate-500" />
              </a>
            )}
          </div>

          {/* ── Right column: tech card + messaging ── */}
          <div className="space-y-4">
              {data.tech && !isDone && (
                <div className="nvc-card p-4">
                  <div className="flex items-center gap-3">
                    <TechAvatar
                      name={data.tech.name}
                      photoUrl={data.tech.photoUrl}
                      color={data.tech.color}
                      className="h-12 w-12"
                      textClassName="text-base"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-bold text-white">
                        {data.tech.name}
                      </p>
                      <p className="flex items-center gap-1 text-xs text-slate-400">
                        <Star className="h-3 w-3 fill-amber-warn text-amber-warn" />
                        {data.tech.rating?.toFixed(1) ?? "—"} ·{" "}
                        {data.tech.skillClass}
                      </p>
                    </div>
                  </div>
                  {data.tech.vehicle && (
                    <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-400">
                      <Truck className="h-3.5 w-3.5" /> {data.tech.vehicle}
                    </p>
                  )}
                  {data.tech.phone && (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <a
                        href={`tel:${data.tech.phone}`}
                        className="flex items-center justify-center gap-2 rounded-xl bg-brand py-2.5 text-sm font-semibold text-white hover:bg-brand-deep"
                      >
                        <Phone className="h-4 w-4" /> Call
                      </a>
                      <a
                        href={`sms:${data.tech.phone}`}
                        className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-ink-3 py-2.5 text-sm font-semibold text-slate-200 hover:bg-ink-3/80"
                      >
                        <MessageCircle className="h-4 w-4" /> Text
                      </a>
                    </div>
                  )}
                </div>
              )}

              {/* Messaging */}
              <div className="nvc-card flex h-[360px] flex-col">
                <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
                  <MessageSquare className="h-4 w-4 text-cyan-glow" />
                  <p className="font-bold text-white">Messages</p>
                </div>
                <div
                  ref={scrollRef}
                  className="flex-1 space-y-2 overflow-y-auto p-3"
                >
                  {msgs.length === 0 ? (
                    <p className="py-10 text-center text-xs text-slate-600">
                      Send a message to your {workerNoun.toLowerCase()}
                    </p>
                  ) : (
                    msgs.map((m: any) => {
                      const mine = m.senderRole === "client";
                      return (
                        <div
                          key={m.id}
                          className={`flex ${mine ? "justify-end" : "justify-start"}`}
                        >
                          <div
                            className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${
                              mine
                                ? "bg-brand text-white"
                                : "bg-ink-3 text-slate-200"
                            }`}
                          >
                            {!mine && (
                              <p className="mb-0.5 text-[10px] font-semibold text-cyan-glow">
                                {m.senderName}
                              </p>
                            )}
                            {m.body}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (draft.trim()) send.mutate(draft.trim());
                  }}
                  className="flex gap-2 border-t border-white/5 p-3"
                >
                  <input
                    aria-label="Type a message…"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Type a message…"
                    className="flex-1 rounded-lg border border-white/10 bg-ink-3/60 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-brand focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={!draft.trim() || send.isPending}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand text-white hover:bg-brand-deep disabled:opacity-50"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                </form>
              </div>
            </div>
        </div>
      </div>
      {lightbox && <Lightbox url={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}
