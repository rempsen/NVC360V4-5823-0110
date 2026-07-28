import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { FullLoader } from "../../components/loader";
import { PageWrap } from "../../components/brand";
import { PageHead } from "./shell";
import { Modal, Field, inputCls, BtnPrimary, BtnGhost } from "../../components/modal";
import { Plus, CheckCircle2, Clock, DollarSign } from "lucide-react";
import { useWorkerNoun } from "../../lib/use-brand";

const money = (n: number) => `$${(n ?? 0).toFixed(2)}`;
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
    feePct: 20,
  });

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
          feePct: range.feePct,
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
        subtitle="Earnings from completed & paid jobs"
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
          <table className="w-full text-sm">
            <thead className="border-b border-white/5 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">{noun}</th>
                <th className="px-4 py-3">Period</th>
                <th className="px-4 py-3 text-right">Jobs</th>
                <th className="px-4 py-3 text-right">Gross</th>
                <th className="px-4 py-3 text-right">Fee</th>
                <th className="px-4 py-3 text-right">Net</th>
                <th className="px-4 py-3 text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p: any) => (
                <tr key={p.id} className="border-b border-white/5 last:border-0">
                  <td className="px-4 py-3 font-semibold text-white">{p.riderName || "—"}</td>
                  <td className="px-4 py-3 text-slate-400">{fmtDate(p.periodStart)} – {fmtDate(p.periodEnd)}</td>
                  <td className="px-4 py-3 text-right text-slate-300">{p.jobsCount}</td>
                  <td className="px-4 py-3 text-right text-slate-300">{money(p.gross)}</td>
                  <td className="px-4 py-3 text-right text-slate-500">-{money(p.fee)} <span className="text-[10px]">({p.feePct}%)</span></td>
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
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={genOpen} onClose={() => setGenOpen(false)} title="Generate payouts" subtitle={`Aggregates completed + paid jobs by ${noun.toLowerCase()}`}
        footer={<><BtnGhost onClick={() => setGenOpen(false)}>Cancel</BtnGhost>
          <BtnPrimary disabled={generate.isPending} onClick={() => generate.mutate()}>{generate.isPending ? "Generating…" : "Generate"}</BtnPrimary></>}>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Period start"><input aria-label="Start" type="date" className={inputCls} value={range.start} onChange={(e) => setRange({ ...range, start: e.target.value })} /></Field>
            <Field label="Period end"><input aria-label="End" type="date" className={inputCls} value={range.end} onChange={(e) => setRange({ ...range, end: e.target.value })} /></Field>
          </div>
          <Field label="Platform fee (%)" hint="Deducted from gross to compute net payout">
            <input aria-label="Fee Pct" type="number" className={inputCls} value={range.feePct} onChange={(e) => setRange({ ...range, feePct: parseFloat(e.target.value) || 0 })} />
          </Field>
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
