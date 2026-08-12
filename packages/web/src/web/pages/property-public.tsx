/**
 * PUBLIC property hub — /p/:token
 *
 * The homeowner-facing "CarFax for your building". No login, no password: one
 * persistent link that outlives any individual job and shows every completed
 * visit at this address — what was done, when, by whom, the photos taken and
 * the materials used.
 *
 * Deliberately never shows pricing. It is a permanent, shareable URL, so it
 * carries only the record of work, never money.
 */
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRoute } from "wouter";
import { Logo } from "../components/brand";
import { UserFacingError } from "../lib/api-error";
import {
  ShieldCheck,
  MapPin,
  CalendarCheck,
  Camera,
  Package,
  Wrench,
  ExternalLink,
  X,
  Building2,
  Mail,
  Phone,
  History,
  Plus,
} from "lucide-react";

function fmtDate(v: string | number | null | undefined) {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    // The backdrop is a click-to-dismiss surface, not a control: role="presentation"
    // keeps it out of the accessibility tree so screen-reader and keyboard users get
    // the real Close button (and the Escape handler above) instead of a phantom widget.
    <div
      role="presentation"
      onClick={onClose}
      className="fixed inset-0 z-[1000] grid place-items-center bg-black/85 p-4 backdrop-blur-sm"
    >
      <button
        onClick={onClose}
        aria-label="Close photo"
        className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20"
      >
        <X className="h-5 w-5" />
      </button>
      <div role="presentation" onClick={(e) => e.stopPropagation()} className="max-h-[85vh] max-w-full">
        <img
          src={url}
          alt="Attached to this job"
          className="max-h-[85vh] max-w-full rounded-xl object-contain"
        />
      </div>
    </div>
  );
}

export default function PropertyPublic() {
  const [, params] = useRoute("/p/:token");
  const token = params?.token ?? "";
  const [lightbox, setLightbox] = useState<string | null>(null);

  const hub = useQuery({
    queryKey: ["property", token],
    queryFn: async () => {
      const res = await fetch(`/api/property/${token}`);
      // A shared property-hub link that has been revoked is an expected 404 and
      // the page renders its own explanation — keep the status, stay silent.
      if (!res.ok) throw new UserFacingError("not found", { status: res.status });
      return res.json();
    },
    enabled: !!token,
    retry: false,
    meta: { silentError: true },
  });

  const intake = useQuery({
    queryKey: ["property-intake", token],
    queryFn: async () => {
      const res = await fetch(`/api/property/${token}/intake`);
      if (!res.ok) throw new UserFacingError("not found", { status: res.status });
      return res.json();
    },
    enabled: !!token,
    retry: false,
    meta: { silentError: true },
  });

  if (hub.isLoading)
    return (
      <div className="grid min-h-screen place-items-center bg-ink text-slate-400">
        Loading…
      </div>
    );

  const data = hub.data as any;
  if (hub.isError || !data || data.message === "Not found")
    return (
      <div className="grid min-h-screen place-items-center bg-ink px-6 text-center">
        <div>
          <Logo light className="mb-4 justify-center" />
          <p className="text-slate-400">This property link is invalid.</p>
        </div>
      </div>
    );

  const company = data.company as {
    name?: string;
    email?: string;
    phone?: string;
  } | null;
  const workerNoun: string = data.workerNoun || "Technician";
  const jobNoun: string = data.jobNoun || "Job";
  const history: any[] = data.history ?? [];
  const intakeData = intake.data as any;
  const requestUrl =
    intakeData?.slug && intakeData?.companyId
      ? `/f/${intakeData.companyId}/${intakeData.slug}?address=${encodeURIComponent(
          data.property.address,
        )}`
      : null;

  return (
    <div className="nvc-grid-bg min-h-screen bg-ink text-slate-200">
      <header className="border-b border-white/5 bg-ink-2/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
          <Logo light />
          <span className="flex items-center gap-1.5 text-xs text-slate-500">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-live" /> Private
            service record
          </span>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-4 py-6">
        {/* ── Address hero ── */}
        <div className="nvc-card p-5">
          <div className="flex items-start gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-cyan-glow/15 text-cyan-glow">
              <Building2 className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Service history
              </p>
              <h1 className="font-display text-lg font-bold leading-tight text-white">
                {data.property.address}
              </h1>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-white/10 bg-ink-3/50 p-3 text-center">
              <p className="font-display text-xl font-bold text-white">
                {data.stats.totalJobs}
              </p>
              <p className="text-[11px] text-slate-500">
                {data.stats.totalJobs === 1 ? jobNoun : `${jobNoun}s`} completed
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-ink-3/50 p-3 text-center">
              <p className="text-sm font-bold text-white">
                {fmtDate(data.stats.lastServiceAt)}
              </p>
              <p className="text-[11px] text-slate-500">Last service</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-ink-3/50 p-3 text-center">
              <p className="text-sm font-bold text-white">
                {fmtDate(data.stats.firstServiceAt)}
              </p>
              <p className="text-[11px] text-slate-500">Customer since</p>
            </div>
          </div>

          {requestUrl && (
            <a
              href={requestUrl}
              className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-brand py-3 text-sm font-semibold text-white hover:bg-brand-deep"
            >
              <Plus className="h-4 w-4" /> Request service at this address
            </a>
          )}
        </div>

        {/* ── History ── */}
        <div className="mt-6 mb-3 flex items-center gap-2">
          <History className="h-4 w-4 text-cyan-glow" />
          <h2 className="font-bold text-white">Completed work</h2>
        </div>

        {history.length === 0 ? (
          <div className="nvc-card p-8 text-center">
            <p className="text-sm text-slate-400">
              No completed work recorded at this address yet.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {history.map((j) => (
              <div key={j.id} className="nvc-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-display font-bold text-white">
                      {j.title}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                      <span className="flex items-center gap-1">
                        <CalendarCheck className="h-3 w-3" />
                        {fmtDate(j.completedAt)}
                      </span>
                      {j.techName && (
                        <span className="flex items-center gap-1">
                          <Wrench className="h-3 w-3" />
                          {workerNoun}: {j.techName}
                        </span>
                      )}
                      {j.onSiteMinutes > 0 && (
                        <span>
                          {j.onSiteMinutes >= 60
                            ? `${Math.floor(j.onSiteMinutes / 60)}h ${Math.round(
                                j.onSiteMinutes % 60,
                              )}m on site`
                            : `${Math.round(j.onSiteMinutes)} min on site`}
                        </span>
                      )}
                    </p>
                  </div>
                  <a
                    href={j.recordUrl}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-ink-3 px-2.5 py-1.5 text-xs font-semibold text-slate-300 hover:border-cyan-glow/40 hover:text-white"
                  >
                    Full record <ExternalLink className="h-3 w-3" />
                  </a>
                </div>

                {j.materials?.length > 0 && (
                  <div className="mt-3 rounded-xl border border-white/5 bg-ink-3/40 p-3">
                    <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      <Package className="h-3 w-3" /> Materials &amp; work
                    </p>
                    <ul className="divide-y divide-white/5">
                      {j.materials.map((m: any, i: number) => (
                        <li
                          key={i}
                          className="flex items-center justify-between gap-3 py-1.5"
                        >
                          <span className="text-sm text-slate-200">{m.name}</span>
                          <span className="shrink-0 text-xs font-semibold text-slate-400">
                            {m.qty}
                            {m.unit ? ` ${m.unit}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {j.photos?.length > 0 && (
                  <div className="mt-3">
                    <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      <Camera className="h-3 w-3" /> Photos ({j.photos.length})
                    </p>
                    <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                      {j.photos.map((p: any) => (
                        <button
                          key={p.id}
                          onClick={() => setLightbox(p.url)}
                          className="group overflow-hidden rounded-lg border border-white/10 transition hover:border-cyan-glow/50"
                        >
                          <img
                            src={p.url}
                            alt={p.caption || "Job photo"}
                            className="aspect-square w-full object-cover transition group-hover:scale-105"
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ── Company footer ── */}
        {company?.name && (
          <div className="nvc-card mt-6 p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">
              Serviced by
            </p>
            <p className="mt-1 font-bold text-white">{company.name}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {company.phone && (
                <a
                  href={`tel:${company.phone}`}
                  className="flex items-center gap-2 rounded-xl border border-white/10 bg-ink-3 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-ink-3/80"
                >
                  <Phone className="h-4 w-4" /> {company.phone}
                </a>
              )}
              {company.email && (
                <a
                  href={`mailto:${company.email}`}
                  className="flex items-center gap-2 rounded-xl border border-white/10 bg-ink-3 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-ink-3/80"
                >
                  <Mail className="h-4 w-4" /> {company.email}
                </a>
              )}
            </div>
          </div>
        )}

        <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-[11px] text-slate-600">
          <MapPin className="h-3 w-3" /> Permanent link — bookmark it to keep
          your full service history.
        </p>
      </div>

      {lightbox && <Lightbox url={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}
