import { Fragment, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { FullLoader } from "../../components/loader";
import { PageWrap } from "../../components/brand";
import { PageHead } from "./shell";
import { Modal, Field, inputCls, BtnPrimary, BtnGhost } from "../../components/modal";
import { Plus, CheckCircle2, Clock, DollarSign, AlertTriangle, ChevronRight } from "lucide-react";
import { useWorkerNoun, useJobNoun } from "../../lib/use-brand";

const money = (n: number) => `$${(n ?? 0).toFixed(2)}`;
const fmtMins = (m: number) => {
  const n = Math.max(0, Math.round(Number(m) || 0));
  if (n === 0) return "—";
  const h = Math.floor(n / 60);
  return h > 0 ? `${h}h ${n % 60}m` : `${n}m`;
};
const fmtDate = (d: string) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export default function AdminPayouts() {
  const qc = useQueryClient();
  const { noun } = useWorkerNoun();
  const { nounPlural: jobPlural } = useJobNoun();
  const [genOpen, setGenOpen] = useState(false);
  const today = new Date();
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const [range, setRange] = useState({
    start: weekAgo.toISOString().slice(0, 10),
    end: today.toISOString().slice(0, 10),
  });
  // Which payout row is expanded to show its per-job pay detail.
  const [openRow, setOpenRow] = useState<string | null>(null);

  const payouts = useQuery({
    queryKey: ["payouts"],
    queryFn: async () => (await api.payouts.$get()).json(),
  });

  const generate = useMutation({
    mutationFn: async () => {
      const res = await api.payouts.generate.$post({
        json: {
          periodStart: new Date(range.start).getTime(),
          periodEnd: new Date(range.end + "T23:59:59").getTime(),
        },
      });
      return res.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["payouts"] }); setGenOpen(false); },
  });

  const pay = useMutation({
    mutationFn: async (id: string) => api.payouts[":id"].pay.$post({ param: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["payouts"] }),
  });

  if (payouts.isLoading) return <FullLoader label="Loading payouts…" />;
  const list = (payouts.data as any)?.payouts ?? [];
  const pending = list.filter((p: any) => p.status === "pending");
  const totalPending = pending.reduce((s: number, p: any) => s + p.net, 0);
  const totalPaid = list.filter((p: any) => p.status === "paid").reduce((s: number, p: any) => s + p.net, 0);

  return (
    <PageWrap>
      <PageHead
        title={`${noun} Payouts`}
        subtitle={`Real pay for completed ${jobPlural.toLowerCase()} — on-site hours × hourly rate + per-unit pay`}
        actions={<BtnPrimary onClick={() => setGenOpen(true)}><Plus className="h-4 w-4" /> Generate payouts</BtnPrimary>}
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatCard icon={Clock} label="Pending" value={money(totalPending)} sub={`${pending.length} payouts`} color="#f59e0b" />
        <StatCard icon={CheckCircle2} label="Paid out" value={money(totalPaid)} sub="lifetime" color="#22c55e" />
        <StatCard icon={DollarSign} label="Total records" value={String(list.length)} sub="all periods" color="#06b6d4" />
      </div>

      {list.length === 0 ? (
        <div className="nvc-card grid place-items-center py-16 text-center text-slate-500">
          No payouts yet. Generate one for a pay period.
        </div>
      ) : (
        <div className="nvc-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-white/5 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">{noun}</th>
                <th className="px-4 py-3">Period</th>
                <th className="px-4 py-3 text-right">Jobs</th>
                <th className="px-4 py-3 text-right">On site</th>
                <th className="px-4 py-3 text-right">Hourly</th>
                <th className="px-4 py-3 text-right">Per-unit</th>
                <th className="px-4 py-3 text-right">Total pay</th>
                <th className="px-4 py-3 text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p: any) => {
                const jobs: any[] = Array.isArray(p.jobs) ? p.jobs : [];
                const legacy = Number(p.feePct ?? 0) > 0; // pre-real-pay row
                return (
                <Fragment key={p.id}>
                <tr className="border-b border-white/5 last:border-0">
                  <td className="px-4 py-3 font-semibold text-white">
                    <button
                      onClick={() => setOpenRow(openRow === p.id ? null : p.id)}
                      className="inline-flex items-center gap-1.5 text-left hover:text-brand"
                      aria-label={`Show pay detail for ${p.riderName || "technician"}`}
                      aria-expanded={openRow === p.id}
                    >
                      <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${openRow === p.id ? "rotate-90" : ""}`} />
                      {p.riderName || "—"}
                    </button>
                    {p.unratedJobs > 0 && (
                      <span title="These jobs paid $0 because no hourly rate is set for this person and there was no per-unit pay."
                        className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                        <AlertTriangle className="h-3 w-3" /> {p.unratedJobs} no pay rate
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-400">{fmtDate(p.periodStart)} – {fmtDate(p.periodEnd)}</td>
                  <td className="px-4 py-3 text-right text-slate-300">{p.jobsCount}</td>
                  <td className="px-4 py-3 text-right text-slate-400">{fmtMins(p.onSiteMinutes)}</td>
                  <td className="px-4 py-3 text-right text-slate-300">{legacy ? "—" : money(p.hourlyPay)}</td>
                  <td className="px-4 py-3 text-right text-slate-300">{legacy ? "—" : money(p.unitPay)}</td>
                  <td className="px-4 py-3 text-right font-bold text-emerald-live">{money(p.net)}</td>
                  <td className="px-4 py-3 text-right">
                    {p.status === "paid" ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-live">
                        <CheckCircle2 className="h-3 w-3" /> Paid
                      </span>
                    ) : (
                      <button onClick={() => pay.mutate(p.id)} disabled={pay.isPending}
                        className="rounded-full bg-brand px-3 py-1 text-xs font-semibold text-white hover:bg-brand-deep disabled:opacity-50">
                        Mark paid
                      </button>
                    )}
                  </td>
                </tr>
                {openRow === p.id && (
                  <tr className="border-b border-white/5 bg-black/20">
                    <td colSpan={8} className="px-4 py-3">
                      {jobs.length === 0 ? (
                        <p className="text-xs text-slate-500">
                          {legacy
                            ? "This payout was generated under the old percentage model, so there is no per-job pay detail."
                            : "No job detail recorded for this payout."}
                        </p>
                      ) : (
                        <table className="w-full text-xs">
                          <thead className="text-left uppercase tracking-wide text-slate-600">
                            <tr>
                              <th className="py-1.5 pr-3">Job</th>
                              <th className="py-1.5 pr-3 text-right">On site</th>
                              <th className="py-1.5 pr-3 text-right">Rate</th>
                              <th className="py-1.5 pr-3 text-right">Hourly</th>
                              <th className="py-1.5 pr-3 text-right">Per-unit</th>
                              <th className="py-1.5 text-right">Pay</th>
                            </tr>
                          </thead>
                          <tbody>
                            {jobs.map((j) => (
                              <tr key={j.bookingId} className="border-t border-white/5">
                                <td className="py-1.5 pr-3 text-slate-300">
                                  {j.title || j.bookingId}
                                  {j.unrated && (
                                    <span className="ml-1.5 text-[10px] font-semibold text-amber-300">no pay rate</span>
                                  )}
                                </td>
                                <td className="py-1.5 pr-3 text-right text-slate-400">{fmtMins(j.onSiteMinutes)}</td>
                                <td className="py-1.5 pr-3 text-right text-slate-400">{j.payRatePerHour ? `${money(j.payRatePerHour)}/h` : "—"}</td>
                                <td className="py-1.5 pr-3 text-right text-slate-400">{money(j.hourlyPay)}</td>
                                <td className="py-1.5 pr-3 text-right text-slate-400">{money(j.unitPay)}</td>
                                <td className="py-1.5 text-right font-semibold text-white">{money(j.techPay)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        </div>
      )}

      <Modal open={genOpen} onClose={() => setGenOpen(false)} title="Generate payouts" subtitle={`Totals real pay for every completed job in the period, by ${noun.toLowerCase()}`}
        footer={<><BtnGhost onClick={() => setGenOpen(false)}>Cancel</BtnGhost>
          <BtnPrimary disabled={generate.isPending} onClick={() => generate.mutate()}>{generate.isPending ? "Generating…" : "Generate"}</BtnPrimary></>}>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Period start"><input aria-label="Start" type="date" className={inputCls} value={range.start} onChange={(e) => setRange({ ...range, start: e.target.value })} /></Field>
            <Field label="Period end"><input aria-label="End" type="date" className={inputCls} value={range.end} onChange={(e) => setRange({ ...range, end: e.target.value })} /></Field>
          </div>
          <p className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs leading-relaxed text-slate-400">
            Pay is calculated per job as <span className="text-slate-200">on-site time × that person&apos;s hourly rate</span>,
            plus any <span className="text-slate-200">per-unit pay</span> on the job. Jobs count once the work is completed —
            you don&apos;t have to wait for the customer&apos;s invoice to be paid. A job already covered by an earlier payout
            is never included twice.
          </p>
        </div>
      </Modal>
    </PageWrap>
  );
}

function StatCard({ icon: Icon, label, value, sub, color }: any) {
  return (
    <div className="nvc-card flex items-center gap-3 p-4">
      <span className="grid h-11 w-11 place-items-center rounded-xl" style={{ background: `${color}22`, color }}>
        <Icon className="h-5 w-5" />
      </span>
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
        <p className="text-xl font-bold text-white">{value}</p>
        <p className="text-[11px] text-slate-600">{sub}</p>
      </div>
    </div>
  );
}
