import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { ok } from "../../lib/api-ok";
import { FullLoader } from "../../components/loader";
import { fmtDate, money } from "../../lib/utils";
import { StatusBadge } from "../../components/brand";
import { Wallet, TrendingUp, CheckCircle2, CalendarDays, AlertCircle } from "lucide-react";

export default function RiderEarnings() {
  const bookings = useQuery({
    queryKey: ["bookings"],
    queryFn: async () => ok(await api.bookings.$get()),
  });

  if (bookings.isLoading) return <FullLoader label="Loading earnings…" />;

  if (bookings.isError) return (
    <div className="flex flex-col items-center gap-3 py-20 text-center">
      <AlertCircle className="h-8 w-8 text-red-400" />
      <p className="text-sm text-slate-500">Could not load earnings. Pull to refresh.</p>
    </div>
  );

  const list = bookings.data?.bookings ?? [];
  const completed = list.filter((b) => b.status === "completed");

  // Use techPay if available (unit-line jobs), fallback to price
  const toEarnings = (b: any) => Number(b.techPay ?? b.price ?? 0);

  const total = completed.reduce((s, b) => s + toEarnings(b), 0);

  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const weekly = completed
    .filter((b) => new Date(b.scheduledAt).getTime() >= weekAgo)
    .reduce((s, b) => s + toEarnings(b), 0);

  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-gradient-to-br from-brand to-brand-deep p-6 text-white shadow-lg shadow-brand/20">
        <div className="flex items-center gap-2 text-sm text-white/80">
          <Wallet className="h-4 w-4" /> Total earnings
        </div>
        <div className="mt-1 font-display text-4xl font-extrabold">{money(total)}</div>
        <p className="mt-1 text-sm text-white/70">From {completed.length} completed jobs</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Stat icon={TrendingUp} label="This week" value={money(weekly)} tint="text-green-600 bg-green-50" />
        <Stat icon={CheckCircle2} label="Jobs done" value={String(completed.length)} tint="text-cyan-glow bg-brand/15" />
      </div>

      <div>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-500">
          <CalendarDays className="h-4 w-4" /> Payout history
        </h2>
        <div className="space-y-3">
          {completed.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-white/10 py-10 text-center text-sm text-slate-500">
              No completed jobs yet. Finish a job to start earning.
            </p>
          ) : (
            completed
              .slice()
              .sort((a, b) => new Date(b.scheduledAt).getTime() - new Date(a.scheduledAt).getTime())
              .map((b) => (
                <div
                  key={b.id}
                  className="flex items-center gap-4 rounded-2xl border border-white/5 bg-ink-2 p-4 shadow-sm"
                >
                  {b.service?.image && (
                    <img src={b.service.image} alt="" className="h-12 w-12 rounded-xl object-cover" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate font-bold text-white">{b.service?.name}</h3>
                      <StatusBadge status={b.status} />
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">{fmtDate(b.scheduledAt)}</p>
                    {b.customer && <p className="text-xs text-slate-500">{b.customer.name}</p>}
                  </div>
                  <div className="font-extrabold text-green-600">+{money(toEarnings(b))}</div>
                </div>
              ))
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value, tint }: any) {
  return (
    <div className="rounded-2xl border border-white/5 bg-ink-2 p-4 shadow-sm">
      <div className={`mb-2 grid h-9 w-9 place-items-center rounded-xl ${tint}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="font-display text-2xl font-extrabold text-white">{value}</div>
      <p className="text-xs text-slate-500">{label}</p>
    </div>
  );
}
