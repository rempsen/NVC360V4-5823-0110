// ─── Completed-job report ─────────────────────────────────────────────────
// Read-only "what actually happened" view for a finished job — times,
// mileage, the technician's actual driven route, photos, notes, and the
// pricing/tech-pay breakdown. Completed jobs are treated as historical
// records now, not editable work orders; the one intentional escape hatch
// is the admin/superadmin-only "Edit anyway" button for genuine corrections.
import { useState } from "react";
import { toast } from "../../components/toast";
import { useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft, Clock, Route as RouteIcon, Camera, FileText, Receipt,
  DollarSign, Phone, Mail, MapPin, Pencil, Download, X,
} from "lucide-react";
import { PageWrap } from "../../components/brand";
import { FullLoader } from "../../components/loader";
import { apiHeaders } from "../../lib/api";
import { money, fmtDate } from "../../lib/utils";
import { useAuth } from "../../hooks/use-auth";
import { RouteHistoryMap } from "../../components/route-history-map";
import { WorkOrderModal } from "../../components/work-order-modal";

async function jget<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include", headers: apiHeaders() });
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return res.json();
}

async function download(url: string) {
  try {
    const res = await fetch(url, { credentials: "include", headers: apiHeaders() });
    if (!res.ok) throw new Error(`export failed (${res.status})`);
    const blob = await res.blob();
    const cd = res.headers.get("content-disposition") || "";
    const m = /filename="?([^"]+)"?/.exec(cd);
    const name = m?.[1] || "export";
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objUrl);
  } catch (err) {
    // Module-level helper, outside the React tree — use the toast bridge.
    toast({ kind: "error", key: "export-failed", message: "Export failed. Please try again.", detail: err instanceof Error ? err.message : undefined });
  }
}

function mins(a?: string | number | Date | null, b?: string | number | Date | null): number | null {
  if (!a || !b) return null;
  const d = new Date(b).getTime() - new Date(a).getTime();
  return d >= 0 ? Math.round(d / 60000) : null;
}
function fmtMins(m: number | null): string {
  if (m == null) return "—";
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function Card({ title, icon, children, right }: { title: string; icon: React.ReactNode; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="nvc-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-bold text-white">{icon}{title}</h3>
        {right}
      </div>
      {children}
    </div>
  );
}

export default function JobReportPage() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { role } = useAuth();
  const canEditAnyway = role === "admin" || role === "superadmin";
  const [editOpen, setEditOpen] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["job-report", id],
    queryFn: () => jget<any>(`/api/jobs/${id}/report`),
  });
  // "Edit anyway" needs the RAW booking shape (customerId, serviceId, raw
  // lineItems JSON, etc.) that WorkOrderModal expects — the report above is
  // a different, display-oriented shape. Fetched lazily, only once the
  // admin actually opens the edit modal.
  const editQ = useQuery({
    queryKey: ["job-report-edit-source", id],
    queryFn: () => jget<{ booking: any }>(`/api/bookings/${id}`),
    enabled: editOpen,
  });

  if (q.isLoading) return <FullLoader label="Loading job report…" />;
  if (q.isError || !q.data) {
    return (
      <PageWrap>
        <p className="py-16 text-center text-sm text-slate-500">Couldn't load this job report.</p>
      </PageWrap>
    );
  }
  const j = q.data;
  const t = j.timeline || {};
  const transitLabel = fmtMins(j.transitMinutes ? Math.round(j.transitMinutes) : mins(t.enrouteAt, t.startedAt));
  const onSiteLabel = fmtMins(j.onSiteMinutes ? Math.round(j.onSiteMinutes) : mins(t.startedAt, t.finishedAt));
  const lineItems = j.pricing?.lineItems ?? [];

  return (
    <PageWrap>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <button
            onClick={() => navigate("/admin/work-orders")}
            className="mb-2 inline-flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-white"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to Jobs
          </button>
          <h1 className="font-display text-2xl font-bold text-white">{j.title || j.service || "Job"} <span className="ml-2 text-sm font-normal text-slate-500">#{j.jobNumber}</span></h1>
          <p className="mt-1 flex items-center gap-2 text-sm text-slate-400">
            <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-emerald-400">{j.status}</span>
            {fmtDate(t.finishedAt || t.scheduledAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => download(`/api/jobs/${id}/export?format=pdf`)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/5"
          >
            <Download className="h-3.5 w-3.5" /> Download PDF
          </button>
          {canEditAnyway && (
            <button
              onClick={() => setEditOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-300 hover:bg-amber-500/20"
              title="This job is completed — only use this to correct a genuine mistake"
            >
              <Pencil className="h-3.5 w-3.5" /> Edit anyway
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* left column */}
        <div className="space-y-4 lg:col-span-2">
          <Card title="Timeline" icon={<Clock className="h-4 w-4 text-brand" />}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Scheduled", t.scheduledAt],
                ["Assigned", t.assignedAt],
                ["Started driving", t.enrouteAt],
                ["Arrived on site", t.startedAt],
                ["Completed", t.finishedAt],
              ].map(([label, val]) => (
                <div key={label as string}>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
                  <p className="mt-0.5 text-sm font-semibold text-white">{val ? fmtDate(val as string) : "—"}</p>
                </div>
              ))}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 border-t border-white/5 pt-3 sm:grid-cols-4">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Drive time</p>
                <p className="mt-0.5 text-sm font-semibold text-cyan-glow">{transitLabel}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Time on site</p>
                <p className="mt-0.5 text-sm font-semibold text-amber-400">{onSiteLabel}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Mileage</p>
                <p className="mt-0.5 text-sm font-semibold text-white">{j.mileageKm ? `${Number(j.mileageKm).toFixed(1)} km` : "—"}</p>
              </div>
            </div>
          </Card>

          <Card title="Route driven" icon={<RouteIcon className="h-4 w-4 text-brand" />}>
            {j.route?.length ? (
              <>
                <div className="h-72 overflow-hidden rounded-lg">
                  <RouteHistoryMap pings={j.route} destination={j.lat != null ? { lat: j.lat, lng: j.lng } : null} />
                </div>
                <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-slate-400">
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#0ea5e9]" /> En route</span>
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#f59e0b]" /> On site</span>
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#22c55e]" /> Return</span>
                </div>
              </>
            ) : (
              <p className="py-8 text-center text-sm text-slate-500">
                No GPS route recorded for this job — either it predates route tracking, or the job's location
                history has since been purged.
              </p>
            )}
          </Card>

          <Card title="Photos" icon={<Camera className="h-4 w-4 text-brand" />}>
            {j.photos?.length ? (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {j.photos.map((p: any) => (
                  <button key={p.id} onClick={() => setLightbox(p.url)} className="group relative aspect-square overflow-hidden rounded-lg border border-white/10">
                    <img src={p.url} alt={p.caption || "Job photo"} className="h-full w-full object-cover transition group-hover:scale-105" />
                    {p.caption && <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1.5 py-1 text-[10px] text-white">{p.caption}</span>}
                  </button>
                ))}
              </div>
            ) : (
              <p className="py-4 text-center text-sm text-slate-500">No photos attached to this job.</p>
            )}
          </Card>

          <Card title="Notes" icon={<FileText className="h-4 w-4 text-brand" />}>
            <p className="whitespace-pre-wrap text-sm text-slate-300">{j.notes || "No notes recorded for this job."}</p>
          </Card>
        </div>

        {/* right column */}
        <div className="space-y-4">
          <Card title="Customer" icon={<MapPin className="h-4 w-4 text-brand" />}>
            <p className="text-sm font-semibold text-white">{j.customer?.name || "—"}</p>
            <p className="mt-1 text-sm text-slate-400">{j.address}{j.region ? `, ${j.region}` : ""}</p>
            {j.customer?.phone && <p className="mt-2 flex items-center gap-1.5 text-sm text-slate-300"><Phone className="h-3.5 w-3.5 text-slate-500" /> {j.customer.phone}</p>}
            {j.customer?.email && <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-300"><Mail className="h-3.5 w-3.5 text-slate-500" /> {j.customer.email}</p>}
            {j.technician && (
              <div className="mt-3 border-t border-white/5 pt-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Technician</p>
                <p className="mt-0.5 text-sm font-semibold text-white">{j.technician.name}</p>
              </div>
            )}
          </Card>

          <Card title="Pricing" icon={<Receipt className="h-4 w-4 text-brand" />}>
            {lineItems.length > 0 && (
              <div className="mb-3 space-y-1.5 border-b border-white/5 pb-3">
                {lineItems.map((li: any, i: number) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span className="text-slate-300">{li.qty ?? 1}× {li.name}</span>
                    <span className="font-semibold text-slate-200">{money(li.price ?? 0)}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-1 text-sm">
              <div className="flex justify-between text-slate-400"><span>Subtotal</span><span>{money(j.pricing?.subtotal ?? 0)}</span></div>
              <div className="flex justify-between text-slate-400"><span>{j.pricing?.taxLabel || "Tax"}</span><span>{money(j.pricing?.taxAmount ?? 0)}</span></div>
              <div className="flex justify-between border-t border-white/5 pt-1.5 text-base font-bold text-white"><span>Total</span><span>{money(j.pricing?.total ?? 0)}</span></div>
            </div>
            <p className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-emerald-400">{j.pricing?.paymentStatus}</p>
          </Card>

          <Card title="Technician pay" icon={<DollarSign className="h-4 w-4 text-amber-400" />}>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-rose-400">Internal — not shown to the customer</p>
            <p className="text-lg font-bold text-amber-300">{money(j.techPay?.total ?? 0)}</p>
          </Card>
        </div>
      </div>

      {lightbox && (
        <div className="fixed inset-0 z-[1100] grid place-items-center bg-black/90 p-6" onClick={() => setLightbox(null)}>
          <button aria-label="Close" className="absolute right-5 top-5 rounded-full bg-white/10 p-2 text-white hover:bg-white/20" onClick={() => setLightbox(null)}>
            <X className="h-5 w-5" />
          </button>
          <img src={lightbox} alt="Job photo" className="max-h-[85vh] max-w-[90vw] rounded-lg object-contain" />
        </div>
      )}

      <WorkOrderModal
        open={editOpen}
        editBooking={editQ.data?.booking}
        onClose={() => setEditOpen(false)}
      />
    </PageWrap>
  );
}
