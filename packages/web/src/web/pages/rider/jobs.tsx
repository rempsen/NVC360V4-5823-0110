import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { StatusBadge } from "../../components/brand";
import { FullLoader, Loader } from "../../components/loader";
import { StoredImage } from "../../components/stored-image";
import { fmtDate, money } from "../../lib/utils";
import { MapPin, Calendar, ArrowRight, Power, AlertCircle } from "lucide-react";

export default function RiderJobs() {
  const qc = useQueryClient();
  const [toggleErr, setToggleErr] = useState<string | null>(null);

  const me = useQuery({
    queryKey: ["rider-me"],
    queryFn: async () => (await api.riders.me.$get()).json(),
  });
  const bookings = useQuery({
    queryKey: ["bookings"],
    queryFn: async () => (await api.bookings.$get()).json(),
  });

  const toggle = useMutation({
    mutationFn: async (status: string) => {
      const res = await api.riders.me.$patch({ json: { status } });
      if (!res.ok) throw new Error(`Status ${res.status}`);
    },
    onSuccess: () => {
      setToggleErr(null);
      qc.invalidateQueries({ queryKey: ["rider-me"] });
    },
    onError: (e: Error) => {
      setToggleErr(e.message.includes("403") ? "Permission denied — contact your dispatcher." : "Failed to update status. Try again.");
    },
  });

  if (bookings.isLoading || me.isLoading) return <FullLoader label="Loading jobs…" />;
  const rider = (me.data as any)?.rider;
  const list = bookings.data?.bookings ?? [];
  const offered = list.filter((b: any) => b.status === "assigned" && b.assignStatus === "offered");
  const active = list.filter((b: any) => ["enroute", "arrived", "in_progress"].includes(b.status) || (b.status === "assigned" && b.assignStatus === "accepted"));
  const upcoming = list.filter((b) => b.status === "confirmed");
  const done = list.filter((b) => b.status === "completed");
  const online = rider?.status !== "offline";

  return (
    <div className="space-y-6">
      {/* status header */}
      <div className="flex items-center justify-between rounded-2xl bg-gradient-to-r from-brand to-brand-deep p-5 text-white shadow-lg shadow-brand/20">
        <div>
          <h1 className="text-xl font-extrabold">Your jobs</h1>
          <p className="text-sm text-white/80">{online ? "You're online & accepting jobs" : "You're offline"}</p>
        </div>
        <button
          disabled={toggle.isPending}
          onClick={() => { setToggleErr(null); toggle.mutate(online ? "offline" : "available"); }}
          className={`flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold transition disabled:opacity-60 ${online ? "bg-white text-cyan-glow" : "bg-white/20 text-white"}`}
        >
          {toggle.isPending
            ? <Loader className="h-4 w-4 border-current/30 border-t-current" />
            : <Power className="h-4 w-4" />}
          {online ? "Online" : "Go online"}
        </button>
      </div>

      {/* toggle error banner */}
      {toggleErr && (
        <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {toggleErr}
          <button onClick={() => setToggleErr(null)} className="ml-auto text-red-300 hover:text-red-100">✕</button>
        </div>
      )}

      {offered.length > 0 && (
        <div className="rounded-2xl border border-amber-400/30 bg-amber-400/5 p-3">
          <h2 className="mb-2 flex items-center gap-2 px-1 text-sm font-bold uppercase tracking-wide text-amber-300">
            New offers <span className="rounded-full bg-amber-400/20 px-1.5 text-[11px]">{offered.length}</span>
          </h2>
          <div className="space-y-3">
            {offered.map((b) => <JobCard key={b.id} b={b} cta="Respond" />)}
          </div>
        </div>
      )}
      {active.length > 0 && (
        <Group title="Active" count={active.length}>
          {active.map((b) => <JobCard key={b.id} b={b} cta="Continue job" />)}
        </Group>
      )}
      {upcoming.length > 0 && (
        <Group title="Assigned to you" count={upcoming.length}>
          {upcoming.map((b) => <JobCard key={b.id} b={b} cta="Start job" />)}
        </Group>
      )}
      <Group title="Completed" count={done.length}>
        {done.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">No completed jobs yet</p>
        ) : (
          done.map((b) => <JobCard key={b.id} b={b} cta="View" />)
        )}
      </Group>
    </div>
  );
}

function Group({ title, count, children }: any) {
  return (
    <div>
      <h2 className="mb-2 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-500">
        {title} <span className="rounded-full bg-white/10 px-1.5 text-[11px] text-slate-600">{count}</span>
      </h2>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function JobCard({ b, cta }: { b: any; cta: string }) {
  return (
    <Link to={`/rider/job/${b.id}`}>
      <div className="group flex items-center gap-4 rounded-2xl border border-white/5 bg-ink-2 p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
        {b.service?.image && <StoredImage src={b.service.image} className="h-14 w-14 rounded-xl object-cover" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-bold text-white">{b.service?.name}</h3>
            <StatusBadge status={b.status} />
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
            <span className="flex items-center gap-1"><Calendar className="h-3.5 w-3.5" />{fmtDate(b.scheduledAt)}</span>
            <span className="flex items-center gap-1 truncate"><MapPin className="h-3.5 w-3.5" />{b.address}</span>
          </div>
          {b.customer && <p className="mt-0.5 text-xs text-slate-500">Customer: {b.customer.name}</p>}
        </div>
        <div className="text-right">
          <div className="font-extrabold text-green-600">{money(b.techPay ?? b.price)}</div>
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-cyan-glow">{cta}<ArrowRight className="h-3 w-3" /></span>
        </div>
      </div>
    </Link>
  );
}
