/**
 * Running-late board — the dispatcher's first refusal.
 *
 * Detection is automatic, so by the time this card appears the job is already
 * late and a clock is running towards an automatic text. That's why this sits
 * at the top of the dashboard and disappears completely when nothing is
 * flagged: a panel that's always on screen stops being read.
 *
 * Every action here goes through the API, which re-runs the evaluator
 * server-side — a tab left open since this morning cannot text a customer
 * about a job the tech has since arrived at.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "wouter";
import { api } from "../lib/api";
import { AlertTriangle, BellOff, Bell, Send, Clock3 } from "lucide-react";
import { cn } from "../lib/utils";

type Delay = {
  bookingId: string;
  shortId: string;
  title: string | null;
  address: string | null;
  status: string;
  scheduledAt: number | null;
  slipMins: number;
  reason: string;
  muted: boolean;
  notifiedAt: number | null;
  notifiedMins: number | null;
  autoSendAt: number | null;
};

/** "in 4 min" / "any moment now" — the dispatcher's actual question. */
function untilAuto(at: number | null): string | null {
  if (!at) return null;
  const mins = Math.round((at - Date.now()) / 60_000);
  if (mins <= 0) return "any moment now";
  return `in ${mins} min`;
}

function reasonText(r: string, workerNoun: string) {
  if (r === "eta_overrun") return `${workerNoun} is driving but won't make the slot`;
  if (r === "not_started") return `${workerNoun} hasn't started the drive`;
  return "running late";
}

export function RunningLateBoard({ workerNoun = "Tech" }: { workerNoun?: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["delays"],
    queryFn: async () => (await (api as any).delays.$get()).json(),
    refetchInterval: 30_000,
  });

  const notify = useMutation({
    mutationFn: async (bookingId: string) => {
      const res = await (api as any).delays[":bookingId"].notify.$post({
        param: { bookingId },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message || "Could not send the notice");
      return body;
    },
    onError: (e: Error) => setError(e.message),
    onSettled: () => {
      setBusy(null);
      qc.invalidateQueries({ queryKey: ["delays"] });
    },
  });

  const mute = useMutation({
    mutationFn: async (v: { bookingId: string; muted: boolean }) => {
      const res = await (api as any).delays[":bookingId"].mute.$post({
        param: { bookingId: v.bookingId },
        json: { muted: v.muted },
      });
      if (!res.ok) throw new Error("Could not update this job");
      return res.json();
    },
    onError: (e: Error) => setError(e.message),
    onSettled: () => {
      setBusy(null);
      qc.invalidateQueries({ queryKey: ["delays"] });
    },
  });

  const delays: Delay[] = q.data?.delays ?? [];
  if (!delays.length) return null;

  const pending = q.data?.pendingCount ?? 0;

  return (
    <section
      aria-label="Jobs running late"
      className="nvc-card mb-4 border-l-2 border-l-amber-500/70 p-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 px-5 py-3.5">
        <h2 className="flex items-center gap-2 text-sm font-bold text-white">
          <AlertTriangle className="h-4 w-4 text-amber-400" />
          Running late
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
            {delays.length}
          </span>
        </h2>
        <p className="text-[11px] text-white/50">
          {pending > 0
            ? `${pending} customer${pending === 1 ? " hasn't" : "s haven't"} been told yet.`
            : "Every customer here has been told."}
        </p>
      </div>

      {error && (
        <p role="alert" className="border-b border-white/5 bg-red-500/10 px-5 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <ul className="divide-y divide-white/5">
        {delays.map((d) => {
          const auto = !d.notifiedAt && !d.muted ? untilAuto(d.autoSendAt) : null;
          const working = busy === d.bookingId;
          return (
            <li key={d.bookingId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/admin/work-orders?open=${d.bookingId}`}
                    className="truncate text-sm font-semibold text-white hover:text-brand"
                  >
                    {d.title || "Work order"} · {d.shortId}
                  </Link>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums",
                      d.slipMins >= 45
                        ? "bg-red-500/15 text-red-300"
                        : "bg-amber-500/15 text-amber-300",
                    )}
                  >
                    {d.slipMins} min late
                  </span>
                  {d.muted && (
                    <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-white/60">
                      Muted
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate text-[11px] text-white/50">
                  {reasonText(d.reason, workerNoun)}
                  {d.address ? ` · ${d.address}` : ""}
                </p>
                <p className="mt-0.5 text-[11px] text-white/40">
                  {d.notifiedAt
                    ? `Customer told about ~${d.notifiedMins} min at ${new Date(d.notifiedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`
                    : d.muted
                      ? "Automatic notice is off for this job — you're handling it."
                      : auto
                        ? `Sends itself ${auto} unless you act.`
                        : "Waiting for you — nothing sends automatically."}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  disabled={working}
                  aria-label={`Send running-late notice for ${d.shortId}`}
                  onClick={() => {
                    setError(null);
                    setBusy(d.bookingId);
                    notify.mutate(d.bookingId);
                  }}
                  className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-brand-deep disabled:opacity-50"
                >
                  <Send className="h-3.5 w-3.5" />
                  {d.notifiedAt ? "Send update" : "Send now"}
                </button>
                <button
                  type="button"
                  disabled={working}
                  aria-label={`${d.muted ? "Un-mute" : "Mute"} automatic notice for ${d.shortId}`}
                  title={
                    d.muted
                      ? "Turn the automatic notice back on"
                      : "I've handled this — don't send it automatically"
                  }
                  onClick={() => {
                    setError(null);
                    setBusy(d.bookingId);
                    mute.mutate({ bookingId: d.bookingId, muted: !d.muted });
                  }}
                  className="flex items-center gap-1.5 rounded-lg bg-white/5 px-3 py-1.5 text-xs font-semibold text-white/70 transition hover:bg-white/10 disabled:opacity-50"
                >
                  {d.muted ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
                  {d.muted ? "Un-mute" : "Mute"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="flex items-center gap-1.5 border-t border-white/5 px-5 py-2.5 text-[11px] text-white/40">
        <Clock3 className="h-3 w-3" />
        Notices go out by text and on the customer&apos;s tracking page. Change the
        timing in <Link href="/admin/settings" className="underline hover:text-white/70">Settings</Link>.
      </p>
    </section>
  );
}
