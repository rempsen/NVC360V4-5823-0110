import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { AddressAutocomplete } from "../components/address-autocomplete";
import WorkOrderForm from "./work-order-form";

/**
 * Standalone, embeddable customer intake form. Renders at /f/:companyId/:slug
 * and is meant to be shared directly or dropped into an <iframe> on the tenant's
 * own website. It authenticates submissions with a publishable key passed in the
 * URL (?k=nvcpub_...). No app session required.
 *
 * Fields & sections are fully tenant-defined. Core keys (name/email/phone/
 * address/serviceType/preferredAt/notes/photo) map to pipeline fields; any other
 * field is a custom field whose answer is sent through with the lead.
 */

type FieldCfg = {
  id: string;
  key: string;
  type: string;
  label: string;
  placeholder?: string;
  options?: string[];
  enabled: boolean;
  required: boolean;
  sectionId?: string;
  width?: "full" | "half";
};
type SectionCfg = { id: string; title: string; description?: string };
type FormCfg = {
  title: string;
  intro: string;
  fields: FieldCfg[];
  sections: SectionCfg[];
  brandColor: string;
  logoUrl: string;
  successMessage: string;
  companyName: string;
  hasPublicKey: boolean;
  formType?: string;
  allowTechAssign?: boolean;
  workerNoun?: string;
};
type Service = { id: string; name: string; category: string };

const CORE_KEYS = new Set(["name", "email", "phone", "address", "serviceType", "preferredAt", "notes", "photo"]);

// Fallback types for core keys — defensive against legacy rows saved without type
const CORE_KEY_TYPES: Record<string, string> = {
  name: "text", email: "email", phone: "phone", address: "address",
  serviceType: "select", preferredAt: "date", notes: "textarea", photo: "file",
};

export default function IntakeForm() {
  const [, params] = useRoute("/f/:companyId/:slug");
  const companyId = params?.companyId ?? "";
  const slug = params?.slug ?? "";
  const publicKey = new URLSearchParams(window.location.search).get("k") || "";

  const [cfg, setCfg] = useState<FormCfg | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [loadErr, setLoadErr] = useState("");
  // A property-hub "Request service" link arrives with ?address= prefilled so
  // the homeowner never retypes an address we already know.
  const [v, setV] = useState<Record<string, string>>(() => {
    const a = new URLSearchParams(window.location.search).get("address");
    const init: Record<string, string> = {};
    if (a) init.address = a;
    return init;
  });
  const [addrCoords, setAddrCoords] = useState<{ lat: number | null; lng: number | null }>({ lat: null, lng: null });
  const [photo, setPhoto] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [logoErr, setLogoErr] = useState(false);

  useEffect(() => {
    if (!companyId || !slug) return;
    fetch(`/api/public/forms/${encodeURIComponent(companyId)}/${encodeURIComponent(slug)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.message || "Form not found");
        return r.json();
      })
      .then((d) => { setCfg(d.form); setServices(d.services || []); })
      .catch((e) => setLoadErr(e.message || "Form not found"));
  }, [companyId, slug]);

  const brand = cfg?.brandColor || "#06b6d4";
  const set = (k: string, val: string) => setV((p) => ({ ...p, [k]: val }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    if (!publicKey) { setErr("This form link is missing its access key. Contact the company that sent it."); return; }
    setSubmitting(true);
    try {
      const fd = new FormData();
      // core mappings
      ["name", "email", "phone", "address", "notes", "preferredAt"].forEach((k) => {
        if (v[k]) fd.append(k, v[k]);
      });
      if (v.serviceId) fd.append("serviceId", v.serviceId);
      if (photo) fd.append("photo", photo);
      if (addrCoords.lat != null) fd.append("lat", String(addrCoords.lat));
      if (addrCoords.lng != null) fd.append("lng", String(addrCoords.lng));
      // every custom field answer
      (cfg?.fields || []).forEach((f) => {
        if (!f.enabled || CORE_KEYS.has(f.key)) return;
        if (v[f.key] != null && v[f.key] !== "") fd.append(f.key, v[f.key]);
      });
      const r = await fetch(`/api/public/forms/${encodeURIComponent(companyId)}/${encodeURIComponent(slug)}/submit`, {
        method: "POST",
        headers: { "X-Public-Key": publicKey },
        body: fd,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.message || "Submission failed");
      setDone(d.message || cfg?.successMessage || "Thanks! We've received your request.");
    } catch (e: any) {
      setErr(e.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loadErr) {
    return (
      <div className="min-h-screen grid place-items-center bg-slate-50 p-6 text-center">
        <div className="max-w-sm">
          <div className="text-2xl font-bold text-slate-800">Form unavailable</div>
          <p className="mt-2 text-sm text-slate-500">{loadErr}</p>
        </div>
      </div>
    );
  }
  if (!cfg) {
    return <div className="min-h-screen grid place-items-center bg-slate-50 text-slate-400 text-sm">Loading…</div>;
  }

  // internal employee work-order creation form — entirely different flow
  // (PIN-gated, client search/create, catalog line items, no public key needed)
  if (cfg.formType === "work_order") {
    return <WorkOrderForm companyId={companyId} slug={slug} cfg={cfg as any} services={services} />;
  }

  if (done) {
    return (
      <div className="min-h-screen grid place-items-center bg-slate-50 p-6">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-200">
          <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full" style={{ background: `${brand}1a` }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={brand} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
          </div>
          <h1 className="text-xl font-bold text-slate-800">Request received</h1>
          <p className="mt-2 text-sm text-slate-500">{done}</p>
        </div>
      </div>
    );
  }

  const inputCls = "w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-800 outline-none transition focus:border-slate-400 focus:ring-2";

  // ---- field renderer (one field) ----
  const renderField = (f: FieldCfg) => {
    if (!f.enabled) return null;
    const req = f.required;
    // Defensive: resolve missing type from core key map or default to "text"
    const fType = f.type || CORE_KEY_TYPES[f.key] || "text";
    f = { ...f, type: fType };

    // serviceType maps to the live services dropdown
    if (f.key === "serviceType") {
      if (!services.length) return null;
      return (
        <Field key={f.id} label={f.label} required={req}>
          <select className={inputCls} style={ring(brand)} value={v.serviceId || ""} onChange={(e) => set("serviceId", e.target.value)} required={req}>
            <option value="">Select…</option>
            {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
      );
    }
    if (f.key === "address" || f.type === "address") {
      return (
        <Field key={f.id} label={f.label} required={req}>
          <AddressAutocomplete
            source="public"
            theme="light"
            value={v[f.key] || ""}
            inputClassName={inputCls}
            inputStyle={ring(brand)}
            onResolve={({ address, lat, lng }) => {
              set(f.key, address);
              setAddrCoords({ lat, lng });
            }}
          />
        </Field>
      );
    }
    if (f.key === "photo" || f.type === "file") {
      return (
        <Field key={f.id} label={f.label} required={req}>
          <input aria-label={f.label} type="file" accept="image/*" required={req}
            className="block w-full text-sm text-slate-500 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-slate-700"
            onChange={(e) => setPhoto(e.target.files?.[0] || null)} />
        </Field>
      );
    }
    if (f.type === "textarea") {
      return (
        <Field key={f.id} label={f.label} required={req}>
          <textarea aria-label={f.label} rows={4} className={inputCls} style={ring(brand)} placeholder={f.placeholder}
            value={v[f.key] || ""} onChange={(e) => set(f.key, e.target.value)} required={req} />
        </Field>
      );
    }
    if (f.type === "select") {
      return (
        <Field key={f.id} label={f.label} required={req}>
          <select className={inputCls} style={ring(brand)} value={v[f.key] || ""} onChange={(e) => set(f.key, e.target.value)} required={req}>
            <option value="">Select…</option>
            {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </Field>
      );
    }
    if (f.type === "radio") {
      return (
        <Field key={f.id} label={f.label} required={req}>
          <div className="space-y-1.5">
            {(f.options || []).map((o) => (
              <label key={o} className="flex items-center gap-2 text-sm text-slate-700">
                <input type="radio" aria-label={String(o)} name={f.key} value={o} checked={v[f.key] === o} onChange={() => set(f.key, o)} required={req} style={{ accentColor: brand }} />
                {o}
              </label>
            ))}
          </div>
        </Field>
      );
    }
    if (f.type === "checkbox") {
      const sel = (v[f.key] || "").split("|").filter(Boolean);
      const toggle = (o: string) => {
        const next = sel.includes(o) ? sel.filter((x) => x !== o) : [...sel, o];
        set(f.key, next.join("|"));
      };
      return (
        <Field key={f.id} label={f.label} required={req}>
          <div className="space-y-1.5">
            {(f.options || []).map((o) => (
              <label key={o} className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" aria-label={String(o)} checked={sel.includes(o)} onChange={() => toggle(o)} style={{ accentColor: brand }} />
                {o}
              </label>
            ))}
          </div>
        </Field>
      );
    }
    // text-like: text, email, phone, number, date, preferredAt
    const typeMap: Record<string, string> = {
      email: "email", phone: "tel", number: "number", date: "date", preferredAt: "date",
    };
    const htmlType = f.key === "preferredAt" ? "date" : (typeMap[f.type] || typeMap[f.key] || "text");
    const stateKey = f.key;
    return (
      <Field key={f.id} label={f.label} required={req}>
        <input aria-label={f.label} type={htmlType} className={inputCls} style={ring(brand)} placeholder={f.placeholder}
          value={v[stateKey] || ""} onChange={(e) => set(stateKey, e.target.value)} required={req} />
      </Field>
    );
  };

  // ---- group fields by section, preserving order; unsectioned first ----
  const enabled = cfg.fields.filter((f) => f.enabled);
  const sectionsOrder: Array<{ id: string; title: string; description?: string }> = [
    { id: "", title: "", description: "" },
    ...cfg.sections,
  ];

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-lg">
        {/* header */}
        <div className="mb-6 text-center">
          {cfg.logoUrl && !logoErr
            ? <img src={cfg.logoUrl} alt="" className="mx-auto mb-3 max-h-12" onError={() => setLogoErr(true)} />
            : <div className="mx-auto mb-2 text-lg font-extrabold tracking-tight" style={{ color: brand }}>{cfg.companyName}</div>}
          <h1 className="text-2xl font-bold text-slate-800">{cfg.title}</h1>
          {cfg.intro && <p className="mt-2 text-sm text-slate-500">{cfg.intro}</p>}
        </div>

        <form onSubmit={submit} className="space-y-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          {sectionsOrder.map((sec) => {
            const inSec = enabled.filter((f) => (f.sectionId || "") === sec.id);
            if (!inSec.length) return null;
            return (
              <div key={sec.id || "_default"} className="space-y-4">
                {sec.title && (
                  <div className="border-b border-slate-100 pb-2">
                    <h2 className="text-sm font-bold text-slate-800">{sec.title}</h2>
                    {sec.description && <p className="mt-0.5 text-xs text-slate-500">{sec.description}</p>}
                  </div>
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  {inSec.map((f) => (
                    <div key={f.id} className={f.width === "half" ? "sm:col-span-1" : "sm:col-span-2"}>
                      {renderField(f)}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-600">{err}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg px-4 py-3 text-sm font-bold text-white transition disabled:opacity-60"
            style={{ background: brand }}
          >
            {submitting ? "Sending…" : "Submit request"}
          </button>
          <p className="text-center text-[11px] text-slate-400">Powered by {cfg.companyName}</p>
        </form>
      </div>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-slate-600">{label}{required && <span className="text-red-500"> *</span>}</span>
      {children}
    </label>
  );
}

function ring(brand: string): React.CSSProperties {
  return { ["--tw-ring-color" as any]: `${brand}55` };
}
