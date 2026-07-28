import { useEffect, useMemo, useRef, useState } from "react";
import { AddressAutocomplete } from "../components/address-autocomplete";
import {
  buildLineItem, buildUnitLineItem, sumLineItems, normalizeCatalogItem,
  type CatalogItem, type LineItem,
} from "../../shared/catalog";
import { lookupTax, regionFromAddress } from "../../shared/tax";
import { ChargesEditor, chargesSummary, type Charge } from "../components/charges-editor";
import { CatalogLineItems } from "../components/catalog-line-items";
import { UnitLineItems } from "../components/unit-line-items";
import { money } from "../lib/utils";

/**
 * Public, PIN-gated employee work-order creation form. Renders at
 * /f/:companyId/:slug when the form's formType === "work_order" (same route
 * intake-form.tsx uses for lead forms — branching happens one level up).
 *
 * Mirrors the office's work-order-modal.tsx optionality (client, service,
 * priority, optional schedule/technician, dynamic catalog line items) but as
 * a standalone unauthenticated flow: a shared PIN gates it instead of a login.
 */

type FieldCfg = {
  id: string; key: string; type: string; label: string; placeholder?: string;
  options?: string[]; enabled: boolean; required: boolean; sectionId?: string; width?: "full" | "half";
};
type SectionCfg = { id: string; title: string; description?: string };
type FormCfg = {
  title: string; intro: string; fields: FieldCfg[]; sections: SectionCfg[];
  brandColor: string; logoUrl: string; successMessage: string; companyName: string;
  hasPublicKey: boolean; formType: string; allowTechAssign: boolean; workerNoun?: string;
};
type Service = { id: string; name: string; category: string };
type Client = { id: string; name: string; email: string; phone: string; address: string };
type Rider = { id: string; name: string; skillClass: string; status: string };

const inputCls = "w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-800 outline-none transition focus:border-slate-400 focus:ring-2";
function ring(brand: string): React.CSSProperties {
  return { ["--tw-ring-color" as any]: `${brand}55` };
}
function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-slate-600">{label}{required && <span className="text-red-500"> *</span>}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}

export default function WorkOrderForm({ companyId, slug, cfg, services }: { companyId: string; slug: string; cfg: FormCfg; services: Service[] }) {
  const brand = cfg.brandColor || "#06b6d4";
  const publicKey = new URLSearchParams(window.location.search).get("k") || "";

  // ---- access code gate ----
  const storageKey = `wo_code_${companyId}_${slug}`;
  const [unlocked, setUnlocked] = useState(false);
  const [code, setCode] = useState("");
  const [codeErr, setCodeErr] = useState("");
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const saved = sessionStorage.getItem(storageKey);
    if (saved) {
      setCode(saved);
      verifyCode(saved, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function verifyCode(c: string, silent = false) {
    if (!c.trim()) { if (!silent) setCodeErr("Enter the access code"); return; }
    setChecking(true);
    setCodeErr("");
    try {
      const r = await fetch(`/api/public/forms/${encodeURIComponent(companyId)}/${encodeURIComponent(slug)}/verify-code`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: c }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        setUnlocked(true);
        sessionStorage.setItem(storageKey, c);
      } else if (!silent) {
        setCodeErr("Incorrect access code");
      }
    } catch {
      if (!silent) setCodeErr("Couldn't verify — try again");
    } finally {
      setChecking(false);
    }
  }

  if (!unlocked) {
    return (
      <div className="min-h-screen bg-slate-50 px-4 py-12 grid place-items-center">
        <div className="w-full max-w-sm rounded-2xl bg-white p-7 shadow-sm ring-1 ring-slate-200">
          <div className="mb-5 text-center">
            {cfg.logoUrl ? <img src={cfg.logoUrl} alt="" className="mx-auto mb-3 max-h-12" /> : (
              <div className="mx-auto mb-2 text-lg font-extrabold tracking-tight" style={{ color: brand }}>{cfg.companyName}</div>
            )}
            <h1 className="text-xl font-bold text-slate-800">{cfg.title}</h1>
            <p className="mt-1 text-sm text-slate-500">Enter the employee access code to create a work order.</p>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); verifyCode(code); }} className="space-y-3">
            <input aria-label="Access code" autoFocus inputMode="numeric" className={`${inputCls} text-center text-lg tracking-[0.3em] font-mono`} style={ring(brand)}
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))} placeholder="••••••" />
            {codeErr && <p className="text-center text-sm font-medium text-red-600">{codeErr}</p>}
            <button type="submit" disabled={checking} className="w-full rounded-lg px-4 py-3 text-sm font-bold text-white transition disabled:opacity-60" style={{ background: brand }}>
              {checking ? "Checking…" : "Continue"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return <WorkOrderBuilder companyId={companyId} slug={slug} cfg={cfg} services={services} brand={brand} publicKey={publicKey} />;
}

function WorkOrderBuilder({ companyId, slug, cfg, services, brand, publicKey }: {
  companyId: string; slug: string; cfg: FormCfg; services: Service[]; brand: string; publicKey: string;
}) {
  const accessCode = sessionStorage.getItem(`wo_code_${companyId}_${slug}`) || "";
  const hdrs = (): Record<string, string> => ({ "X-Access-Code": accessCode });

  // ---- client ----
  const [clientMode, setClientMode] = useState<"search" | "new">("search");
  const [clientQ, setClientQ] = useState("");
  const [clientResults, setClientResults] = useState<Client[]>([]);
  const [client, setClient] = useState<Client | null>(null);
  const [newClient, setNewClient] = useState({ name: "", email: "", phone: "", address: "" });
  const [addrCoords, setAddrCoords] = useState<{ lat: number | null; lng: number | null }>({ lat: null, lng: null });
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (clientMode !== "search" || clientQ.trim().length < 2) { setClientResults([]); return; }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/public/forms/${companyId}/${slug}/clients?q=${encodeURIComponent(clientQ)}`, { headers: hdrs() });
        const d = await r.json().catch(() => ({}));
        setClientResults(d.clients || []);
      } catch { /* noop */ }
    }, 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientQ, clientMode]);

  // ---- job basics ----
  const [serviceId, setServiceId] = useState(services[0]?.id || "");
  const [priority, setPriority] = useState<"low" | "normal" | "high" | "urgent">("normal");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [riderId, setRiderId] = useState("");
  const [riders, setRiders] = useState<Rider[]>([]);
  const [submittedBy, setSubmittedBy] = useState("");
  // tax region — auto-resolved from whichever address is entered (job address
  // takes priority; falls back to the new-client address), same behavior as
  // the admin work-order modal.
  const [region, setRegion] = useState("");
  const [regionTouched, setRegionTouched] = useState(false);

  useEffect(() => {
    if (!cfg.allowTechAssign) return;
    fetch(`/api/public/forms/${companyId}/${slug}/riders`, { headers: hdrs() })
      .then((r) => r.json()).then((d) => setRiders(d.riders || [])).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // auto-resolve tax region from whichever address is available, unless the
  // employee already picked one manually.
  useEffect(() => {
    if (regionTouched) return;
    const src = address || (clientMode === "new" ? newClient.address : client?.address) || "";
    if (!src) return;
    const r = regionFromAddress(src);
    if (r) setRegion(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, newClient.address, client]);

  // ---- catalog / line items ----
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  useEffect(() => {
    fetch(`/api/public/forms/${companyId}/${slug}/catalog`, { headers: hdrs() })
      .then((r) => r.json())
      .then((d) => setCatalog((d.items || []).map(normalizeCatalogItem)))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const byId = useMemo(() => new Map(catalog.map((i) => [i.id, i])), [catalog]);
  const lookup = (id: string) => byId.get(id);
  // Single lineItems array holds BOTH catalog lines (kind: service/product/
  // assembly) and ad-hoc per-unit lines (kind: "unit") — identical shape and
  // handler logic to the admin work-order modal, so a job priced here bills
  // exactly the same as one priced in the office.
  const [lineItems, setLineItems] = useState<LineItem[]>([]);

  function addCatalogItem(item: CatalogItem, qty: number) {
    const li = buildLineItem(item, qty, lookup);
    setLineItems((prev) => {
      const idx = prev.findIndex((p) => p.itemId === li.itemId);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = buildLineItem(item, (prev[idx].qty || 0) + qty, lookup);
        return next;
      }
      return [...prev, li];
    });
  }
  function setLineQty(itemId: string, qty: number) {
    setLineItems((prev) =>
      prev.map((p) => {
        if (p.itemId !== itemId) return p;
        const item = lookup(itemId);
        if (item) return buildLineItem(item, qty, lookup);
        return { ...p, qty, cost: Math.round(p.unitCost * qty * 100) / 100, price: Math.round(p.unitPrice * qty * 100) / 100 };
      }),
    );
  }
  function removeLine(itemId: string) {
    setLineItems((prev) => prev.filter((p) => p.itemId !== itemId));
  }
  function addUnitLine() {
    const li = buildUnitLineItem({ name: "", unit: "sq/ft", qty: 0, unitPrice: 0, unitPayRate: 0 });
    setLineItems((prev) => [...prev, li]);
  }
  function changeUnitLine(itemId: string, patch: Partial<{ name: string; unit: string; qty: number; unitPrice: number; unitPayRate: number; taxable: boolean }>) {
    setLineItems((prev) =>
      prev.map((l) => {
        if (l.itemId !== itemId) return l;
        const next = { ...l };
        if (patch.name !== undefined) next.name = patch.name;
        if (patch.unit !== undefined) next.unit = patch.unit;
        if (patch.qty !== undefined) { next.qty = patch.qty; next.price = Math.round((next.unitPrice || 0) * patch.qty * 100) / 100; next.cost = Math.round((next.unitCost || 0) * patch.qty * 100) / 100; }
        if (patch.unitPrice !== undefined) { next.unitPrice = patch.unitPrice; next.price = Math.round(patch.unitPrice * (next.qty || 0) * 100) / 100; }
        if (patch.unitPayRate !== undefined) { next.unitCost = patch.unitPayRate; next.cost = Math.round(patch.unitPayRate * (next.qty || 0) * 100) / 100; }
        if (patch.taxable !== undefined) next.taxable = patch.taxable;
        return next;
      }),
    );
  }
  function removeUnitLine(itemId: string) {
    setLineItems((prev) => prev.filter((p) => p.itemId !== itemId));
  }

  // ---- charges: flat fee / hourly / per-unit — same builder + math as the
  // admin work-order modal, so a job priced from this form and one priced in
  // the office come out billing-identical. ----
  const [charges, setCharges] = useState<Charge[]>([]);
  const pricePreview = useMemo(() => {
    const { techTotal: chargesTechTotal } = chargesSummary(charges);
    // only flat_fee and per_unit have a known amount up front; hourly is
    // billed once the job's actual time is recorded.
    const chargesKnown = charges.reduce((s, c) => {
      if (c.type === "flat_fee") return s + c.amount;
      if (c.type === "per_unit") return s + c.qty * c.unitPrice;
      return s;
    }, 0);

    // catalog line items (from service catalog) — per-unit ("unit" kind)
    // lines are excluded from this subtotal/tax/total, exactly like the
    // admin work-order modal's quote calc (they show their own running
    // total inside the UnitLineItems widget itself).
    const catalogLines = lineItems.filter((l) => l.kind !== "unit");
    const cat = sumLineItems(catalogLines);
    const subtotal = Math.round((chargesKnown + cat.price) * 100) / 100;
    const tax = lookupTax(region);
    const taxRate = tax?.rate ?? 0;
    const taxableBase = chargesKnown + cat.taxablePrice;
    const taxAmount = Math.round((taxableBase * taxRate)) / 100;
    const total = Math.round((subtotal + taxAmount) * 100) / 100;

    return {
      subtotal, chargesKnown, chargesTechTotal,
      lineItemsPrice: cat.price,
      taxLabel: tax?.label ?? "No tax region",
      taxAmount, total,
      hasHourly: charges.some((c) => c.type === "hourly"),
    };
  }, [charges, region, lineItems]);

  // ---- extra custom fields configured on the form ----
  const [customVals, setCustomVals] = useState<Record<string, string>>({});
  const customFields = (cfg.fields || []).filter((f) => f.enabled);

  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [doneToken, setDoneToken] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const canSubmit = !!serviceId && (client || (clientMode === "new" && newClient.name.trim()));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    if (!serviceId) { setErr("Pick a service."); return; }
    if (!client && !(clientMode === "new" && newClient.name.trim())) { setErr("Pick a client or add a new one."); return; }
    setSubmitting(true);
    try {
      // convert ChargesEditor charges into LineItem records + a rate model,
      // exactly like the admin work-order modal's buildPayload() does, so a
      // job priced here bills identically to one priced in the office.
      const chargeLineItems: LineItem[] = charges.map((c) => {
        if (c.type === "per_unit") {
          return buildUnitLineItem({
            name: c.name || "Line item", unit: c.unit || "each", qty: c.qty,
            unitPrice: c.unitPrice, unitPayRate: c.unitPayRate, taxable: true,
          });
        }
        return buildUnitLineItem({
          name: c.type === "flat_fee" ? (c.label || "Flat fee") : (c.label || "Hourly charge"),
          unit: "job", qty: 1,
          unitPrice: c.type === "flat_fee" ? c.amount : 0,
          unitPayRate: c.type === "flat_fee" ? c.techPay : 0,
          taxable: true,
        });
      });
      const hourlyCharge = charges.find((c) => c.type === "hourly");
      const rateModel = hourlyCharge ? {
        flatRate: 0, includedMinutes: 0, includedKm: 0, timeRate: 0, timeUnit: "hour" as const,
        kmRate: 0, minCharge: 0,
        freeMinutes: hourlyCharge.freeMinutes,
        firstHourRate: hourlyCharge.firstHourRate,
        additionalHourRate: hourlyCharge.additionalHourRate,
      } : undefined;

      const body: Record<string, any> = {
        serviceId, priority, notes, staffNotes: "",
        address: address || client?.address || newClient.address || "",
        submittedBy,
        region: region || undefined,
        lineItems: [...lineItems, ...chargeLineItems],
        ...(rateModel ? { rateModel } : {}),
      };
      if (client) body.customerId = client.id;
      else {
        body.clientName = newClient.name;
        body.clientEmail = newClient.email;
        body.clientPhone = newClient.phone;
        body.clientAddress = newClient.address;
      }
      if (addrCoords.lat != null) body.lat = addrCoords.lat;
      if (addrCoords.lng != null) body.lng = addrCoords.lng;
      if (scheduledAt) body.scheduledAt = new Date(scheduledAt).toISOString();
      if (cfg.allowTechAssign && riderId) body.riderId = riderId;
      if (Object.keys(customVals).length) body.fieldData = { _custom: customVals };

      const r = await fetch(`/api/public/forms/${companyId}/${slug}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Access-Code": accessCode, ...(publicKey ? { "X-Public-Key": publicKey } : {}) },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.message || "Couldn't create the work order");
      setDone(d.message || cfg.successMessage || "Work order created.");
      setDoneToken(d.publicToken || null);
    } catch (e: any) {
      setErr(e.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="min-h-screen grid place-items-center bg-slate-50 p-6">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-200">
          <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full" style={{ background: `${brand}1a` }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={brand} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
          </div>
          <h1 className="text-xl font-bold text-slate-800">Work order created</h1>
          <p className="mt-2 text-sm text-slate-500">{done}</p>
          {doneToken && (
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/s/${doneToken}`)}
              className="mt-4 w-full rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Copy customer selections link
            </button>
          )}
          <button onClick={() => window.location.reload()} className="mt-3 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Create another</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-6 text-center">
          {cfg.logoUrl ? <img src={cfg.logoUrl} alt="" className="mx-auto mb-3 max-h-12" /> : (
            <div className="mx-auto mb-2 text-lg font-extrabold tracking-tight" style={{ color: brand }}>{cfg.companyName}</div>
          )}
          <h1 className="text-2xl font-bold text-slate-800">{cfg.title}</h1>
          {cfg.intro && <p className="mt-2 text-sm text-slate-500">{cfg.intro}</p>}
        </div>

        <form onSubmit={submit} className="space-y-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          {/* ---- client ---- */}
          <section className="space-y-3">
            <div className="flex items-center gap-2 border-b border-slate-100 pb-2">
              <h2 className="text-sm font-bold text-slate-800">Client</h2>
              <div className="ml-auto flex gap-1 rounded-lg bg-slate-100 p-0.5 text-xs font-semibold">
                <button type="button" onClick={() => { setClientMode("search"); setClient(null); }}
                  className={`rounded-md px-2.5 py-1 ${clientMode === "search" ? "bg-white shadow-sm" : "text-slate-500"}`}>Search existing</button>
                <button type="button" onClick={() => { setClientMode("new"); setClient(null); }}
                  className={`rounded-md px-2.5 py-1 ${clientMode === "new" ? "bg-white shadow-sm" : "text-slate-500"}`}>Add new</button>
              </div>
            </div>

            {clientMode === "search" ? (
              client ? (
                <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
                  <div>
                    <div className="text-sm font-semibold text-slate-800">{client.name}</div>
                    <div className="text-xs text-slate-500">{client.email} {client.phone && `· ${client.phone}`}</div>
                  </div>
                  <button type="button" onClick={() => setClient(null)} className="text-xs font-semibold text-slate-500 hover:text-red-500">Change</button>
                </div>
              ) : (
                <div>
                  <input aria-label="Search clients" className={inputCls} style={ring(brand)} value={clientQ} onChange={(e) => setClientQ(e.target.value)} placeholder="Search by name, email, or phone…" />
                  {clientResults.length > 0 && (
                    <div className="mt-1.5 max-h-44 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-1.5">
                      {clientResults.map((c) => (
                        <button type="button" key={c.id} onClick={() => { setClient(c); setClientResults([]); setClientQ(""); }}
                          className="flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left hover:bg-slate-50">
                          <span className="text-sm font-medium text-slate-800">{c.name}</span>
                          <span className="text-xs text-slate-500">{c.email} {c.phone && `· ${c.phone}`}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Full name" required><input aria-label="Client name" className={inputCls} style={ring(brand)} value={newClient.name} onChange={(e) => setNewClient((v) => ({ ...v, name: e.target.value }))} /></Field>
                <Field label="Phone"><input aria-label="Client phone" className={inputCls} style={ring(brand)} value={newClient.phone} onChange={(e) => setNewClient((v) => ({ ...v, phone: e.target.value }))} /></Field>
                <Field label="Email"><input aria-label="Client email" type="email" className={inputCls} style={ring(brand)} value={newClient.email} onChange={(e) => setNewClient((v) => ({ ...v, email: e.target.value }))} /></Field>
                <Field label="Address">
                  <AddressAutocomplete source="public" theme="light" value={newClient.address} inputClassName={inputCls} inputStyle={ring(brand)}
                    onResolve={({ address: a, lat, lng }) => { setNewClient((v) => ({ ...v, address: a })); setAddrCoords({ lat, lng }); }} />
                </Field>
              </div>
            )}
          </section>

          {/* ---- job basics ---- */}
          <section className="space-y-3">
            <h2 className="border-b border-slate-100 pb-2 text-sm font-bold text-slate-800">Job details</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Service" required>
                <select aria-label="Service" className={inputCls} style={ring(brand)} value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
                  <option value="">Select…</option>
                  {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
              <Field label="Priority">
                <select aria-label="Priority" className={inputCls} style={ring(brand)} value={priority} onChange={(e) => setPriority(e.target.value as any)}>
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </Field>
              <Field label="Job address" hint={clientMode === "new" ? "Leave blank to use the client's address above." : undefined}>
                <AddressAutocomplete source="public" theme="light" value={address} inputClassName={inputCls} inputStyle={ring(brand)}
                  onResolve={({ address: a, lat, lng }) => { setAddress(a); setAddrCoords({ lat, lng }); }} />
              </Field>
              <Field label="Your name" hint="So the office knows who submitted this.">
                <input aria-label="Submitted by" className={inputCls} style={ring(brand)} value={submittedBy} onChange={(e) => setSubmittedBy(e.target.value)} />
              </Field>
            </div>
            <Field label="Notes / describe the work">
              <textarea aria-label="Notes" rows={3} className={inputCls} style={ring(brand)} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>

            {cfg.allowTechAssign && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Schedule (optional)" hint="Leave blank to let dispatch schedule it.">
                  <input aria-label="Scheduled at" type="datetime-local" className={inputCls} style={ring(brand)} value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
                </Field>
                <Field label="Technician (optional)" hint="Leave blank to let dispatch assign.">
                  <select aria-label="Technician" className={inputCls} style={ring(brand)} value={riderId} onChange={(e) => setRiderId(e.target.value)}>
                    <option value="">Unassigned — dispatch will assign</option>
                    {riders.map((r) => <option key={r.id} value={r.id}>{r.name}{r.skillClass ? ` — ${r.skillClass}` : ""}</option>)}
                  </select>
                </Field>
              </div>
            )}
          </section>

          {/* ---- extra custom fields ---- */}
          {customFields.length > 0 && (
            <section className="space-y-3">
              <h2 className="border-b border-slate-100 pb-2 text-sm font-bold text-slate-800">Additional questions</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {customFields.map((f) => (
                  <Field key={f.id} label={f.label} required={f.required}>
                    {f.type === "textarea" ? (
                      <textarea aria-label={f.label} rows={3} className={inputCls} style={ring(brand)} value={customVals[f.key] || ""} onChange={(e) => setCustomVals((v) => ({ ...v, [f.key]: e.target.value }))} required={f.required} />
                    ) : f.type === "select" ? (
                      <select aria-label={f.label} className={inputCls} style={ring(brand)} value={customVals[f.key] || ""} onChange={(e) => setCustomVals((v) => ({ ...v, [f.key]: e.target.value }))} required={f.required}>
                        <option value="">Select…</option>
                        {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : (
                      <input aria-label={f.label} type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"} className={inputCls} style={ring(brand)}
                        value={customVals[f.key] || ""} onChange={(e) => setCustomVals((v) => ({ ...v, [f.key]: e.target.value }))} required={f.required} placeholder={f.placeholder} />
                    )}
                  </Field>
                ))}
              </div>
            </section>
          )}

          {/* ---- catalog line items + per-unit lines ----
              Same shared components + handler logic as the admin work-order
              modal (CatalogLineItems / UnitLineItems), so a job priced here
              bills identically to one priced in the office. Both are built
              for the app's dark theme — render in a dark card rather than
              fighting their styling with overrides, same pattern already
              used below for ChargesEditor. */}
          <section className="space-y-3">
            <h2 className="border-b border-slate-100 pb-2 text-sm font-bold text-slate-800">Line items</h2>
            <div className="rounded-xl bg-[#0b1220] p-3">
              <CatalogLineItems
                items={catalog}
                lineItems={lineItems.filter((l) => l.kind !== "unit")}
                lookup={lookup}
                onAdd={addCatalogItem}
                onQty={setLineQty}
                onRemove={removeLine}
              />
            </div>
            <div className="rounded-xl bg-[#0b1220] p-3">
              <UnitLineItems
                lines={lineItems.filter((l) => l.kind === "unit")}
                workerNoun={cfg.workerNoun || "Technician"}
                onAdd={addUnitLine}
                onChange={changeUnitLine}
                onRemove={removeUnitLine}
              />
            </div>
          </section>

          {/* ---- charges: flat fee / hourly / per-unit ---- */}
          <section className="space-y-3">
            <div>
              <h2 className="border-b border-slate-100 pb-2 text-sm font-bold text-slate-800">Charges</h2>
              <p className="mt-1.5 text-xs text-slate-500">Add a call-out fee, hourly labor, or any per-unit charge — same pricing tools the office uses.</p>
            </div>
            {/* ChargesEditor is built for the app's dark theme — render it in its
                native dark card rather than fighting its styling with overrides. */}
            <div className="rounded-xl bg-[#0b1220] p-3">
              <ChargesEditor charges={charges} onChange={setCharges} />
            </div>
          </section>

          {/* ---- tax region + price preview ---- */}
          <section className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Tax region" hint="Auto-detected from the address; change if needed.">
                <select aria-label="Tax region" className={inputCls} style={ring(brand)} value={region} onChange={(e) => { setRegion(e.target.value); setRegionTouched(true); }}>
                  <option value="">No tax</option>
                  {["AB","BC","MB","NB","NL","NS","NT","NU","ON","PE","QC","SK","YT"].map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </Field>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Price preview</div>
              <div className="space-y-1 text-sm">
                {pricePreview.lineItemsPrice > 0 && (
                  <div className="flex justify-between text-slate-600"><span>Line items</span><span>{money(pricePreview.lineItemsPrice)}</span></div>
                )}
                {pricePreview.chargesKnown > 0 && (
                  <div className="flex justify-between text-slate-600"><span>Charges</span><span>{money(pricePreview.chargesKnown)}</span></div>
                )}
                {pricePreview.hasHourly && (
                  <div className="flex justify-between text-slate-400 italic"><span>Hourly charge</span><span>billed at job time</span></div>
                )}
                <div className="flex justify-between text-slate-600"><span>Subtotal</span><span>{money(pricePreview.subtotal)}</span></div>
                <div className="flex justify-between text-slate-500 text-xs"><span>{pricePreview.taxLabel}</span><span>{money(pricePreview.taxAmount)}</span></div>
                <div className="mt-1 flex justify-between border-t border-slate-200 pt-1.5 text-base font-bold text-slate-800">
                  <span>Total</span><span>{money(pricePreview.total)}</span>
                </div>
                {pricePreview.chargesTechTotal > 0 && (
                  <div className="flex justify-between pt-1 text-xs font-medium text-amber-600"><span>Tech pay</span><span>{money(pricePreview.chargesTechTotal)}</span></div>
                )}
              </div>
            </div>
          </section>

          {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-600">{err}</p>}

          <button type="submit" disabled={submitting || !canSubmit} className="w-full rounded-lg px-4 py-3 text-sm font-bold text-white transition disabled:opacity-60" style={{ background: brand }}>
            {submitting ? "Creating…" : "Create work order"}
          </button>
          <p className="text-center text-[11px] text-slate-400">Internal use only · {cfg.companyName}</p>
        </form>
      </div>
    </div>
  );
}
