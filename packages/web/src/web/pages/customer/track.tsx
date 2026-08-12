import { useParams, Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { LiveMap } from "../../components/live-map";
import { StatusBadge } from "../../components/brand";
import { FullLoader } from "../../components/loader";
import { StripePayModal } from "../../components/stripe-pay";
import { fmtDate, money } from "../../lib/utils";
import {
  ArrowLeft, Phone, Star, Truck, CheckCircle2, CreditCard, MapPin, Navigation,
  PackageOpen,
} from "lucide-react";
import { useState } from "react";
import { JOB_STEPS, statusStepIndex, isActiveStatus, isTerminalStatus } from "../../../shared/job-status";

// Stage vocabulary is shared with the public tracking page and the home screen
// (shared/job-status.ts). The local copy this replaced didn't list "onsite" or
// "paused", so indexOf returned -1 and the whole progress list showed as not
// started the moment the tech clocked in — and the tech card with the call
// button disappeared at the same time.
const STEP_LABEL: Record<string, string> = {
  confirmed: "Confirmed", assigned: "Pro assigned", enroute: "On the way",
  arrived: "Arrived", in_progress: "In progress", completed: "Completed",
};

export default function TrackPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [payOpen, setPayOpen] = useState(false);

  function onPaid() {
    qc.invalidateQueries({ queryKey: ["invoice", id] });
    qc.invalidateQueries({ queryKey: ["booking", id] });
    qc.invalidateQueries({ queryKey: ["bookings"] });
    qc.invalidateQueries({ queryKey: ["notifications"] });
    setPayOpen(false);
  }

  // Both polls used to run forever at 5s / 2.5s, so a customer who left this tab
  // open on a finished job kept asking the server for a snapshot that can never
  // change again. They stop at completion / cancellation instead.
  const booking = useQuery({
    queryKey: ["booking", id],
    queryFn: async () => (await api.bookings[":id"].$get({ param: { id } })).json(),
    refetchInterval: (q) =>
      isTerminalStatus((q.state.data as any)?.booking?.status) ? false : 5000,
  });
  const tracking = useQuery({
    queryKey: ["tracking", id],
    queryFn: async () => (await api.tracking[":bookingId"].$get({ param: { bookingId: id } })).json(),
    refetchInterval: () => {
      const st = (qc.getQueryData(["booking", id]) as any)?.booking?.status;
      return isTerminalStatus(st) ? false : 2500;
    },
  });
  const invoice = useQuery({
    queryKey: ["invoice", id],
    queryFn: async () => (await api.payments.invoice[":bookingId"].$get({ param: { bookingId: id } })).json(),
  });

  if (booking.isLoading) return <FullLoader label="Loading booking…" />;
  const b = (booking.data as any)?.booking;
  if (!b)
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <PackageOpen className="mx-auto h-10 w-10 text-slate-600" />
        <p className="mt-3 font-semibold text-slate-300">We couldn't find that booking</p>
        <p className="mt-1 text-sm text-slate-500">
          It may have been cancelled, or the link is out of date.
        </p>
        <Link
          to="/app/bookings"
          className="mt-5 inline-block rounded-full bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-deep"
        >
          See my bookings
        </Link>
      </div>
    );
  const t = tracking.data as any;
  const inv = (invoice.data as any)?.invoice;
  const currentStep = statusStepIndex(b.status);
  const isActive = isActiveStatus(b.status);
  const isPaid = inv?.status === "paid" || b.paymentStatus === "paid";

  return (
    <div className="mx-auto max-w-4xl">
      <Link to="/app/bookings" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-cyan-glow">
        <ArrowLeft className="h-4 w-4" /> All bookings
      </Link>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        {/* map */}
        <div className="space-y-4">
          <div className="overflow-hidden rounded-2xl border border-white/5 nvc-card">
            <div className="relative">
              <LiveMap
                rider={t?.riderLocation ?? null}
                destination={t?.destination ?? { lat: b.lat, lng: b.lng }}
                route={(t as any)?.route ?? null}
                etaMins={(t as any)?.etaMins ?? null}
                className="h-[340px] w-full"
              />
              <div className="absolute left-3 top-3 z-[400] flex items-center gap-2 rounded-full bg-ink-2/95 px-3 py-1.5 text-xs font-semibold shadow backdrop-blur">
                <StatusBadge status={b.status} />
              </div>
            </div>
            {isActive && t?.rider && (
              <div className="flex items-center justify-between border-t border-white/5 p-4">
                <div className="flex items-center gap-3">
                  <div className="grid h-12 w-12 place-items-center rounded-full bg-brand/15 text-cyan-glow">
                    <Truck className="h-6 w-6" />
                  </div>
                  <div>
                    <div className="font-bold text-white">{t.rider.name}</div>
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <span className="flex items-center gap-0.5"><Star className="h-3 w-3 fill-amber-400 text-amber-400" />{t.rider.rating}</span>
                      <span>·</span>
                      <span>{t.rider.vehicle}</span>
                    </div>
                  </div>
                </div>
                <a href={`tel:${t.rider.phone ?? ""}`} className="grid h-11 w-11 place-items-center rounded-full bg-green-500 text-white shadow-lg shadow-green-500/30 transition hover:bg-green-600">
                  <Phone className="h-5 w-5" />
                </a>
              </div>
            )}
            {!t?.rider && (
              <div className="border-t border-white/5 p-4 text-center text-sm text-slate-500">
                <Navigation className="mx-auto mb-1 h-5 w-5 text-slate-600" />
                Waiting for a professional to be assigned…
              </div>
            )}
          </div>

          {/* progress steps */}
          <div className="rounded-2xl border border-white/5 bg-ink-2 p-5 shadow-sm">
            <h3 className="mb-4 font-bold text-white">Progress</h3>
            <div className="space-y-0">
              {JOB_STEPS.map((step, i) => {
                const s = step.key;
                const reached = i <= currentStep && b.status !== "cancelled";
                const isCurrent = i === currentStep;
                return (
                  <div key={s} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <div className={`grid h-7 w-7 place-items-center rounded-full text-xs transition ${reached ? "bg-brand text-white" : "bg-white/5 text-slate-500"}`}>
                        {reached ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
                      </div>
                      {i < JOB_STEPS.length - 1 && (
                        <div className={`my-0.5 h-6 w-0.5 ${i < currentStep ? "bg-brand" : "bg-white/5"}`} />
                      )}
                    </div>
                    <div className={`pb-2 ${isCurrent ? "font-bold text-white" : reached ? "text-slate-200" : "text-slate-500"}`}>
                      {STEP_LABEL[s]}
                      {isCurrent && <span className="ml-2 text-xs font-medium text-cyan-glow">• now</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* details + payment */}
        <div className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <div className="rounded-2xl border border-white/5 bg-ink-2 p-5 shadow-sm">
            <h3 className="font-bold text-white">{b.service?.name}</h3>
            <div className="mt-3 space-y-2.5 text-sm">
              <Detail icon={MapPin} text={b.address} />
              <Detail icon={CheckCircle2} text={fmtDate(b.scheduledAt)} />
            </div>
          </div>

          {inv && (
            <div className="rounded-2xl border border-white/5 bg-ink-2 p-5 shadow-sm">
              <h3 className="mb-3 font-bold text-white">Payment</h3>
              <div className="space-y-1.5 text-sm">
                <RowL label="Subtotal" value={money(inv.amount)} />
                <RowL label="Tax" value={money(inv.tax)} />
                <div className="my-1.5 border-t border-white/5" />
                <RowL label="Total" value={money(inv.total)} bold />
              </div>
              {isPaid ? (
                <div className="mt-4 flex items-center justify-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 py-3 font-semibold text-emerald-400">
                  <CheckCircle2 className="h-5 w-5" /> Paid · {inv.number}
                </div>
              ) : (
                <button
                  onClick={() => setPayOpen(true)}
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-brand py-3.5 font-semibold text-white shadow-lg shadow-brand/30 transition hover:bg-brand-deep"
                >
                  <CreditCard className="h-4.5 w-4.5" /> Pay {money(inv.total)}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* pay modal */}
      {payOpen && inv && (
        <StripePayModal
          bookingId={id}
          amount={inv.total}
          invoiceNumber={inv.number}
          onClose={() => setPayOpen(false)}
          onPaid={onPaid}
        />
      )}
    </div>
  );
}

function Detail({ icon: Icon, text }: { icon: any; text: string }) {
  return (
    <div className="flex items-start gap-2 text-slate-300">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
      <span>{text}</span>
    </div>
  );
}
function RowL({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className={bold ? "font-bold text-white" : "text-slate-500"}>{label}</span>
      <span className={bold ? "text-lg font-extrabold text-cyan-glow" : "font-medium text-slate-200"}>{value}</span>
    </div>
  );
}
