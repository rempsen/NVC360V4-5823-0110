/**
 * Office queue for customer-initiated appointment changes.
 *
 * This page is the reason a customer can't cancel a job on their own any more.
 * Everything a customer asks for lands here as a pending row with their words
 * attached, and a job only actually moves or cancels when someone here decides
 * it should. Pending is sorted first and badged in the sidebar because an unseen
 * request is the worst outcome: a truck rolls to a job the customer believes is
 * already cancelled.
 */
import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { FullLoader } from "../../components/loader";
import { PageWrap } from "../../components/brand";
import { PageHead } from "./shell";
import { Modal, Field, inputCls, BtnPrimary, BtnGhost } from "../../components/modal";
import { useBrand, useCustomerNoun } from "../../lib/use-brand";
import { fmtAppointment } from "../../../shared/fmt-appointment";
import { cn } from "../../lib/utils";
import { CalendarClock, XCircle, ArrowRight, Check, Ban, User, MapPin } from "lucide-react";

type ChangeRequest = {
  id: string;
  bookingId: string;
  kind: "cancel" | "reschedule";
  status: "pending" | "approved" | "declined" | "applied" | "withdrawn";
  reason: string;
  requestedByName: string;
  proposedAt: number | null;
  previousAt: number | null;
  decidedByName: string;
  decidedAt: number | null;
  decisionNote: string;
  createdAt: number | string;
  booking: {
    id: string;
    shortId: string;
    status: string;
    address: string;
    scheduledAt: number | null;
    serviceName: string;
  } | null;
  customer: { id: string; name: string; email: string } | null;
};

const FILTERS = [
  { key: "pending", label: "Needs a decision" },
  { key: "", label: "All" },
  { key: "approved", label: "Approved" },
  { key: "declined", label: "Declined" },
  { key: "applied", label: "Self-serve" },
] as const;

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-warn",
  approved: "bg-emerald-500/15 text-emerald-400",
  declined: "bg-rose-500/15 text-rose-400",
  applied: "bg-brand/15 text-cyan-glow",
  withdrawn: "bg-white/10 text-slate-400",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  approved: "Approved",
  declined: "Declined",
  applied: "Done by customer",
  withdrawn: "Withdrawn",
};

export default function AdminChangeRequests() {
  const qc = useQueryClient();
  const brand = useBrand();
  const { noun: customerNoun } = useCustomerNoun();
  const [filter, setFilter] = useState<string>("pending");
  const [decision, setDecision] = useState<{ req: ChangeRequest; act: "approve" | "decline" } | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const q = useQuery({
    queryKey: ["change-requests", filter],
    // A dispatcher leaves this open on a second monitor; without a refetch a new
    // request sits invisible until someone reloads.
    refetchInterval: 60_000,
    queryFn: async () =>
      (await (api as any)["change-requests"].$get({ query: filter ? { status: filter } : {} })).json(),
  });

  const decide = useMutation({
    mutationFn: async ({ id, act, note }: { id: string; act: "approve" | "decline"; note: string }) => {
      const res = await (api as any)["change-requests"][":id"][act].$post({
        param: { id },
        json: { note },
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((j as any).message || "Couldn't save that decision");
      return j;
    },
    onSuccess: () => {
      setDecision(null);
      setNote("");
      setError("");
      qc.invalidateQueries({ queryKey: ["change-requests"] });
      qc.invalidateQueries({ queryKey: ["change-request-count"] });
      // the job itself moved or cancelled — the board and scheduler are stale
      qc.invalidateQueries({ queryKey: ["bookings"] });
      qc.invalidateQueries({ queryKey: ["scheduler"] });
      qc.invalidateQueries({ queryKey: ["today-stats"] });
    },
    onError: (e: any) => setError(e?.message || "Couldn't save that decision"),
  });

  if (q.isLoading) return <FullLoader label="Loading change requests…" />;

  const list: ChangeRequest[] = (q.data as any)?.requests ?? [];
  const pendingCount: number = (q.data as any)?.pendingCount ?? 0;
  const when = (v: number | null | undefined) =>
    v ? fmtAppointment(Number(v), brand.timezone) : "—";

  return (
    <PageWrap>
      <PageHead
        title="Change Requests"
        subtitle={
          pendingCount > 0
            ? `${pendingCount} waiting on a decision — nothing changes until you approve it`
            : `No requests waiting. ${customerNoun} cancellations always come here first.`
        }
      />

      <div className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.key || "all"}
            onClick={() => setFilter(f.key)}
            className={cn(
              "rounded-full px-3 py-1.5 text-xs font-semibold transition",
              filter === f.key ? "bg-brand text-white" : "bg-ink-2 text-slate-400 hover:bg-white/5",
            )}
          >
            {f.label}
            {f.key === "pending" && pendingCount > 0 && (
              <span className="ml-1.5 rounded-full bg-black/25 px-1.5 py-0.5 text-[10px]">{pendingCount}</span>
            )}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <div className="nvc-card grid place-items-center px-6 py-16 text-center text-slate-500">
          <CalendarClock className="mb-3 h-8 w-8 text-slate-700" />
          <p className="text-sm">Nothing here.</p>
          <p className="mt-1 max-w-md text-xs text-slate-600">
            When a {customerNoun.toLowerCase()} asks to move or cancel an appointment from their
            tracking page, it lands here for you to approve or decline.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {list.map((r) => {
            const isCancel = r.kind === "cancel";
            return (
              <div
                key={r.id}
                className={cn(
                  "nvc-card p-4",
                  r.status === "pending" ? "ring-1 ring-amber-500/25" : "opacity-80",
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-bold",
                          isCancel ? "bg-rose-500/15 text-rose-400" : "bg-brand/15 text-cyan-glow",
                        )}
                      >
                        {isCancel ? <XCircle className="h-3.5 w-3.5" /> : <CalendarClock className="h-3.5 w-3.5" />}
                        {isCancel ? "Cancellation" : "Reschedule"}
                      </span>
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                          STATUS_STYLE[r.status] ?? "bg-white/10 text-slate-400",
                        )}
                      >
                        {STATUS_LABEL[r.status] ?? r.status}
                      </span>
                      {r.booking && (
                        <Link
                          to={`/admin/work-orders?q=${r.booking.shortId}`}
                          className="text-xs font-semibold text-brand hover:underline"
                        >
                          #{r.booking.shortId}
                        </Link>
                      )}
                    </div>

                    <p className="mt-2 text-sm font-semibold text-white">
                      {r.booking?.serviceName || "Work order"}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-400">
                      <User className="h-3.5 w-3.5 shrink-0" />
                      {r.customer?.name || r.requestedByName || "—"}
                      {r.customer?.email ? ` · ${r.customer.email}` : ""}
                    </p>
                    {r.booking?.address && (
                      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500">
                        <MapPin className="h-3.5 w-3.5 shrink-0" />
                        {r.booking.address}
                      </p>
                    )}
                  </div>

                  <div className="text-right text-xs">
                    {isCancel ? (
                      <p className="text-slate-300">
                        Booked for <span className="font-semibold text-white">{when(r.previousAt ?? r.booking?.scheduledAt)}</span>
                      </p>
                    ) : (
                      <p className="flex flex-wrap items-center justify-end gap-1.5 text-slate-300">
                        <span className="line-through decoration-slate-600">{when(r.previousAt ?? r.booking?.scheduledAt)}</span>
                        <ArrowRight className="h-3.5 w-3.5 text-slate-500" />
                        <span className="font-semibold text-white">{when(r.proposedAt)}</span>
                      </p>
                    )}
                    <p className="mt-1 text-[11px] text-slate-500">
                      Asked {fmtAppointment(Number(r.createdAt), brand.timezone)}
                    </p>
                  </div>
                </div>

                {r.reason && (
                  <p className="mt-3 rounded-lg border-l-2 border-brand/40 bg-white/[0.03] px-3 py-2 text-sm text-slate-300">
                    “{r.reason}”
                  </p>
                )}

                {r.status === "pending" ? (
                  <div className="mt-3 flex flex-wrap gap-2 border-t border-white/5 pt-3">
                    <button
                      onClick={() => { setDecision({ req: r, act: "approve" }); setNote(""); setError(""); }}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-400 transition hover:bg-emerald-500/25"
                    >
                      <Check className="h-3.5 w-3.5" />
                      {isCancel ? "Approve cancellation" : "Approve new time"}
                    </button>
                    <button
                      onClick={() => { setDecision({ req: r, act: "decline" }); setNote(""); setError(""); }}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:bg-white/10"
                    >
                      <Ban className="h-3.5 w-3.5" /> Decline
                    </button>
                  </div>
                ) : (
                  (r.decidedByName || r.decisionNote) && (
                    <p className="mt-3 border-t border-white/5 pt-3 text-[11px] text-slate-500">
                      {r.decidedByName ? `${r.decidedByName} · ` : ""}
                      {r.decidedAt ? fmtAppointment(Number(r.decidedAt), brand.timezone) : ""}
                      {r.decisionNote ? ` — “${r.decisionNote}”` : ""}
                    </p>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={!!decision}
        onClose={() => setDecision(null)}
        title={
          decision?.act === "approve"
            ? decision.req.kind === "cancel"
              ? "Approve this cancellation?"
              : "Approve the new time?"
            : "Decline this request?"
        }
        subtitle={
          decision?.act === "approve"
            ? decision.req.kind === "cancel"
              ? "The work order is cancelled and the customer is notified."
              : "The appointment moves to the requested time and everyone is notified."
            : "The appointment stays exactly as booked. Your note is what the customer is told."
        }
        footer={
          <>
            <BtnGhost onClick={() => setDecision(null)}>Back</BtnGhost>
            <BtnPrimary
              disabled={decide.isPending}
              onClick={() =>
                decision && decide.mutate({ id: decision.req.id, act: decision.act, note })
              }
            >
              {decide.isPending
                ? "Saving…"
                : decision?.act === "approve"
                  ? "Approve"
                  : "Decline"}
            </BtnPrimary>
          </>
        }
      >
        {decision?.act === "approve" && decision.req.kind === "reschedule" && (
          <p className="mb-3 rounded-lg bg-white/5 p-3 text-xs text-slate-300">
            {when(decision.req.previousAt ?? decision.req.booking?.scheduledAt)} →{" "}
            <span className="font-semibold text-white">{when(decision.req.proposedAt)}</span>
          </p>
        )}
        <Field
          label={decision?.act === "decline" ? "What should we tell them?" : "Note (optional)"}
          hint="Kept on the work order's history."
        >
          <textarea
            aria-label="Decision note"
            className={inputCls}
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={
              decision?.act === "decline"
                ? "e.g. Your technician is already scheduled — please call us and we'll sort it out."
                : "e.g. Confirmed by phone"
            }
          />
        </Field>
        {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
      </Modal>
    </PageWrap>
  );
}
