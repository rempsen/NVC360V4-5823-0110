import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { api } from "../../lib/api";
import { ok } from "../../lib/api-ok";
import { FullLoader } from "../../components/loader";
import { StatusBadge, PageWrap } from "../../components/brand";
import { PageHead } from "./shell";
import { fmtDate, money, TECH_STATUS } from "../../lib/utils";
import { RunningLateBoard } from "../../components/running-late-board";
import { useWorkerNoun, useCustomerNoun } from "../../lib/use-brand";
import {
  ClipboardList,
  Activity,
  CheckCircle2,
  DollarSign,
  Users,
  Wrench,
  ArrowRight,
  MapPin,
  CalendarDays,
  X,
} from "lucide-react";

// ---- date-range helpers ----------------------------------------------------
type Basis = "scheduled" | "created";
type RangeKey = "all" | "today" | "last7" | "month" | "custom";

const startOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const fmtInput = (d: Date) => {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 10);
};

/** Resolve a preset (or custom dates) into [from, to) epoch-ms bounds. */
function resolveRange(
  key: RangeKey,
  customFrom: string,
  customTo: string,
): { from: number | null; to: number | null } {
  const now = new Date();
  if (key === "today") {
    const f = startOfDay(now);
    const t = new Date(f);
    t.setDate(t.getDate() + 1);
    return { from: f.getTime(), to: t.getTime() };
  }
  if (key === "last7") {
    const t = startOfDay(now);
    t.setDate(t.getDate() + 1); // through end of today
    const f = new Date(t);
    f.setDate(f.getDate() - 7);
    return { from: f.getTime(), to: t.getTime() };
  }
  if (key === "month") {
    const f = new Date(now.getFullYear(), now.getMonth(), 1);
    const t = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { from: f.getTime(), to: t.getTime() };
  }
  if (key === "custom") {
    const f = customFrom ? startOfDay(new Date(customFrom + "T00:00:00")) : null;
    let t: Date | null = null;
    if (customTo) {
      t = startOfDay(new Date(customTo + "T00:00:00"));
      t.setDate(t.getDate() + 1); // inclusive end day
    }
    return { from: f ? f.getTime() : null, to: t ? t.getTime() : null };
  }
  return { from: null, to: null }; // all
}

const PRESETS: { key: RangeKey; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "today", label: "Today" },
  { key: "last7", label: "Last 7 days" },
  { key: "month", label: "This month" },
  { key: "custom", label: "Custom" },
];

const FLEET_SORT: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "enroute", label: "En Route" },
  { key: "available", label: "Available" },
  { key: "onsite", label: "On Site" },
  { key: "busy", label: "Busy" },
  { key: "break", label: "Break" },
  { key: "offline", label: "Offline" },
];

// priority order for the "all" view — most relevant first
const STATUS_ORDER: Record<string, number> = {
  enroute: 0,
  onsite: 1,
  busy: 2,
  available: 3,
  break: 4,
  offline: 5,
};

/**
 * KPI-tile currency. money() renders full cents ($15048.16), which at 390px
 * overflowed the two-up KPI grid and got clipped by the card's overflow-hidden.
 * Cents are noise in a headline metric, and past $100k we compact further.
 */
function kpiMoney(n: number) {
  if (!Number.isFinite(n)) return "$0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 100_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

export default function AdminDashboard() {
  const { noun: workerNoun, nounPlural: workerPlural } = useWorkerNoun();
  const { nounPlural: customerPlural } = useCustomerNoun();
  const [fleetSort, setFleetSort] = useState("all");

  // date-range filter state (drives the top six cards)
  const [rangeKey, setRangeKey] = useState<RangeKey>("all");
  const [basis, setBasis] = useState<Basis>("scheduled");
  const [customFrom, setCustomFrom] = useState(() => fmtInput(new Date()));
  const [customTo, setCustomTo] = useState(() => fmtInput(new Date()));

  const range = useMemo(
    () => resolveRange(rangeKey, customFrom, customTo),
    [rangeKey, customFrom, customTo],
  );
  const hasRange = range.from != null || range.to != null;

  const stats = useQuery({
    queryKey: ["admin-stats", range.from, range.to, basis],
    queryFn: async () => {
      const query: Record<string, string> = {};
      if (range.from != null) query.from = String(range.from);
      if (range.to != null) query.to = String(range.to);
      if (hasRange) query.basis = basis;
      return ok(await api.admin.stats.$get({ query }));
    },
    refetchInterval: 10000,
  });
  const bookings = useQuery({
    queryKey: ["bookings"],
    queryFn: async () => ok(await api.bookings.$get()),
  });
  const fleet = useQuery({
    queryKey: ["fleet"],
    queryFn: async () => ok(await api.fleet.$get()),
    refetchInterval: 8000,
  });

  if (stats.isLoading || bookings.isLoading)
    return <FullLoader label="Loading console…" />;
  if (stats.isError || !stats.data)
    return (
      <PageWrap>
        <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
          <p className="text-sm font-semibold text-red-400">Failed to load dashboard stats</p>
          <button
            onClick={() => stats.refetch()}
            className="rounded-lg bg-brand px-4 py-2 text-xs font-semibold text-white hover:bg-brand-deep"
          >
            Retry
          </button>
        </div>
      </PageWrap>
    );
  const s = stats.data;
  const recent = (bookings.data?.bookings ?? [])
    .slice()
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    .slice(0, 6);

  let techs = (fleet.data?.fleet ?? []).slice();
  if (fleetSort === "all") {
    techs.sort(
      (a, b) =>
        (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99),
    );
  } else {
    techs = techs.filter((t) => t.status === fleetSort);
  }

  const cards = [
    {
      label: "Work orders",
      value: s.totalBookings,
      icon: ClipboardList,
      iconTint: "bg-sky-500/10 text-sky-400",
      topBorder: "border-t-sky-500/40",
      to: "/admin/work-orders",
    },
    {
      label: "Active jobs",
      value: s.activeBookings,
      icon: Activity,
      iconTint: "bg-amber-500/10 text-amber-400",
      topBorder: "border-t-amber-500/40",
      to: "/admin/work-orders?status=active",
      hint: s.activeBookings === 0 ? "Nothing in progress" : undefined,
    },
    {
      label: "Completed",
      value: s.completedBookings,
      icon: CheckCircle2,
      iconTint: "bg-emerald-500/10 text-emerald-400",
      topBorder: "border-t-emerald-500/40",
      to: "/admin/work-orders?status=completed",
    },
    {
      label: "Revenue",
      value: kpiMoney(s.revenue),
      icon: DollarSign,
      iconTint: "bg-emerald-500/10 text-emerald-400",
      topBorder: "border-t-emerald-500/40",
      to: "/admin/payouts",
    },
    {
      label: customerPlural,
      value: s.customers,
      icon: Users,
      iconTint: "bg-brand/10 text-brand",
      topBorder: "border-t-brand/40",
      to: "/admin/clients",
    },
    {
      label: workerPlural,
      value: s.riders,
      icon: Wrench,
      iconTint: "bg-violet-500/10 text-violet-400",
      topBorder: "border-t-violet-500/40",
      to: "/admin/techs",
    },
  ];

  return (
    <PageWrap>
      <PageHead
        title="Operations Dashboard"
        subtitle="Live overview of your field service fleet"
      />

      <RunningLateBoard workerNoun={workerNoun} />

      {/* date-range filter for the metric cards */}
      <div className="nvc-card mb-4 flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
        <div className="flex items-center gap-2 text-slate-400">
          <CalendarDays className="h-4 w-4 text-cyan-glow" />
          <span className="text-xs font-semibold uppercase tracking-wide">
            Date range
          </span>
        </div>

        {/* presets */}
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => {
            const active = rangeKey === p.key;
            return (
              <button
                key={p.key}
                onClick={() => setRangeKey(p.key)}
                className={`rounded-full px-3 py-1 text-[12px] font-semibold transition ${
                  active
                    ? "bg-brand text-white"
                    : "bg-ink-2 text-slate-400 hover:bg-white/5"
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        {/* custom date inputs */}
        {rangeKey === "custom" && (
          <div className="flex items-center gap-2">
            <input aria-label="Custom From"
              type="date"
              value={customFrom}
              max={customTo}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-lg border border-white/10 bg-ink-2 px-2 py-1 text-xs text-slate-200 outline-none focus:border-brand/50"
            />
            <span className="text-xs text-slate-500">to</span>
            <input aria-label="Custom To"
              type="date"
              value={customTo}
              min={customFrom}
              onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-lg border border-white/10 bg-ink-2 px-2 py-1 text-xs text-slate-200 outline-none focus:border-brand/50"
            />
          </div>
        )}

        {/* basis toggle — which date to filter on (only matters with a range) */}
        {hasRange && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[11px] text-slate-500">by</span>
            <div className="flex overflow-hidden rounded-lg border border-white/10">
              {(["scheduled", "created"] as Basis[]).map((b) => (
                <button
                  key={b}
                  onClick={() => setBasis(b)}
                  className={`px-2.5 py-1 text-[11px] font-semibold capitalize transition ${
                    basis === b
                      ? "bg-white/10 text-white"
                      : "bg-transparent text-slate-400 hover:bg-white/5"
                  }`}
                >
                  {b} date
                </button>
              ))}
            </div>
            <button
              onClick={() => setRangeKey("all")}
              title="Clear filter"
              className="grid h-6 w-6 place-items-center rounded-md text-slate-500 hover:bg-white/5 hover:text-slate-300"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {cards.map((c) => (
          <Link
            key={c.label}
            to={c.to}
            className={`nvc-card group relative overflow-hidden border-t-2 p-5 transition-all duration-200 hover:bg-white/[0.025] hover:shadow-lg hover:shadow-black/20 hover:-translate-y-px ${c.topBorder}`}
          >
            <div className="flex items-start justify-between gap-2">
              {/* min-w-0 + a smaller type ramp below sm: at 390px the two-up
                  grid leaves ~140px per card, and a real revenue figure like
                  $15048.16 was being clipped by the card's overflow-hidden. */}
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{c.label}</p>
                <div className="mt-2 font-display text-[22px] font-black leading-none tracking-tight text-white tabular-nums sm:text-[28px]">
                  {c.value}
                </div>
                {"hint" in c && c.hint && (
                  <p className="mt-1 text-[11px] text-slate-600">{c.hint}</p>
                )}
              </div>
              <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${c.iconTint}`}>
                <c.icon className="h-[18px] w-[18px]" />
              </div>
            </div>
            <div className="mt-3 flex items-center gap-1 text-[11px] font-medium text-slate-600 transition-colors group-hover:text-brand">
              View details <ArrowRight className="h-3 w-3 translate-x-0 opacity-0 transition-all duration-150 group-hover:translate-x-0.5 group-hover:opacity-100" />
            </div>
          </Link>
        ))}
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-3">
        {/* recent work orders */}
        {/* min-w-0: a grid item's automatic minimum size is its min-content
            width, so this card grew past the 390px viewport and nvc-card's
            overflow-hidden clipped "View all" and the price column away. */}
        <div className="nvc-card min-w-0 lg:col-span-2">
          <div className="flex items-center justify-between gap-3 border-b border-white/5 px-5 py-4">
            <h2 className="truncate font-bold text-white">Recent work orders</h2>
            <Link
              to="/admin/work-orders"
              className="-my-3 flex shrink-0 items-center gap-1 py-3 text-sm font-semibold text-cyan-glow lg:my-0 lg:py-0"
            >
              View all <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <div className="divide-y divide-white/[0.04]">
            {recent.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-14">
                <ClipboardList className="h-8 w-8 text-slate-700" />
                <p className="text-sm text-slate-500">No work orders yet</p>
              </div>
            ) : (
              recent.map((b) => (
                <Link
                  key={b.id}
                  to="/admin/work-orders"
                  className="group flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-white/[0.02] sm:gap-4 sm:px-5"
                >
                  {/* avatar */}
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-slate-800 text-[11px] font-bold text-slate-300 ring-1 ring-white/5">
                    {(b.customer?.name ?? "?").split(" ").map((x: string) => x[0]).slice(0, 2).join("")}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-slate-100">
                        {b.customer?.name ?? "—"}
                      </span>
                      <StatusBadge status={b.status} />
                    </div>
                    <p className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-slate-500">
                      <Wrench className="h-3 w-3 shrink-0 text-slate-600" />
                      {b.rider?.name ? (
                        <span>{b.rider.name}</span>
                      ) : (
                        <span className="text-slate-600 italic">Unassigned</span>
                      )}
                      <span className="text-slate-700">·</span>
                      <span>{fmtDate(b.scheduledAt)}</span>
                    </p>
                  </div>
                  <div className="max-w-[40%] shrink-0 text-right">
                    <div className="truncate text-sm font-bold text-white tabular-nums">{money(b.price)}</div>
                    <p className="mt-0.5 truncate text-[11px] text-slate-500">
                      {b.title || b.service?.name || "—"}
                    </p>
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>

        {/* fleet status */}
        <div className="nvc-card min-w-0">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
            <div>
              <h2 className="text-sm font-bold text-white">Fleet status</h2>
              <p className="text-[11px] text-slate-500 mt-0.5">Live technician availability</p>
            </div>
            <Link
              to="/admin/fleet"
              className="flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-[11px] font-semibold text-slate-400 transition hover:border-brand/30 hover:text-brand"
            >
              <MapPin className="h-3 w-3" /> Map
            </Link>
          </div>
          {/* sort / filter chips */}
          <div className="flex flex-wrap gap-1.5 border-b border-white/5 px-4 py-2.5">
            {FLEET_SORT.map((f) => {
              const count =
                f.key === "all"
                  ? (fleet.data?.fleet ?? []).length
                  : (fleet.data?.fleet ?? []).filter(
                      (t) => t.status === f.key,
                    ).length;
              const active = fleetSort === f.key;
              const meta = TECH_STATUS[f.key];
              return (
                <button
                  key={f.key}
                  onClick={() => setFleetSort(f.key)}
                  className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                    active
                      ? "bg-brand text-white"
                      : "bg-ink-2 text-slate-400 hover:bg-white/5"
                  }`}
                >
                  {meta && (
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: meta.color }}
                    />
                  )}
                  {f.label}
                  <span
                    className={active ? "text-white/70" : "text-slate-600"}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="max-h-[360px] divide-y divide-white/5 overflow-y-auto">
            {techs.length === 0 ? (
              <p className="py-10 text-center text-sm text-slate-500">
                No {workerPlural.toLowerCase()} {fleetSort !== "all" && `· ${fleetSort}`}
              </p>
            ) : (
              techs.map((t) => {
                const meta = TECH_STATUS[t.status] ?? {
                  label: t.status,
                  color: "#64748b",
                };
                return (
                  <Link
                    key={t.id}
                    to="/admin/fleet"
                    className="flex items-center gap-3 px-5 py-3 transition hover:bg-white/[0.03]"
                  >
                    <span
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-bold text-ink"
                      style={{ background: t.color ?? "#334155" }}
                    >
                      {t.name
                        .split(" ")
                        .map((x) => x[0])
                        .slice(0, 2)
                        .join("")}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-slate-100">
                        {t.name}
                      </p>
                      <p className="truncate text-xs text-slate-500">
                        {t.task?.title ?? t.skillClass ?? "Idle"}
                      </p>
                    </div>
                    <span
                      className="flex items-center gap-1 text-[11px] font-semibold"
                      style={{ color: meta.color }}
                    >
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: meta.color }}
                      />
                      {meta.label}
                    </span>
                  </Link>
                );
              })
            )}
          </div>
        </div>
      </div>
    </PageWrap>
  );
}
