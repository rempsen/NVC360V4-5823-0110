import { useParams, Link, useLocation } from "wouter";
import { UserFacingError } from "../../lib/api-error";
import { DialogPanel } from "../../components/dialog-panel";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { InferRequestType } from "hono/client";
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";

/** The job statuses the status route accepts — sourced from the route itself. */
type JobStatus = InferRequestType<typeof api.bookings[":id"]["status"]["$post"]>["json"]["status"];
import { LiveMap } from "../../components/live-map";
import { StatusBadge } from "../../components/brand";
import { FullLoader, Loader } from "../../components/loader";
import { fmtDate } from "../../lib/utils";
import {
  ArrowLeft, MapPin, Phone, Navigation, CheckCircle2, Play, Flag, Radio, Check, X, AlertTriangle, HandMetal,
} from "lucide-react";

// Handing back a job the tech already ACCEPTED. Fixed reasons so the office can
// see patterns. Must stay in sync with RELEASE_REASONS in
// packages/web/src/api/routes/bookings.ts and the driver app.
const RELEASE_REASONS: { key: string; label: string }[] = [
  { key: "emergency", label: "Personal emergency" },
  { key: "vehicle", label: "Vehicle breakdown" },
  { key: "running_late", label: "Running too late to make it" },
  { key: "missing_parts", label: "Missing parts or equipment" },
  { key: "unsafe_site", label: "Unsafe site conditions" },
  { key: "wrong_skills", label: "Wrong skill set for this job" },
  { key: "other", label: "Other" },
];
const RELEASABLE = new Set(["assigned", "confirmed", "enroute", "arrived", "onsite", "in_progress", "paused"]);

// status flow buttons for the rider
const FLOW: Record<string, { next: JobStatus; label: string; icon: any }> = {
  assigned: { next: "enroute", label: "Start driving", icon: Play },
  enroute: { next: "arrived", label: "I've arrived", icon: Flag },
  arrived: { next: "in_progress", label: "Begin service", icon: Play },
  in_progress: { next: "completed", label: "Complete job", icon: CheckCircle2 },
};

export default function RiderActive() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [sharing, setSharing] = useState(false);
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(null);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [releaseReason, setReleaseReason] = useState("");
  const [releaseNote, setReleaseNote] = useState("");
  const [releaseErr, setReleaseErr] = useState("");
  const watchRef = useRef<number | null>(null);
  const simRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const booking = useQuery({
    queryKey: ["booking", id],
    queryFn: async () => (await api.bookings[":id"].$get({ param: { id } })).json(),
    refetchInterval: 6000,
  });

  const ping = useMutation({
    mutationFn: async (p: { lat: number; lng: number }) => {
      await api.tracking[":bookingId"].ping.$post({ param: { bookingId: id }, json: p });
    },
  });

  const setStatus = useMutation({
    mutationFn: async (status: JobStatus) => {
      await api.bookings[":id"].status.$post({ param: { id }, json: { status } });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["booking", id] });
      qc.invalidateQueries({ queryKey: ["bookings"] });
    },
  });

  const accept = useMutation({
    mutationFn: async () => { await api.bookings[":id"].accept.$post({ param: { id } }); },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["booking", id] }); qc.invalidateQueries({ queryKey: ["bookings"] }); },
  });
  const decline = useMutation({
    mutationFn: async (reason: string) => { await api.bookings[":id"].decline.$post({ param: { id }, json: { reason } }); },
    onSuccess: () => { setDeclineOpen(false); qc.invalidateQueries({ queryKey: ["bookings"] }); navigate("/rider"); },
  });

  // Hand an accepted job back to dispatch (breakdown, emergency, running late).
  // The job goes back to the queue unassigned; the office is notified.
  const release = useMutation({
    mutationFn: async ({ reason, note }: { reason: string; note: string }) => {
      const res = await fetch(`/api/bookings/${id}/release`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ reason, note }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        // Shown inline in the release sheet via onError -> setReleaseErr.
        throw new UserFacingError(
          (body as any)?.error?.message || (body as any)?.message || "Couldn't release this job",
          { status: res.status },
        );
      }
    },
    onSuccess: () => {
      setReleaseOpen(false);
      setReleaseReason("");
      setReleaseNote("");
      qc.invalidateQueries({ queryKey: ["bookings"] });
      navigate("/rider");
    },
    onError: (e: any) => setReleaseErr(e?.message || "Couldn't release this job"),
  });

  const b = (booking.data as any)?.booking;

  // start/stop GPS sharing
  function startSharing() {
    if (!b) return;
    setSharing(true);
    const dest = { lat: b.lat, lng: b.lng };

    if ("geolocation" in navigator) {
      watchRef.current = navigator.geolocation.watchPosition(
        (geo) => {
          const p = { lat: geo.coords.latitude, lng: geo.coords.longitude };
          setPos(p);
          ping.mutate(p);
        },
        () => startSimulation(dest),
        { enableHighAccuracy: true, maximumAge: 3000, timeout: 8000 },
      );
    } else {
      startSimulation(dest);
    }
  }

  // simulated movement toward destination (demo / GPS-denied fallback)
  function startSimulation(dest: { lat: number; lng: number }) {
    let cur = pos ??
      (b?.rider?.lat ? { lat: b.rider.lat, lng: b.rider.lng } : { lat: dest.lat + 0.02, lng: dest.lng - 0.02 });
    setPos(cur);
    ping.mutate(cur);
    simRef.current = setInterval(() => {
      cur = {
        lat: cur.lat + (dest.lat - cur.lat) * 0.18,
        lng: cur.lng + (dest.lng - cur.lng) * 0.18,
      };
      setPos({ ...cur });
      ping.mutate({ ...cur });
    }, 3000);
  }

  function stopSharing() {
    setSharing(false);
    if (watchRef.current != null) navigator.geolocation.clearWatch(watchRef.current);
    if (simRef.current) clearInterval(simRef.current);
    watchRef.current = null;
    simRef.current = null;
  }

  useEffect(() => () => stopSharing(), []);

  // auto-stop sharing when completed
  useEffect(() => {
    if (b?.status === "completed" && sharing) stopSharing();
  }, [b?.status, sharing]);

  if (booking.isLoading) return <FullLoader label="Loading job…" />;
  if (!b) return <p>Job not found.</p>;
  const isOffered = b.status === "assigned" && b.assignStatus === "offered";
  const step = isOffered ? null : FLOW[b.status];
  // Only for a job this tech committed to: an un-accepted offer is a Decline,
  // and a finished/cancelled job has nothing to hand back.
  const canRelease = !isOffered && !!b.riderId && RELEASABLE.has(b.status);
  

  return (
    <>
    <div className="mx-auto max-w-4xl">
      <Link to="/rider" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-cyan-glow">
        <ArrowLeft className="h-4 w-4" /> All jobs
      </Link>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <div className="overflow-hidden rounded-2xl border border-white/5 nvc-card">
            <div className="relative">
              <LiveMap rider={pos ?? (b.rider?.lat ? { lat: b.rider.lat, lng: b.rider.lng } : null)} destination={{ lat: b.lat, lng: b.lng }} className="h-[320px] w-full" />
              <div className="absolute left-3 top-3 z-[400]"><StatusBadge status={b.status} /></div>
              {sharing && (
                <div className="absolute right-3 top-3 z-[400] flex items-center gap-1.5 rounded-full bg-sky-accent px-3 py-1.5 text-xs font-bold text-white shadow">
                  <Radio className="h-3.5 w-3.5 animate-pulse" /> Sharing live
                </div>
              )}
            </div>
          </div>

          {/* live location toggle */}
          {b.status !== "completed" && b.status !== "cancelled" && (
            <div className="flex items-center justify-between rounded-2xl border border-white/5 bg-ink-2 p-4 shadow-sm">
              <div className="flex items-center gap-3">
                <div className={`grid h-11 w-11 place-items-center rounded-xl ${sharing ? "bg-sky-accent text-white" : "bg-white/5 text-slate-500"}`}>
                  <Navigation className="h-5 w-5" />
                </div>
                <div>
                  <div className="font-bold text-white">Live location</div>
                  <div className="text-xs text-slate-500">{sharing ? "Customer can see you on the map" : "Share so the customer can track you"}</div>
                </div>
              </div>
              <button
                onClick={sharing ? stopSharing : startSharing}
                className={`rounded-full px-4 py-2 text-sm font-semibold transition ${sharing ? "bg-red-500/10 text-red-400 hover:bg-red-500/20" : "bg-brand text-white shadow-lg shadow-brand/30 hover:bg-brand-deep"}`}
              >
                {sharing ? "Stop" : "Share"}
              </button>
            </div>
          )}
        </div>

        {/* job details + action */}
        <div className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <div className="rounded-2xl border border-white/5 bg-ink-2 p-5 shadow-sm">
            <h3 className="font-bold text-white">{b.service?.name}</h3>
            <div className="mt-3 space-y-2.5 text-sm text-slate-600">
              <div className="flex items-start gap-2"><MapPin className="mt-0.5 h-4 w-4 text-slate-500" />{b.address}</div>
              <div className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 text-slate-500" />{fmtDate(b.scheduledAt)}</div>
            </div>
            {b.notes && <p className="mt-3 rounded-lg bg-ink p-3 text-xs text-slate-600">📝 {b.notes}</p>}
          </div>

          {b.customer && (
            <div className="flex items-center justify-between rounded-2xl border border-white/5 bg-ink-2 p-4 shadow-sm">
              <div>
                <div className="text-xs text-slate-500">Customer</div>
                <div className="font-bold text-white">{b.customer.name}</div>
              </div>
              {b.customer.phone && (
                <a href={`tel:${b.customer.phone}`} className="grid h-11 w-11 place-items-center rounded-full bg-green-500 text-white shadow-lg shadow-green-500/30">
                  <Phone className="h-5 w-5" />
                </a>
              )}
            </div>
          )}

          {isOffered ? (
            <div className="space-y-2.5 rounded-2xl border border-amber-400/30 bg-amber-400/5 p-4">
              <div className="text-center text-sm font-bold text-amber-300">New job offer — respond to continue</div>
              <button
                disabled={accept.isPending}
                onClick={() => accept.mutate()}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-green-500 py-3.5 text-base font-bold text-white shadow-lg shadow-green-500/30 transition hover:bg-green-600 disabled:opacity-60"
              >
                {accept.isPending ? <Loader className="h-5 w-5 border-white/40 border-t-white" /> : <><Check className="h-5 w-5" /> Accept job</>}
              </button>
              <button
                disabled={decline.isPending}
                onClick={() => setDeclineOpen(true)}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-ink py-3 text-sm font-bold text-slate-300 transition hover:border-red-500/40 hover:text-red-400 disabled:opacity-60"
              >
                <X className="h-4 w-4" /> Decline
              </button>
            </div>
          ) : step ? (
            <button
              disabled={setStatus.isPending}
              onClick={() => {
                if (step.next === "enroute" && !sharing) startSharing();
                setStatus.mutate(step.next);
              }}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand py-4 text-base font-bold text-white shadow-lg shadow-brand/30 transition hover:bg-brand-deep disabled:opacity-60"
            >
              {setStatus.isPending ? <Loader className="h-5 w-5 border-white/40 border-t-white" /> : <><step.icon className="h-5 w-5" />{step.label}</>}
            </button>
          ) : (
            <div className="flex items-center justify-center gap-2 rounded-xl bg-green-50 py-4 font-bold text-green-600">
              <CheckCircle2 className="h-5 w-5" /> Job completed
            </div>
          )}

          {canRelease && (
            <button
              onClick={() => { setReleaseErr(""); setReleaseOpen(true); }}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-ink py-3 text-sm font-bold text-amber-300 transition hover:border-amber-400/40"
            >
              <HandMetal className="h-4 w-4" /> I can't do this job
            </button>
          )}
        </div>
      </div>
    </div>

    {/* Decline confirmation modal — replaces window.prompt for mobile compat */}
    {declineOpen && (
      <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center">
        <DialogPanel onClose={() => setDeclineOpen(false)} label="Decline this job" className="w-full max-w-sm rounded-t-3xl bg-ink-2 p-6 shadow-2xl sm:rounded-2xl">
          <div className="mb-4 flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-red-500/10 text-red-400">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-bold text-white">Decline this job?</h3>
              <p className="text-xs text-slate-500">This cannot be undone.</p>
            </div>
          </div>
          <textarea
            aria-label="Decline reason"
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
            placeholder="Reason (optional)"
            rows={3}
            className="w-full rounded-xl border border-white/10 bg-ink px-4 py-3 text-sm text-white placeholder-slate-600 focus:border-brand focus:outline-none"
          />
          <div className="mt-4 flex gap-3">
            <button
              onClick={() => { setDeclineOpen(false); setDeclineReason(""); }}
              className="flex-1 rounded-xl border border-white/10 py-3 text-sm font-semibold text-slate-300 hover:border-white/20"
            >
              Cancel
            </button>
            <button
              disabled={decline.isPending}
              onClick={() => decline.mutate(declineReason)}
              className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-red-500 py-3 text-sm font-bold text-white hover:bg-red-600 disabled:opacity-60"
            >
              {decline.isPending ? <Loader className="h-4 w-4 border-white/30 border-t-white" /> : "Confirm decline"}
            </button>
          </div>
        </DialogPanel>
      </div>
    )}

    {/* Release (hand back to dispatch) — a job the tech already accepted */}
    {releaseOpen && (
      <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center">
        <DialogPanel onClose={() => setReleaseOpen(false)} label="Send this job back to dispatch" className="w-full max-w-sm rounded-t-3xl bg-ink-2 p-6 shadow-2xl sm:rounded-2xl">
          <div className="mb-4 flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-amber-400/10 text-amber-300">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-bold text-white">Send back to dispatch?</h3>
              <p className="text-xs text-slate-500">The office is notified and will reassign it. The customer isn't told.</p>
            </div>
          </div>
          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Reason (required)</legend>
            {RELEASE_REASONS.map((r) => (
              <label key={r.key} className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2.5 text-sm ${releaseReason === r.key ? "border-brand bg-brand/10 text-white" : "border-white/10 text-slate-300 hover:border-white/20"}`}>
                <input
                  type="radio"
                  name="release-reason"
                  value={r.key}
                  checked={releaseReason === r.key}
                  onChange={() => setReleaseReason(r.key)}
                  aria-label={r.label}
                  className="h-4 w-4 accent-cyan-400"
                />
                {r.label}
              </label>
            ))}
          </fieldset>
          <textarea
            aria-label="Note for dispatch, optional"
            value={releaseNote}
            onChange={(e) => setReleaseNote(e.target.value)}
            placeholder="Anything dispatch should know (optional)"
            rows={2}
            className="mt-3 w-full rounded-xl border border-white/10 bg-ink px-4 py-3 text-sm text-white placeholder-slate-600 focus:border-brand focus:outline-none"
          />
          {releaseErr && <p className="mt-2 text-xs font-semibold text-red-400">{releaseErr}</p>}
          <div className="mt-4 flex gap-3">
            <button
              onClick={() => { setReleaseOpen(false); setReleaseReason(""); setReleaseNote(""); }}
              className="flex-1 rounded-xl border border-white/10 py-3 text-sm font-semibold text-slate-300 hover:border-white/20"
            >
              Keep job
            </button>
            <button
              disabled={release.isPending || !releaseReason}
              onClick={() => release.mutate({ reason: releaseReason, note: releaseNote.trim() })}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-amber-500 py-3 text-sm font-bold text-ink hover:bg-amber-400 disabled:opacity-60"
            >
              {release.isPending ? <Loader className="h-4 w-4 border-ink/30 border-t-ink" /> : "Send back"}
            </button>
          </div>
        </DialogPanel>
      </div>
    )}
    </>
  );
}
