/**
 * "Need to change this appointment?" — the customer side of change requests.
 *
 * Everything on screen is driven by GET /api/bookings/:id/change-policy, which
 * runs the same evaluator the write endpoints run (shared/change-policy.ts). So
 * a button is never offered for something the server will refuse, and the two
 * can't drift apart.
 *
 * Two deliberate product choices are visible here:
 *  - Moving a time is self-serve while the day isn't routed yet; inside the
 *    tenant's cutoff the same action says, in plain words, that the office will
 *    confirm it.
 *  - "Cancel" is never a button that cancels. It sends a request. Saying so
 *    up-front is what stops the "I cancelled it online" phone call after a truck
 *    has already rolled.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Modal, Field, inputCls, BtnPrimary, BtnGhost } from "./modal";
import { useBrand } from "../lib/use-brand";
import { nextSlots } from "../../shared/booking-slots";
import { approvalNoteFor, type ChangeMode } from "../../shared/change-policy";
import { fmtAppointment } from "../../shared/fmt-appointment";
import { safeTimeZone } from "../../shared/tz";
import { cn } from "../lib/utils";
import { CalendarClock, XCircle, Clock, CheckCircle2, Phone } from "lucide-react";

type PolicyState = {
  reschedule: ChangeMode;
  cancel: ChangeMode;
  withinCutoff: boolean;
  cutoffHours: number;
  blockedReason: string;
  openRequest: {
    id: string;
    kind: "cancel" | "reschedule";
    status: string;
    reason: string;
    proposedAt: number | null;
    createdAt: number | null;
  } | null;
};

/** Group the flat slot list by calendar day on the COMPANY's clock. */
function groupByDay(slots: { label: string; value: string }[], tz: string) {
  const dayFmt = new Intl.DateTimeFormat("en-US", {
    weekday: "long", month: "short", day: "numeric", timeZone: tz,
  });
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: tz,
  });
  const days: { day: string; times: { label: string; value: string }[] }[] = [];
  for (const s of slots) {
    const d = new Date(s.value);
    const day = dayFmt.format(d);
    let bucket = days.find((x) => x.day === day);
    if (!bucket) {
      bucket = { day, times: [] };
      days.push(bucket);
    }
    bucket.times.push({ label: timeFmt.format(d), value: s.value });
  }
  return days;
}

export function AppointmentChangeCard({ bookingId }: { bookingId: string }) {
  const qc = useQueryClient();
  const brand = useBrand();
  const tz = safeTimeZone(brand.timezone);
  const [open, setOpen] = useState<null | "reschedule" | "cancel">(null);
  const [slot, setSlot] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState<null | "moved" | "requested">(null);

  const policy = useQuery({
    queryKey: ["change-policy", bookingId],
    queryFn: async () =>
      (await (api as any).bookings[":id"]["change-policy"].$get({ param: { id: bookingId } })).json(),
  });

  const slots = useMemo(() => groupByDay(nextSlots(tz), tz), [tz]);

  const reset = () => {
    setOpen(null);
    setSlot("");
    setReason("");
    setError("");
  };

  const afterWrite = () => {
    qc.invalidateQueries({ queryKey: ["change-policy", bookingId] });
    qc.invalidateQueries({ queryKey: ["booking", bookingId] });
    qc.invalidateQueries({ queryKey: ["bookings"] });
  };

  const move = useMutation({
    mutationFn: async () => {
      const res = await (api as any).bookings[":id"].reschedule.$post({
        param: { id: bookingId },
        json: { scheduledAt: slot, reason },
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((j as any).message || "We couldn't change that time.");
      return j;
    },
    onSuccess: (j: any) => {
      reset();
      setDone(j?.mode === "applied" ? "moved" : "requested");
      afterWrite();
    },
    onError: (e: any) => setError(e?.message || "We couldn't change that time."),
  });

  const askCancel = useMutation({
    mutationFn: async () => {
      const res = await (api as any).bookings[":id"]["cancel-request"].$post({
        param: { id: bookingId },
        json: { reason },
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((j as any).message || "We couldn't send that request.");
      return j;
    },
    onSuccess: () => {
      reset();
      setDone("requested");
      afterWrite();
    },
    onError: (e: any) => setError(e?.message || "We couldn't send that request."),
  });

  if (policy.isLoading || !policy.data) return null;
  const p = policy.data as PolicyState;

  // Nothing on offer and nothing in flight: don't show a dead card. The one
  // exception is an in-flight/blocked job, where the reason IS the useful thing
  // to say (call us) rather than silence.
  const nothingOffered = p.reschedule === "blocked" && p.cancel === "blocked";
  if (nothingOffered && !p.openRequest && !p.blockedReason) return null;

  // A request in flight replaces the buttons: a second one is rejected anyway
  // (409), and this is where the customer finds out where theirs stands.
  if (p.openRequest) {
    const r = p.openRequest;
    return (
      <div className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-5">
        <h3 className="flex items-center gap-2 font-bold text-white">
          <Clock className="h-4 w-4 text-amber-warn" />
          {r.kind === "cancel" ? "Cancellation requested" : "Change requested"}
        </h3>
        <p className="mt-2 text-sm text-slate-300">
          {r.kind === "cancel"
            ? "We've got your request to cancel. Nothing has changed yet — the office will confirm it shortly."
            : `We've got your request to move this to ${
                r.proposedAt ? fmtAppointment(r.proposedAt, brand.timezone) : "a new time"
              }. Your appointment stays as booked until the office confirms.`}
        </p>
        {r.reason && <p className="mt-2 text-xs italic text-slate-400">“{r.reason}”</p>}
        <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-400">
          <Phone className="h-3.5 w-3.5" /> Need it sooner? Give us a call.
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] p-5">
        <h3 className="flex items-center gap-2 font-bold text-white">
          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          {done === "moved" ? "Appointment moved" : "Request sent"}
        </h3>
        <p className="mt-2 text-sm text-slate-300">
          {done === "moved"
            ? "You're all set — we've updated your appointment and sent you a confirmation."
            : "The office has it and will confirm shortly. Nothing has changed yet."}
        </p>
      </div>
    );
  }

  const canMove = p.reschedule !== "blocked";
  const canAskCancel = p.cancel !== "blocked";
  const needsApproval = p.reschedule === "request";

  return (
    <div className="rounded-2xl border border-white/5 bg-ink-2 p-5 shadow-sm">
      <h3 className="font-bold text-white">Need to change this?</h3>

      {nothingOffered ? (
        <p className="mt-2 text-sm text-slate-400">{p.blockedReason}</p>
      ) : (
        <>
          <p className="mt-2 text-sm text-slate-400">
            {needsApproval
              ? approvalNoteFor(p.cutoffHours)
              : "Pick a new time yourself, or send us a cancellation request."}
          </p>
          <div className="mt-4 flex flex-col gap-2">
            {canMove && (
              <button
                onClick={() => { setOpen("reschedule"); setError(""); }}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand py-3 text-sm font-semibold text-white transition hover:bg-brand-deep"
              >
                <CalendarClock className="h-4 w-4" />
                {needsApproval ? "Request a new time" : "Change my appointment time"}
              </button>
            )}
            {canAskCancel && (
              <button
                onClick={() => { setOpen("cancel"); setError(""); }}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 py-3 text-sm font-semibold text-slate-300 transition hover:bg-white/5"
              >
                <XCircle className="h-4 w-4" /> Need to cancel?
              </button>
            )}
          </div>
        </>
      )}

      {/* reschedule */}
      <Modal
        open={open === "reschedule"}
        onClose={reset}
        title={needsApproval ? "Request a new time" : "Pick a new time"}
        subtitle={
          needsApproval
            ? approvalNoteFor(p.cutoffHours)
            : "Choose any open slot below — we'll confirm it right away."
        }
        footer={
          <>
            <BtnGhost onClick={reset}>Back</BtnGhost>
            <BtnPrimary disabled={!slot || move.isPending} onClick={() => move.mutate()}>
              {move.isPending ? "Saving…" : needsApproval ? "Send request" : "Confirm new time"}
            </BtnPrimary>
          </>
        }
      >
        <div className="max-h-[46vh] space-y-4 overflow-y-auto pr-1">
          {slots.map((d) => (
            <div key={d.day}>
              <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">{d.day}</p>
              <div className="flex flex-wrap gap-2">
                {d.times.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    aria-pressed={slot === s.value}
                    onClick={() => setSlot(s.value)}
                    className={cn(
                      "min-h-[40px] rounded-lg border px-3 py-2 text-sm font-medium transition",
                      slot === s.value
                        ? "border-brand bg-brand/15 text-white"
                        : "border-white/10 text-slate-300 hover:bg-white/5",
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4">
          <Field label="Anything we should know? (optional)">
            <textarea
              aria-label="Reason for changing the appointment"
              className={inputCls}
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. I'm away for work that morning"
            />
          </Field>
        </div>
        {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
      </Modal>

      {/* cancellation request */}
      <Modal
        open={open === "cancel"}
        onClose={reset}
        title="Request a cancellation"
        subtitle="This sends a request to the office — your appointment stays booked until they confirm."
        footer={
          <>
            <BtnGhost onClick={reset}>Keep my appointment</BtnGhost>
            <BtnPrimary disabled={!reason.trim() || askCancel.isPending} onClick={() => askCancel.mutate()}>
              {askCancel.isPending ? "Sending…" : "Send request"}
            </BtnPrimary>
          </>
        }
      >
        <Field label="Why do you need to cancel?" hint="This goes straight to the office.">
          <textarea
            aria-label="Reason for cancelling"
            className={inputCls}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. The issue resolved itself / I need a different date"
          />
        </Field>
        {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
      </Modal>
    </div>
  );
}
