import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiHeaders } from "../../lib/api";
import { PageWrap } from "../../components/brand";
import { PageHead } from "./shell";
import { FullLoader } from "../../components/loader";
import {
  ResponsiveContainer, BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import {
  Download, FileText, FileSpreadsheet, FileType2, ChevronDown,
  DollarSign, Wrench, ClipboardList, Wallet, Boxes, Users, Receipt, Map,
  Database, Table as TableIcon,
} from "lucide-react";
import { useWorkerNoun, useCustomerNoun, useJobNoun } from "../../lib/use-brand";

/* ------------------------------ config ------------------------------ */
type ReportId =
  | "revenue" | "tech-performance" | "job-status" | "payroll"
  | "catalog" | "clients" | "invoices-ar" | "zones";

const REPORTS: { id: ReportId; label: string; icon: any; desc: string }[] = [
  { id: "revenue", label: "Revenue & Sales", icon: DollarSign, desc: "Income, AOV, margin by day & service" },
  { id: "tech-performance", label: "Tech Performance", icon: Wrench, desc: "Jobs, revenue, ratings per technician" },
  { id: "job-status", label: "Job Status", icon: ClipboardList, desc: "Completion, pipeline & priority mix" },
  { id: "payroll", label: "Payroll & Payouts", icon: Wallet, desc: "Gross, fees, net & pending by tech" },
  { id: "catalog", label: "Catalog Margin", icon: Boxes, desc: "Item revenue, COGS & margin" },
  { id: "clients", label: "Client Activity", icon: Users, desc: "Top clients, new vs returning" },
  { id: "invoices-ar", label: "Invoices / AR", icon: Receipt, desc: "Collected, outstanding & aging" },
  { id: "zones", label: "Zone Breakdown", icon: Map, desc: "Jobs & revenue per service zone" },
];

const PIE_COLORS = ["#06B6D4", "#34d399", "#a78bfa", "#fbbf24", "#f472b6", "#60a5fa", "#f87171", "#94a3b8", "#2dd4bf", "#fb923c"];

function isoDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const PRESETS: { id: string; label: string; range: () => [string, string] }[] = [
  { id: "7d", label: "7 days", range: () => [isoDay(new Date(Date.now() - 6 * 864e5)), isoDay(new Date())] },
  { id: "30d", label: "30 days", range: () => [isoDay(new Date(Date.now() - 29 * 864e5)), isoDay(new Date())] },
  { id: "90d", label: "90 days", range: () => [isoDay(new Date(Date.now() - 89 * 864e5)), isoDay(new Date())] },
  { id: "ytd", label: "YTD", range: () => [isoDay(new Date(new Date().getFullYear(), 0, 1)), isoDay(new Date())] },
  { id: "12m", label: "12 mo", range: () => [isoDay(new Date(Date.now() - 365 * 864e5)), isoDay(new Date())] },
];

const fmtMoney = (n: number) => `$${(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtCell = (v: any, kind?: string) => {
  if (v == null || v === "") return "—";
  if (kind === "money") return fmtMoney(Number(v));
  if (kind === "pct") return `${Number(v).toFixed(1)}%`;
  if (kind === "num") return Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (kind === "date") { const d = new Date(v); return isNaN(+d) ? String(v) : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
  return String(v);
};

/* ------------------------------ page ------------------------------ */
export default function ReportsPage() {
  const { noun, nounPlural } = useWorkerNoun();
  const relabel = (s: string) =>
    s.replace(/Tech Performance/g, `${noun} Performance`).replace(/per technician/g, `per ${noun.toLowerCase()}`);
  const [report, setReport] = useState<ReportId>("revenue");
  const [preset, setPreset] = useState("90d");
  const init = PRESETS.find((p) => p.id === "90d")!.range();
  const [from, setFrom] = useState(init[0]);
  const [to, setTo] = useState(init[1]);
  const [techId, setTechId] = useState("");
  const [status, setStatus] = useState("");
  const [downloading, setDownloading] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const filters = useQuery({
    queryKey: ["report-filters"],
    queryFn: async () => (await fetch("/api/reports/meta/filters", { headers: apiHeaders() })).json(),
  });

  const qs = useMemo(() => {
    const p = new URLSearchParams({ from, to });
    if (techId) p.set("techId", techId);
    if (status) p.set("status", status);
    return p.toString();
  }, [from, to, techId, status]);

  const data = useQuery({
    queryKey: ["report", report, qs],
    queryFn: async () => (await fetch(`/api/reports/${report}?${qs}`, { headers: apiHeaders() })).json(),
  });

  const applyPreset = (id: string) => {
    setPreset(id);
    const [f, t] = PRESETS.find((p) => p.id === id)!.range();
    setFrom(f); setTo(t);
  };

  async function exportAs(format: "csv" | "xlsx" | "pdf") {
    if (!data.data) return;
    setMenuOpen(false);
    setDownloading(format);
    try {
      const meta = REPORTS.find((r) => r.id === report)!;
      const res = await fetch(`/api/export/report?format=${format}`, {
        method: "POST",
        headers: { ...apiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          title: meta.label,
          subtitle: `${from} → ${to}`,
          rows: (data.data as any).rows,
          columns: (data.data as any).columns,
        }),
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `nvc360-${report}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(null);
    }
  }

  const d = data.data as any;
  const activeMeta = REPORTS.find((r) => r.id === report)!;
  const f = filters.data as any;

  return (
    <PageWrap>
      <PageHead
        title="Reports & Analytics"
        subtitle="Operational insight across revenue, fleet, payroll, catalog & clients"
        actions={
          <div className="relative">
            <button
              onClick={() => setMenuOpen((v) => !v)}
              disabled={!d || !d.rows?.length}
              className="flex items-center gap-2 rounded-xl bg-emerald-live px-4 py-2 text-sm font-semibold text-ink hover:opacity-90 disabled:opacity-50"
            >
              {downloading ? <span className="animate-pulse">Exporting…</span> : <><Download className="h-4 w-4" /> Export <ChevronDown className="h-3.5 w-3.5" /></>}
            </button>
            {menuOpen && (
              <div className="absolute right-0 z-30 mt-2 w-44 overflow-hidden rounded-xl border border-white/10 bg-ink-2 shadow-2xl">
                <ExportItem icon={FileText} label="CSV" onClick={() => exportAs("csv")} />
                <ExportItem icon={FileSpreadsheet} label="Excel (.xlsx)" onClick={() => exportAs("xlsx")} />
                <ExportItem icon={FileType2} label="PDF" onClick={() => exportAs("pdf")} />
              </div>
            )}
          </div>
        }
      />

      {/* filter bar */}
      <div className="mb-5 flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-ink-2/60 p-2.5">
        <div className="flex items-center gap-1 rounded-xl bg-ink-3/60 p-1">
          {PRESETS.map((p) => (
            <button key={p.id} onClick={() => applyPreset(p.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${preset === p.id ? "bg-brand text-white" : "text-slate-400 hover:text-white"}`}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <input aria-label="From" type="date" value={from} max={to} onChange={(e) => { setFrom(e.target.value); setPreset(""); }}
            className="rounded-lg bg-ink-3/60 px-2.5 py-2 text-slate-200 outline-none [color-scheme:dark]" />
          <span className="text-slate-500">→</span>
          <input aria-label="To" type="date" value={to} min={from} onChange={(e) => { setTo(e.target.value); setPreset(""); }}
            className="rounded-lg bg-ink-3/60 px-2.5 py-2 text-slate-200 outline-none [color-scheme:dark]" />
        </div>
        <select value={techId} onChange={(e) => setTechId(e.target.value)}
          className="rounded-lg bg-ink-3/60 px-2.5 py-2 text-xs text-slate-200 outline-none [color-scheme:dark]">
          <option value="">All {nounPlural.toLowerCase()}</option>
          {f?.techs?.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}
          className="rounded-lg bg-ink-3/60 px-2.5 py-2 text-xs text-slate-200 outline-none [color-scheme:dark] capitalize">
          <option value="">Any status</option>
          {f?.statuses?.map((s: string) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
        </select>
      </div>

      <div className="grid gap-5 lg:grid-cols-[230px_1fr]">
        {/* report tabs */}
        <div className="space-y-1.5">
          {REPORTS.map((r) => (
            <button key={r.id} type="button" aria-label={r.label} onClick={() => setReport(r.id)}
              className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition ${
                report === r.id ? "border-brand/40 bg-brand/10 text-white nvc-glow-sm" : "border-white/10 bg-ink-2 text-slate-400 hover:bg-white/5"}`}>
              <r.icon className={`mt-0.5 h-5 w-5 shrink-0 ${report === r.id ? "text-cyan-glow" : "text-slate-500"}`} />
              <div className="min-w-0">
                <p className="text-sm font-semibold leading-tight">{relabel(r.label)}</p>
                <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{relabel(r.desc)}</p>
              </div>
            </button>
          ))}
          <a href="#raw-export" className="mt-2 flex items-center gap-2 rounded-xl border border-dashed border-white/10 p-3 text-xs text-slate-500 hover:text-cyan-glow">
            <Database className="h-4 w-4" /> Raw data exports ↓
          </a>
        </div>

        {/* report body */}
        <div className="min-w-0">
          {data.isLoading || !d ? (
            <div className="flex h-72 items-center justify-center"><FullLoader label="Crunching numbers…" /></div>
          ) : (
            <div className="space-y-5">
              {/* KPIs */}
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {d.kpis.map((k: any, i: number) => <KPI key={i} {...k} />)}
              </div>

              {/* charts */}
              <div className={`grid gap-4 ${d.series2 ? "lg:grid-cols-[1.6fr_1fr]" : ""}`}>
                <ChartCard title={d.series.title}>
                  <Chart series={d.series} />
                </ChartCard>
                {d.series2 && (
                  <ChartCard title={d.series2.title}>
                    <Chart series={d.series2} />
                  </ChartCard>
                )}
              </div>

              {/* table */}
              <div className="nvc-card overflow-hidden">
                <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
                  <TableIcon className="h-4 w-4 text-cyan-glow" />
                  <h3 className="text-sm font-bold text-white">{activeMeta.label} — detail</h3>
                  <span className="ml-auto text-xs text-slate-500">{d.rows.length} rows</span>
                </div>
                <div className="max-h-[440px] overflow-auto">
                  {d.rows.length === 0 ? (
                    <p className="py-10 text-center text-sm text-slate-500">No data in this range.</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-ink-2 text-left text-xs uppercase tracking-wide text-slate-500">
                        <tr>{d.columns.map((c: any) => (
                          <th key={c.key} className={`px-4 py-2.5 font-semibold ${c.kind === "money" || c.kind === "num" || c.kind === "pct" ? "text-right" : ""}`}>{c.label}</th>
                        ))}</tr>
                      </thead>
                      <tbody>
                        {d.rows.map((row: any, ri: number) => (
                          <tr key={ri} className="border-t border-white/5 hover:bg-white/5">
                            {d.columns.map((c: any) => (
                              <td key={c.key} className={`px-4 py-2.5 ${c.kind === "money" || c.kind === "num" || c.kind === "pct" ? "text-right tabular-nums text-slate-200" : "text-slate-300"}`}>
                                {fmtCell(row[c.key], c.kind)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>
          )}

          <RawExports />
        </div>
      </div>
    </PageWrap>
  );
}

/* ------------------------------ pieces ------------------------------ */
function Chart({ series }: { series: any }) {
  if (series.type === "pie") {
    return (
      <ResponsiveContainer width="100%" height={260}>
        <PieChart>
          <Pie data={series.data} dataKey="value" nameKey={series.xKey} cx="50%" cy="50%" innerRadius={55} outerRadius={90} paddingAngle={2}>
            {series.data.map((_: any, i: number) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} stroke="#0b1220" strokeWidth={2} />)}
          </Pie>
          <Tooltip contentStyle={tipStyle} />
          <Legend wrapperStyle={{ fontSize: 11, color: "#94a3b8" }} />
        </PieChart>
      </ResponsiveContainer>
    );
  }
  if (series.type === "area") {
    return (
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={series.data}>
          <defs>
            {(series.bars ?? []).map((b: any) => (
              <linearGradient key={b.key} id={`g-${series.id}-${b.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={b.color} stopOpacity={0.5} />
                <stop offset="100%" stopColor={b.color} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
          <XAxis dataKey={series.xKey} tick={{ fontSize: 11, fill: "#64748b" }} />
          <YAxis tick={{ fontSize: 11, fill: "#64748b" }} width={48} />
          <Tooltip contentStyle={tipStyle} />
          {(series.bars ?? []).map((b: any) => (
            <Area key={b.key} type="monotone" dataKey={b.key} name={b.label} stroke={b.color} strokeWidth={2} fill={`url(#g-${series.id}-${b.key})`} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={series.data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis dataKey={series.xKey} tick={{ fontSize: 10, fill: "#64748b" }} interval={0} angle={series.data.length > 6 ? -25 : 0} textAnchor={series.data.length > 6 ? "end" : "middle"} height={series.data.length > 6 ? 56 : 30} />
        <YAxis tick={{ fontSize: 11, fill: "#64748b" }} width={48} />
        <Tooltip contentStyle={tipStyle} cursor={{ fill: "#ffffff08" }} />
        {(series.bars ?? []).length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
        {(series.bars ?? []).map((b: any) => (
          <Bar key={b.key} dataKey={b.key} name={b.label} fill={b.color} radius={[4, 4, 0, 0]} maxBarSize={46} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

const tipStyle = { background: "#0f172a", border: "1px solid #1e293b", borderRadius: 10, fontSize: 12, color: "#e2e8f0" };

function ChartCard({ title, children }: { title: string; children: any }) {
  return (
    <div className="nvc-card p-4">
      <h3 className="mb-2 text-sm font-bold text-white">{title}</h3>
      {children}
    </div>
  );
}

function KPI({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  const tint = tone === "good" ? "text-emerald-live" : tone === "bad" ? "text-red-400" : tone === "warn" ? "text-amber-warn" : "text-cyan-glow";
  return (
    <div className="nvc-card p-4">
      <p className="text-xs text-slate-400">{label}</p>
      <p className={`font-display text-2xl font-extrabold ${tint}`}>{value}</p>
      {sub && <p className="text-[11px] text-slate-500">{sub}</p>}
    </div>
  );
}

function ExportItem({ icon: Icon, label, onClick }: { icon: any; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm text-slate-200 hover:bg-white/5">
      <Icon className="h-4 w-4 text-cyan-glow" /> {label}
    </button>
  );
}

/* --------------------- raw dataset exports (CSV/XLSX/PDF) --------------------- */
const RAW_DATASETS = [
  { id: "work-orders", label: "Work Orders", icon: ClipboardList },
  { id: "technicians", label: "Technicians", icon: Wrench },
  { id: "clients", label: "Clients", icon: Users },
  { id: "invoices", label: "Invoices", icon: Receipt },
];
function RawExports() {
  const { nounPlural } = useWorkerNoun();
  const { nounPlural: customerNounPlural } = useCustomerNoun();
  const { nounPlural: jobNounPlural } = useJobNoun();
  const [busy, setBusy] = useState("");
  async function dl(ds: string, format: string) {
    setBusy(`${ds}-${format}`);
    try {
      const res = await fetch(`/api/export/${ds}?format=${format}`, { headers: apiHeaders() });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `nvc360-${ds}.${format}`; a.click();
      URL.revokeObjectURL(url);
    } finally { setBusy(""); }
  }
  return (
    <div id="raw-export" className="nvc-card mt-5 p-5">
      <div className="mb-1 flex items-center gap-2">
        <Database className="h-4 w-4 text-cyan-glow" />
        <h3 className="text-sm font-bold text-white">Raw data exports</h3>
      </div>
      <p className="mb-4 text-xs text-slate-500">Full unaggregated tables for accounting, payroll or BI tools.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {RAW_DATASETS.map((d) => (
          <div key={d.id} className="flex items-center gap-3 rounded-xl border border-white/10 bg-ink-3/40 p-3">
            <d.icon className="h-5 w-5 text-slate-400" />
            <span className="flex-1 text-sm font-semibold text-slate-200">{d.id === "technicians" ? nounPlural : d.id === "clients" ? customerNounPlural : d.id === "work-orders" ? jobNounPlural : d.label}</span>
            {["csv", "xlsx", "pdf"].map((fmt) => (
              <button key={fmt} onClick={() => dl(d.id, fmt)} disabled={busy === `${d.id}-${fmt}`}
                className="rounded-lg bg-white/5 px-2.5 py-1.5 text-[11px] font-bold uppercase text-slate-300 hover:bg-brand hover:text-white disabled:opacity-50">
                {busy === `${d.id}-${fmt}` ? "…" : fmt}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
