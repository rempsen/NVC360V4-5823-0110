import { useEffect, useMemo, useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Trash2,
  ChevronDown,
  StickyNote,
  Type,
  CheckSquare,
  DollarSign,
  TrendingUp,
  Paperclip,
  BookOpen,
  Hash,
  GripVertical,
  X,
  Camera,
  FileText,
  Mic,
  ImageIcon,
  Loader2,
  List,
  Calendar,
  Clock,
  Navigation,
  MapPin,
} from "lucide-react";
import { apiHeaders } from "../lib/api";
import { useWorkerNoun, useCustomerNoun } from "../lib/use-brand";
import { api } from "../lib/api";
import { Modal, Field, inputCls, BtnGhost, BtnPrimary, ConfirmModal } from "./modal";
import { PRIORITY_META } from "../lib/utils";
import { ChargesEditor, chargesSummary, type Charge } from "./charges-editor";
import { CatalogLineItems } from "./catalog-line-items";
import { UnitLineItems } from "./unit-line-items";
import {
  EMPTY_RATE_MODEL,
  parseRateModel,
  type RateModel,
} from "../../shared/pricing";
import {
  buildLineItem,
  buildUnitLineItem,
  sumLineItems,
  normalizeCatalogItem,
  type CatalogItem,
  type LineItem,
} from "../../shared/catalog";
import { lookupTax, regionFromAddress } from "../../shared/tax";
import { AddressAutocomplete } from "./address-autocomplete";
import { liveOnSiteMinutes } from "../../shared/clock";

// ─── Custom field types ──────────────────────────────────────────────────────

export type CfType =
  | "notes"
  | "text"
  | "checkbox"
  | "select"
  | "date"
  | "flat_fee"
  | "price_logic"
  | "file"
  | "instructions"
  | "number";

export interface CustomField {
  id: string;
  type: CfType;
  label: string;
  // type-specific config
  placeholder?: string;       // text / notes
  defaultChecked?: boolean;   // checkbox
  options?: string[];         // select: the dropdown's choices
  amount?: number;            // flat_fee
  // price_logic: multiplier per unit
  logicRate?: number;
  logicUnit?: string;         // e.g. "per hour", "per sqft"
  // instructions: markdown-style body
  body?: string;
  required?: boolean;
}

const CF_TYPES: { type: CfType; icon: React.ReactNode; label: string; desc: string }[] = [
  { type: "notes",        icon: <StickyNote className="h-4 w-4" />,    label: "Notes",            desc: "Multi-line text note from dispatcher" },
  { type: "text",         icon: <Type className="h-4 w-4" />,          label: "Text field",       desc: "Single-line text input" },
  { type: "number",       icon: <Hash className="h-4 w-4" />,          label: "Number",           desc: "Numeric entry (qty, measurements, etc.)" },
  { type: "checkbox",     icon: <CheckSquare className="h-4 w-4" />,   label: "Checkbox",         desc: "Yes / No toggle" },
  { type: "select",       icon: <List className="h-4 w-4" />,          label: "Dropdown",         desc: "Pick one from a list of options" },
  { type: "date",         icon: <Calendar className="h-4 w-4" />,      label: "Date",             desc: "Date picker" },
  { type: "flat_fee",     icon: <DollarSign className="h-4 w-4" />,    label: "Flat fee",         desc: "Fixed add-on to the job price" },
  { type: "price_logic",  icon: <TrendingUp className="h-4 w-4" />,    label: "Price logic",      desc: "Rate × quantity (per hour, sqft, unit…)" },
  { type: "file",         icon: <Paperclip className="h-4 w-4" />,     label: "File / Photo",     desc: "Technician can attach a file or photo" },
  { type: "instructions", icon: <BookOpen className="h-4 w-4" />,      label: "Instructions",     desc: "Static text block visible to the technician" },
];

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Convert a Form Builder template's `fields` JSON (text/number/checkbox/
 * select/photo/signature/date) into this modal's CustomField shape, so
 * picking a template actually populates real, editable fields here instead
 * of the template's fields being saved and never used anywhere. Mirrors the
 * server-side templateFieldsToCustomFields() in api/routes/bookings.ts (kept
 * in sync manually — small, stable shape, not worth a shared import across
 * the web/api boundary for this).
 */
function templateFieldsToCustomFields(rawFields: string | null | undefined): CustomField[] {
  let parsed: any[] = [];
  try { parsed = JSON.parse(rawFields || "[]"); } catch { parsed = []; }
  if (!Array.isArray(parsed)) return [];
  const TYPE_MAP: Record<string, CfType> = {
    text: "text", number: "number", checkbox: "checkbox", select: "select",
    date: "date", photo: "file", signature: "file",
  };
  return parsed
    .filter((f) => f && f.type && TYPE_MAP[f.type as string])
    .map((f) => ({
      id: uid(),
      type: TYPE_MAP[f.type as string],
      label: f.label || "",
      required: !!f.required,
      ...(f.type === "select" ? { options: Array.isArray(f.options) ? f.options : [] } : {}),
    }));
}

// ─── Pill for the type picker ────────────────────────────────────────────────
function TypePicker({ onPick }: { onPick: (t: CfType) => void }) {
  const { noun } = useWorkerNoun();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fn = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-lg border border-dashed border-brand/50 bg-brand/5 px-3 py-2 text-sm font-medium text-brand hover:bg-brand/10 transition-colors"
      >
        <Plus className="h-4 w-4" />
        Add field
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-xl border border-white/10 bg-[#0d1b2a] shadow-2xl py-1.5">
          {CF_TYPES.map((t) => (
            <button
              key={t.type}
              type="button"
              onClick={() => { onPick(t.type); setOpen(false); }}
              className="flex w-full items-start gap-3 px-3.5 py-2.5 text-left hover:bg-white/5 transition-colors"
            >
              <span className="mt-0.5 shrink-0 text-brand">{t.icon}</span>
              <span>
                <span className="block text-sm font-semibold text-white">{t.label}</span>
                <span className="block text-xs text-slate-500">{t.desc.replace(/technician/g, noun.toLowerCase())}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Single custom field card ─────────────────────────────────────────────────
function CfCard({
  cf,
  onChange,
  onRemove,
}: {
  cf: CustomField;
  onChange: (updated: CustomField) => void;
  onRemove: () => void;
}) {
  const { noun } = useWorkerNoun();
  const meta = CF_TYPES.find((t) => t.type === cf.type)!;
  const upd = (patch: Partial<CustomField>) => onChange({ ...cf, ...patch });

  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] p-4">
      {/* header row */}
      <div className="flex items-center gap-2 mb-3">
        <GripVertical className="h-4 w-4 shrink-0 text-slate-600 cursor-grab" />
        <span className="shrink-0 text-brand">{meta.icon}</span>
        <span className="text-xs font-bold uppercase tracking-wide text-slate-400">{meta.label}</span>
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none">
          <input
            aria-label="Required"
            type="checkbox"
            checked={!!cf.required}
            onChange={(e) => upd({ required: e.target.checked })}
            className="accent-brand"
          />
          Required
        </label>
        <button
          type="button"
          aria-label="Remove field"
          onClick={onRemove}
          className="ml-1 rounded-md p-1 text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {/* label */}
      {cf.type !== "instructions" && (
        <div className="mb-3">
          <span className="mb-1 block text-xs font-semibold text-slate-400">Field label</span>
          <input aria-label="Field label"
            value={cf.label}
            onChange={(e) => upd({ label: e.target.value })}
            placeholder={`${meta.label} label…`}
            className={inputCls}
          />
        </div>
      )}

      {/* type-specific config */}
      {(cf.type === "text" || cf.type === "notes") && (
        <div>
          <span className="mb-1 block text-xs font-semibold text-slate-400">Placeholder text (optional)</span>
          <input aria-label="Placeholder text (optional)"
            value={cf.placeholder ?? ""}
            onChange={(e) => upd({ placeholder: e.target.value })}
            placeholder="e.g. Describe the issue…"
            className={inputCls}
          />
        </div>
      )}

      {cf.type === "number" && (
        <div>
          <span className="mb-1 block text-xs font-semibold text-slate-400">Placeholder (optional)</span>
          <input aria-label="Placeholder (optional)"
            value={cf.placeholder ?? ""}
            onChange={(e) => upd({ placeholder: e.target.value })}
            placeholder="e.g. Enter quantity"
            className={inputCls}
          />
        </div>
      )}

      {cf.type === "checkbox" && (
        <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer select-none">
          <input
            aria-label="Default checked"
            type="checkbox"
            checked={!!cf.defaultChecked}
            onChange={(e) => upd({ defaultChecked: e.target.checked })}
            className="accent-brand"
          />
          Default to checked
        </label>
      )}

      {cf.type === "select" && (
        <div className="space-y-1.5">
          <span className="mb-1 block text-xs font-semibold text-slate-400">Dropdown options</span>
          {(cf.options ?? []).length === 0 && (
            <p className="text-xs italic text-slate-500">No options yet — add at least one.</p>
          )}
          {(cf.options ?? []).map((opt, idx) => (
            <div key={idx} className="flex items-center gap-1.5">
              <input
                aria-label={`Option ${idx + 1}`}
                value={opt}
                onChange={(e) => {
                  const next = [...(cf.options ?? [])];
                  next[idx] = e.target.value;
                  upd({ options: next });
                }}
                placeholder={`Option ${idx + 1}`}
                className={`${inputCls} flex-1`}
              />
              <button
                type="button"
                aria-label="Remove option"
                onClick={() => upd({ options: (cf.options ?? []).filter((_, j) => j !== idx) })}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-slate-500 hover:bg-red-500/10 hover:text-red-400"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => upd({ options: [...(cf.options ?? []), ""] })}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-semibold text-slate-300 hover:border-brand/40 hover:text-brand"
          >
            <Plus className="h-3 w-3" /> Add option
          </button>
        </div>
      )}

      {cf.type === "date" && (
        <p className="text-xs text-slate-500">Technician picks a date on the job screen. No extra config needed.</p>
      )}

      {cf.type === "flat_fee" && (
        <div>
          <span className="mb-1 block text-xs font-semibold text-slate-400">Add-on amount ($)</span>
          <div className="relative">
            <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
            <input aria-label="Add-on amount ($)"
              type="number"
              min={0}
              step={0.01}
              value={cf.amount ?? ""}
              onChange={(e) => upd({ amount: parseFloat(e.target.value) || 0 })}
              placeholder="0.00"
              className={`${inputCls} pl-7`}
            />
          </div>
          <p className="mt-1.5 text-xs text-slate-500">
            This amount will be added to the job total when enabled.
          </p>
        </div>
      )}

      {cf.type === "price_logic" && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className="mb-1 block text-xs font-semibold text-slate-400">Rate ($ per unit)</span>
            <div className="relative">
              <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
              <input aria-label="Rate ($ per unit)"
                type="number"
                min={0}
                step={0.01}
                value={cf.logicRate ?? ""}
                onChange={(e) => upd({ logicRate: parseFloat(e.target.value) || 0 })}
                placeholder="0.00"
                className={`${inputCls} pl-7`}
              />
            </div>
          </div>
          <div>
            <span className="mb-1 block text-xs font-semibold text-slate-400">Unit label</span>
            <input aria-label="Unit label"
              value={cf.logicUnit ?? ""}
              onChange={(e) => upd({ logicUnit: e.target.value })}
              placeholder="per hour, per sqft…"
              className={inputCls}
            />
          </div>
          <div className="col-span-2 rounded-lg bg-white/5 px-3 py-2 text-xs text-slate-400">
            {noun} enters a quantity → <span className="text-white font-semibold">${(cf.logicRate ?? 0).toFixed(2)} × qty</span> is added to the invoice.
          </div>
        </div>
      )}

      {cf.type === "file" && (
        <p className="text-xs text-slate-500">
          {noun} will see a file/photo attachment button for this field in the job screen.
        </p>
      )}

      {cf.type === "instructions" && (
        <div>
          <span className="mb-1 block text-xs font-semibold text-slate-400">Heading (optional)</span>
          <input aria-label="Heading (optional)"
            value={cf.label}
            onChange={(e) => upd({ label: e.target.value })}
            placeholder="e.g. Safety instructions"
            className={`${inputCls} mb-3`}
          />
          <span className="mb-1 block text-xs font-semibold text-slate-400">Instructions body</span>
          <textarea aria-label={`Write step-by-step instructions or any notes for the ${noun.toLowerCase()}…`}
            value={cf.body ?? ""}
            onChange={(e) => upd({ body: e.target.value })}
            rows={4}
            placeholder={`Write step-by-step instructions or any notes for the ${noun.toLowerCase()}…`}
            className={inputCls}
          />
        </div>
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toLocalInput(d?: Date) {
  const dt = d ?? new Date(Date.now() + 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

// ─── Main modal ───────────────────────────────────────────────────────────────

export function WorkOrderModal({
  open,
  onClose,
  defaultDate,
  defaultRiderId,
  editBooking,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  defaultDate?: Date;
  defaultRiderId?: string;
  editBooking?: any;
  onCreated?: () => void;
}) {
  const isEdit = !!editBooking;
  const qc = useQueryClient();
  const { noun } = useWorkerNoun();
  const { noun: customerNoun } = useCustomerNoun();

  // core fields
  const [customerId, setCustomerId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("normal");
  const [scheduledAt, setScheduledAt] = useState(toLocalInput(defaultDate));
  const [address, setAddress] = useState("");
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);
  const [riderId, setRiderId] = useState(defaultRiderId ?? "");
  const [requiredSkillClass, setRequiredSkillClass] = useState("");
  const [requiredSkills, setRequiredSkills] = useState<string[]>([]);
  const [techFilter, setTechFilter] = useState("");
  const [notes, setNotes] = useState("");
  const [staffNotes, setStaffNotes] = useState("");
  const [err, setErr] = useState("");
  const [region, setRegion] = useState("");
  const [rateModel, setRateModel] = useState<RateModel>({ ...EMPTY_RATE_MODEL });
  const [rateTouched, setRateTouched] = useState(false);
  // unified charges (flat fee / hourly / per-unit — all committed via ChargesEditor)
  const [charges, setCharges] = useState<Charge[]>([]);
  const [estMinutes, setEstMinutes] = useState("60");
  const [estKm, setEstKm] = useState("0");

  // custom fields
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  // Tracks whether the CURRENT custom fields came from a template load (vs.
  // hand-built by the office). Lets the Template dropdown safely refresh
  // fields when switching templates, while still protecting hand-built work
  // (see pendingTemplateSwap below).
  const [fieldsFromTemplate, setFieldsFromTemplate] = useState(false);
  // Holds a template id awaiting user confirmation before it replaces
  // hand-built custom fields (set by the Template <select> onChange).
  const [pendingTemplateSwap, setPendingTemplateSwap] = useState<string | null>(null);

  // catalog line items
  const [lineItems, setLineItems] = useState<LineItem[]>([]);

  const catalog = useQuery({
    queryKey: ["catalog"],
    queryFn: async () => (await api.catalog.$get({ query: {} })).json(),
    enabled: open,
  });
  const catalogItems = useMemo<CatalogItem[]>(
    () => (((catalog.data as any)?.items ?? []) as any[]).map(normalizeCatalogItem),
    [catalog.data],
  );
  const catalogLookup = useMemo(() => {
    const m = new Map(catalogItems.map((i) => [i.id, i]));
    return (id: string) => m.get(id);
  }, [catalogItems]);

  const users = useQuery({
    queryKey: ["admin-users"],
    queryFn: async () => (await api.admin.users.$get()).json(),
    enabled: open,
  });
  const services = useQuery({
    queryKey: ["services"],
    queryFn: async () => (await api.services.$get()).json(),
    enabled: open,
  });
  const templates = useQuery({
    queryKey: ["templates"],
    queryFn: async () => (await api.templates.$get()).json(),
    enabled: open,
  });
  const riders = useQuery({
    queryKey: ["riders"],
    queryFn: async () => (await api.riders.$get()).json(),
    enabled: open,
  });

  const skillClassesQ = useQuery({
    queryKey: ["msg-skill-classes"],
    queryFn: async () => { const r = await fetch("/api/messages/skill-classes"); return r.json(); },
    enabled: open,
  });
  const skillsQ = useQuery({
    queryKey: ["msg-skills"],
    queryFn: async () => { const r = await fetch("/api/messages/skills"); return r.json(); },
    enabled: open,
  });
  const allSkillClasses: string[] = (skillClassesQ.data?.skillClasses ?? []).map((s: any) => s.name);
  const allSkills: string[] = (skillsQ.data?.skills ?? []).map((s: any) => s.name ?? s);

  const clients = useMemo(
    () => (users.data?.users ?? []).filter((u: any) => u.role === "customer"),
    [users.data],
  );

  // default rate model from template / service
  useEffect(() => {
    if (rateTouched) return;
    const tpl = (templates.data?.templates ?? []).find((t: any) => t.id === templateId);
    const svc = (services.data?.services ?? []).find((s: any) => s.id === serviceId);
    const fromTpl = parseRateModel(tpl?.rateModel);
    const fromSvc = parseRateModel(svc?.rateModel);
    const next = fromTpl ?? fromSvc;
    if (next) setRateModel(next);
    else if (svc) setRateModel({ ...EMPTY_RATE_MODEL, flatRate: svc.basePrice || 0 });
  }, [templateId, serviceId, templates.data, services.data, rateTouched]);

  // infer region from address
  useEffect(() => {
    if (!region && address) {
      const r = regionFromAddress(address);
      if (r) setRegion(r);
    }
  }, [address]); // eslint-disable-line

  // default est. minutes from template/service
  useEffect(() => {
    const tpl = (templates.data?.templates ?? []).find((t: any) => t.id === templateId);
    const svc = (services.data?.services ?? []).find((s: any) => s.id === serviceId);
    const mins = tpl?.estimatedMins ?? svc?.durationMins;
    if (mins) setEstMinutes(String(mins));
  }, [templateId, serviceId, templates.data, services.data]);

  // live price preview
  const quote = useMemo(() => {
    const cfExtra = customFields
      .filter((f) => f.type === "flat_fee" && f.amount)
      .reduce((s, f) => s + (f.amount ?? 0), 0);

    // charges from ChargesEditor (flat fee + per-unit; hourly billed at job time)
    const { clientTotal: _chargesClientTotal, techTotal: chargesTechTotal } = chargesSummary(charges);
    // only flat_fee and per_unit have known amounts; hourly = 0 until job done
    const chargesKnown = charges
      .filter((c) => c.type !== "hourly")
      .reduce((s, c) => {
        if (c.type === "flat_fee") return s + c.amount;
        if (c.type === "per_unit") return s + c.qty * c.unitPrice;
        return s;
      }, 0);

    // catalog line items (from service catalog)
    const catalogLines = lineItems.filter((l) => l.kind !== "unit");
    const cat = sumLineItems(catalogLines);

    const subtotal = Math.round((chargesKnown + cfExtra + cat.price) * 100) / 100;
    const tax = lookupTax(region);
    const taxRate = tax?.rate ?? 0;
    const taxableBase = chargesKnown + cfExtra + cat.taxablePrice;
    const taxAmount = Math.round(taxableBase * taxRate) / 100;
    const total = Math.round((subtotal + taxAmount) * 100) / 100;

    // build display items from charges
    const chargeItems = charges.map((c) => {
      if (c.type === "flat_fee") return { label: c.label || "Flat fee", amount: c.amount };
      if (c.type === "hourly") return { label: c.label || "Hourly", amount: null };
      return {
        label: `${c.qty} ${c.unit}${c.name ? ` · ${c.name}` : ""} × ${c.unitPrice.toFixed(2)}`,
        amount: c.qty * c.unitPrice,
      };
    });

    return {
      subtotal,
      chargeItems,
      chargesKnown,
      chargesTechTotal,
      cfExtra,
      lineItemsPrice: cat.price,
      lineItemsCost: cat.cost,
      lineItemsMargin: cat.margin,
      taxLabel: tax?.label ?? "No tax region",
      taxAmount,
      total,
      hasHourly: charges.some((c) => c.type === "hourly"),
    };
  }, [charges, region, customFields, lineItems]);

  // populate from editBooking
  useEffect(() => {
    if (!open) return;
    setErr("");
    if (editBooking) {
      const b = editBooking;
      setCustomerId(b.customerId ?? "");
      setServiceId(b.serviceId ?? "");
      setTemplateId(b.templateId ?? "");
      setTitle(b.title ?? "");
      setPriority(b.priority ?? "normal");
      setScheduledAt(b.scheduledAt ? toLocalInput(new Date(b.scheduledAt)) : toLocalInput());
      setAddress(b.address ?? "");
      setLat(b.lat ?? null);
      setLng(b.lng ?? null);
      setRiderId(b.riderId ?? "");
      setRequiredSkillClass((b as any).requiredSkillClass ?? "");
      setRequiredSkills((b as any).requiredSkills ? (b as any).requiredSkills.split(",").filter(Boolean) : []);
      setNotes(b.notes ?? "");
      setStaffNotes((b as any).staffNotes ?? "");
      setRegion(b.region ?? "");
      const rm = parseRateModel(b.rateModel);
      if (rm) { setRateModel(rm); setRateTouched(true); }
      try {
        const li = typeof b.lineItems === "string" ? JSON.parse(b.lineItems || "[]") : b.lineItems;
        const liArr: LineItem[] = Array.isArray(li) ? li : [];
        // restore unit-kind line items as per_unit charges so they show in ChargesEditor
        const restoredCharges: Charge[] = liArr
          .filter((l) => l.kind === "unit")
          .map((l) => ({
            id: l.itemId || Math.random().toString(36).slice(2),
            type: "per_unit" as const,
            name: l.name || "",
            unit: l.unit || "each",
            qty: l.qty || 1,
            unitPrice: l.unitPrice || 0,
            unitPayRate: l.unitCost || 0,
          }));
        setLineItems(liArr.filter((l) => l.kind !== "unit"));
        setCharges(restoredCharges);
      } catch { setLineItems([]); setCharges([]); }
      // restore custom fields if any
      try {
        const fd = JSON.parse(b.fieldData || "{}");
        if (Array.isArray(fd._customFields)) setCustomFields(fd._customFields);
        else setCustomFields([]);
      } catch { setCustomFields([]); }
      // Editing an existing booking: fields are whatever was saved, not a
      // fresh template load — template switching stays manual/explicit here.
      setFieldsFromTemplate(false);
      setPendingTemplateSwap(null);
    } else {
      setScheduledAt(toLocalInput(defaultDate));
      setRiderId(defaultRiderId ?? "");
      setRequiredSkillClass("");
      setRequiredSkills([]);
      setTechFilter("");
      setCustomFields([]);
      setLineItems([]);
      setFieldsFromTemplate(false);
      setPendingTemplateSwap(null);
    }
  }, [open, defaultDate, defaultRiderId, editBooking]);

  // ── mutations ──────────────────────────────────────────────────────────────

  function buildPayload() {
    // Convert ChargesEditor charges into LineItem records for DB persistence.
    // flat_fee → kind:"flat_fee_line", hourly → stored in rateModel, per_unit → kind:"unit"
    const chargeLineItems: LineItem[] = charges.map((c) => {
      if (c.type === "per_unit") {
        return buildUnitLineItem({
          name: c.name || "Line item",
          unit: c.unit || "each",
          qty: c.qty,
          unitPrice: c.unitPrice,
          unitPayRate: c.unitPayRate,
          taxable: true,
        });
      }
      // flat_fee stored as a unit line with qty=1 so it shows on invoices
      return buildUnitLineItem({
        name: c.type === "flat_fee" ? (c.label || "Flat fee") : (c.label || "Hourly charge"),
        unit: "job",
        qty: 1,
        unitPrice: c.type === "flat_fee" ? c.amount : 0,
        unitPayRate: c.type === "flat_fee" ? c.techPay : 0,
        taxable: true,
      });
    });

    // Build rateModel from hourly charges (use first hourly charge if present)
    const hourlyCharge = charges.find((c) => c.type === "hourly");
    const effectiveRateModel: RateModel = hourlyCharge
      ? {
          ...EMPTY_RATE_MODEL,
          freeMinutes: hourlyCharge.freeMinutes,
          firstHourRate: hourlyCharge.firstHourRate,
          additionalHourRate: hourlyCharge.additionalHourRate,
        }
      : rateModel;

    const allLineItems = [...lineItems, ...chargeLineItems];

    return {
      customerId,
      serviceId,
      templateId: templateId || undefined,
      title: title || undefined,
      priority,
      scheduledAt: new Date(scheduledAt).toISOString(),
      address,
      lat: lat ?? undefined,
      lng: lng ?? undefined,
      notes,
      staffNotes,
      riderId: riderId || undefined,
      region: region || undefined,
      rateModel: effectiveRateModel,
      lineItems: allLineItems,
      fieldData: { _customFields: customFields },
      requiredSkillClass: requiredSkillClass || "",
      requiredSkills: requiredSkills.join(","),
    };
  }

  const create = useMutation({
    mutationFn: async () => {
      const res = await api.bookings.admin.$post({ json: buildPayload() as any });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}) as any);
        throw new Error((e as any).message || "Failed to create work order");
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bookings"] });
      qc.invalidateQueries({ queryKey: ["scheduler"] });
      qc.invalidateQueries({ queryKey: ["riders"] });
      reset();
      onCreated?.();
      onClose();
    },
    onError: (e: any) => setErr(e.message),
  });

  const update = useMutation({
    mutationFn: async () => {
      const res = await api.bookings[":id"].$patch({
        param: { id: editBooking.id },
        json: {
          ...buildPayload(),
          templateId: templateId || "",
          riderId: riderId || "",
          region: region || "",
        } as any,
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}) as any);
        throw new Error((e as any).message || "Failed to update work order");
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bookings"] });
      qc.invalidateQueries({ queryKey: ["scheduler"] });
      qc.invalidateQueries({ queryKey: ["riders"] });
      onCreated?.();
      onClose();
    },
    onError: (e: any) => setErr(e.message),
  });

  function reset() {
    setCustomerId(""); setServiceId(""); setTemplateId(""); setTitle("");
    setPriority("normal"); setAddress(""); setLat(null); setLng(null);
    setRiderId(""); setRequiredSkillClass(""); setRequiredSkills([]); setTechFilter("");
    setNotes(""); setStaffNotes(""); setRegion("");
    setRateModel({ ...EMPTY_RATE_MODEL }); setRateTouched(false); setCharges([]);
    setEstMinutes("60"); setEstKm("0"); setCustomFields([]); setLineItems([]);
    setFieldsFromTemplate(false); setPendingTemplateSwap(null);
  }

  function addCatalogItem(item: CatalogItem, qty: number) {
    const li = buildLineItem(item, qty, catalogLookup);
    setLineItems((prev) => {
      const idx = prev.findIndex((p) => p.itemId === li.itemId);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = buildLineItem(item, (prev[idx].qty || 0) + qty, catalogLookup);
        return next;
      }
      return [...prev, li];
    });
  }
  function setLineQty(itemId: string, qty: number) {
    setLineItems((prev) =>
      prev.map((p) => {
        if (p.itemId !== itemId) return p;
        const item = catalogLookup(itemId);
        if (item) return buildLineItem(item, qty, catalogLookup);
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

  function submit() {
    setErr("");
    if (!customerId) return setErr("Select a client");
    if (!serviceId) return setErr("Select a service");
    if (!scheduledAt) return setErr("Pick a schedule date");
    if (isEdit) update.mutate();
    else create.mutate();
  }

  function addField(type: CfType) {
    const meta = CF_TYPES.find((t) => t.type === type)!;
    setCustomFields((prev) => [
      ...prev,
      { id: uid(), type, label: meta.label, required: false },
    ]);
    // Hand-adding a field means these fields are no longer purely
    // template-sourced — protect them from a silent template swap.
    setFieldsFromTemplate(false);
  }

  const busy = create.isPending || update.isPending;

  const pendingTemplateName = pendingTemplateSwap
    ? (templates.data?.templates ?? []).find((t: any) => t.id === pendingTemplateSwap)?.name ?? "this template"
    : "";

  return (
    <>
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? "Edit Work Order" : "New Work Order"}
      subtitle={isEdit ? "Adjust any detail of this job" : "Schedule a job on behalf of a client"}
      size="lg"
      footer={
        <>
          <BtnGhost onClick={onClose}>Cancel</BtnGhost>
          <BtnPrimary onClick={submit} disabled={busy}>
            {busy ? (isEdit ? "Saving…" : "Creating…") : (isEdit ? "Save Changes" : "Create Work Order")}
          </BtnPrimary>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">

        {/* ── Core fields ── */}
        <Field label={customerNoun}>
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} className={inputCls}>
            <option value="">Select client…</option>
            {clients.map((c: any) => (
              <option key={c.id} value={c.id}>{c.name} — {c.email}</option>
            ))}
          </select>
        </Field>

        <Field label="Service">
          <select value={serviceId} onChange={(e) => {
            setServiceId(e.target.value);
            const s = (services.data?.services ?? []).find((x: any) => x.id === e.target.value);
            if (s && !title) setTitle(s.name);
          }} className={inputCls}>
            <option value="">Select service…</option>
            {(services.data?.services ?? []).map((s: any) => (
              <option key={s.id} value={s.id}>{s.name} — ${s.basePrice}</option>
            ))}
          </select>
        </Field>

        <Field label="Template" hint="Loads its checklist & custom fields below — edit freely before saving">
          <select
            value={templateId}
            onChange={(e) => {
              const id = e.target.value;
              // Only auto-manage fields for a BRAND NEW work order — editing
              // an existing booking's template stays manual/explicit.
              if (editBooking) { setTemplateId(id); return; }

              if (customFields.length === 0) {
                // Nothing to protect — just load the picked template's fields
                // (or clear them if "None" was picked).
                setTemplateId(id);
                if (id) {
                  const tpl = (templates.data?.templates ?? []).find((t: any) => t.id === id);
                  if (tpl) { setCustomFields(templateFieldsToCustomFields(tpl.fields)); setFieldsFromTemplate(true); }
                }
                return;
              }

              if (fieldsFromTemplate) {
                // Current fields came from a previous template pick (nothing
                // hand-added since) — switching templates should refresh them,
                // that's the whole point of "pick a different template."
                setTemplateId(id);
                if (id) {
                  const tpl = (templates.data?.templates ?? []).find((t: any) => t.id === id);
                  setCustomFields(tpl ? templateFieldsToCustomFields(tpl.fields) : []);
                } else {
                  setCustomFields([]);
                  setFieldsFromTemplate(false);
                }
                return;
              }

              // Existing fields were hand-built (no template involved) —
              // never silently clobber them. Ask first.
              if (!id) { setTemplateId(id); return; } // picking "None" never destroys hand-built fields
              setPendingTemplateSwap(id);
            }}
            className={inputCls}
          >
            <option value="">None</option>
            {(templates.data?.templates ?? []).map((t: any) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </Field>

        <Field label="Priority">
          <select value={priority} onChange={(e) => setPriority(e.target.value)} className={inputCls}>
            {Object.entries(PRIORITY_META).map(([k, v]: any) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
        </Field>

        <Field label="Title">
          <input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Job title" className={inputCls} />
        </Field>

        <Field label="Schedule">
          <input aria-label="Schedule" type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className={inputCls} />
        </Field>

        {/* ── Address autocomplete ── */}
        <div className="sm:col-span-2">
          <Field label="Address">
            <AddressAutocomplete
              value={address}
              onResolve={(v) => {
                setAddress(v.address);
                setLat(v.lat);
                setLng(v.lng);
                if (v.address && !region) {
                  const r = regionFromAddress(v.address);
                  if (r) setRegion(r);
                }
              }}
              placeholder="Start typing an address…"
            />
          </Field>
        </div>

        {/* ── Skill class + skill tags ────────────────────────────────── */}
        <Field label="Required skill class" hint="Filter tech assignment to matching skill class">
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setRequiredSkillClass("")}
              className={`rounded-full px-2.5 py-0.5 text-xs font-semibold transition ${requiredSkillClass === "" ? "bg-brand text-white" : "bg-white/10 text-slate-300 hover:bg-white/15"}`}
            >
              Any
            </button>
            {allSkillClasses.map((sc) => (
              <button
                key={sc}
                type="button"
                onClick={() => setRequiredSkillClass(sc === requiredSkillClass ? "" : sc)}
                className={`rounded-full px-2.5 py-0.5 text-xs font-semibold transition ${requiredSkillClass === sc ? "bg-brand text-white" : "bg-white/10 text-slate-300 hover:bg-white/15"}`}
              >
                {sc}
              </button>
            ))}
          </div>
        </Field>

        {allSkills.length > 0 && (
          <Field label="Required skills" hint="Tag specific skills needed for this job">
            <div className="flex flex-wrap gap-1.5">
              {allSkills.map((sk) => {
                const active = requiredSkills.includes(sk);
                return (
                  <button
                    key={sk}
                    type="button"
                    onClick={() => setRequiredSkills((prev) => active ? prev.filter((x) => x !== sk) : [...prev, sk])}
                    className={`rounded-full px-2.5 py-0.5 text-xs font-semibold transition ${active ? "bg-cyan-glow/20 text-cyan-glow ring-1 ring-cyan-glow/40" : "bg-white/10 text-slate-300 hover:bg-white/15"}`}
                  >
                    {sk}
                  </button>
                );
              })}
            </div>
          </Field>
        )}

        {/* ── Tech assignment (smart filtered) ───────────────────────── */}
        <Field label={`Assign ${noun}`} hint="Optional — auto-dispatches">
          {(() => {
            const allRiders: any[] = riders.data?.riders ?? [];
            const filterLower = techFilter.toLowerCase();
            const filtered = allRiders.filter((r) => {
              const nameMatch = !filterLower || r.name?.toLowerCase().includes(filterLower);
              const classMatch = !requiredSkillClass || r.skillClass === requiredSkillClass;
              return nameMatch && classMatch;
            });
            const selected = allRiders.find((r) => r.id === riderId);
            return (
              <div className="space-y-1.5">
                {/* search */}
                <input
                  type="text"
                  aria-label={`Search ${noun.toLowerCase()}s`}
                  placeholder={`Search ${noun.toLowerCase()}s…`}
                  value={techFilter}
                  onChange={(e) => setTechFilter(e.target.value)}
                  className={inputCls + " text-sm"}
                />
                {/* selected badge */}
                {selected && (
                  <div className="flex items-center gap-2 rounded-lg border border-brand/30 bg-brand/10 px-2.5 py-1.5 text-xs">
                    <span className="font-semibold text-slate-200">{selected.name}</span>
                    {selected.skillClass && <span className="ml-1 rounded-full bg-brand/20 px-1.5 py-0.5 text-[10px] text-brand">{selected.skillClass}</span>}
                    <button type="button" onClick={() => setRiderId("")} className="ml-auto text-slate-400 hover:text-white">✕</button>
                  </div>
                )}
                {/* list */}
                <div className="max-h-44 overflow-y-auto rounded-lg border border-white/10 bg-ink-3/60">
                  <button
                    type="button"
                    onClick={() => setRiderId("")}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-white/5 ${!riderId ? "bg-white/5" : ""}`}
                  >
                    <span className="text-slate-400 italic">Leave unassigned</span>
                  </button>
                  {filtered.length === 0 && (
                    <p className="px-3 py-2 text-xs text-slate-500">No {noun.toLowerCase()}s match{requiredSkillClass ? ` skill class "${requiredSkillClass}"` : ""}.</p>
                  )}
                  {filtered.map((r) => {
                    const isMatch = !requiredSkillClass || r.skillClass === requiredSkillClass;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => setRiderId(r.id)}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition hover:bg-white/5 ${riderId === r.id ? "bg-brand/10" : ""}`}
                      >
                        <span className={`h-2 w-2 shrink-0 rounded-full ${r.status === "available" ? "bg-green-400" : r.status === "busy" ? "bg-amber-400" : "bg-slate-600"}`} />
                        <span className="font-medium text-slate-200">{r.name}</span>
                        {r.skillClass && (
                          <span className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${isMatch ? "bg-brand/20 text-brand" : "bg-white/10 text-slate-400"}`}>{r.skillClass}</span>
                        )}
                        <span className="ml-auto capitalize text-[10px] text-slate-500">{r.status}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </Field>

        <Field label="Tax region">
          <select value={region} onChange={(e) => setRegion(e.target.value)} className={inputCls}>
            <option value="">Auto-detect from address</option>
            <option value="ON">Ontario (HST 13%)</option>
            <option value="BC">British Columbia (GST+PST 12%)</option>
            <option value="AB">Alberta (GST 5%)</option>
            <option value="QC">Québec (GST+QST 14.975%)</option>
            <option value="MB">Manitoba (GST+PST 12%)</option>
            <option value="SK">Saskatchewan (GST+PST 11%)</option>
            <option value="NS">Nova Scotia (HST 15%)</option>
            <option value="NB">New Brunswick (HST 15%)</option>
            <option value="PE">PEI (HST 15%)</option>
            <option value="NL">Newfoundland (HST 15%)</option>
          </select>
        </Field>

        <Field label="Est. minutes on site" hint="Billable time">
          <input aria-label="Est. minutes on site" type="number" inputMode="numeric" min={0} value={estMinutes}
            onChange={(e) => setEstMinutes(e.target.value)}
            onBlur={(e) => setEstMinutes(String(Math.max(0, Number(e.target.value) || 0)))}
            className={inputCls} />
        </Field>

        <Field label="Est. mileage (km)" hint="Round-trip travel">
          <input aria-label="Est. mileage (km)" type="number" inputMode="decimal" min={0} value={estKm}
            onChange={(e) => setEstKm(e.target.value)}
            onBlur={(e) => setEstKm(String(Math.max(0, Number(e.target.value) || 0)))}
            className={inputCls} />
        </Field>

        <div className="sm:col-span-2">
          <Field label="Notes (customer-facing)">
            <textarea aria-label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)}
              rows={3} placeholder="Additional details visible to the customer…" className={inputCls} />
          </Field>
        </div>

        <div className="sm:col-span-2">
          <Field label="Staff Notes to Driver (access codes, special instructions — not shown to customer)">
            <textarea aria-label="Staff Notes" value={staffNotes} onChange={(e) => setStaffNotes(e.target.value)}
              rows={3} placeholder="E.g. Access code 4521. Ring bell twice. Park on side street…" className={`${inputCls} border-amber-500/40 focus:border-amber-500`} />
          </Field>
        </div>

        {/* Driver Field Notes (read-only — written by tech on-site) */}
        {!!(editBooking as any)?.driverNotes && (
          <div className="sm:col-span-2">
            <Field label="Driver Field Notes (written on-site by technician)">
              <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-3 py-3 text-sm text-emerald-300 whitespace-pre-wrap leading-relaxed">
                {(editBooking as any).driverNotes}
              </div>
            </Field>
          </div>
        )}

        {/* Time & Mileage — auto-tracked from the driver app (Start Driving, geofence arrival/departure) */}
        {isEdit && editBooking?.enrouteAt && (
          <div className="sm:col-span-2">
            <TimeMileagePanel booking={editBooking} />
          </div>
        )}

        {/* Options/tier selections link — send to the customer so they can pick a
            tier per option category (Good/Better/Best) and e-sign; price deltas
            roll into this job's line items automatically once submitted. */}
        {isEdit && editBooking?.publicToken && (
          <div className="sm:col-span-2">
            <button
              type="button"
              onClick={() => {
                const url = `${window.location.origin}/s/${editBooking.publicToken}`;
                navigator.clipboard?.writeText(url);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-white/10"
            >
              Copy customer selections link
            </button>
          </div>
        )}

        {/* ── Catalog line items ── */}
        <div className="sm:col-span-2">
          <CatalogLineItems
            items={catalogItems}
            lineItems={lineItems.filter((l) => l.kind !== "unit")}
            lookup={catalogLookup}
            onAdd={addCatalogItem}
            onQty={setLineQty}
            onRemove={removeLine}
          />
        </div>

        {/* ── Per-unit line items (charge + tech pay by measured unit) ── */}
        <div className="sm:col-span-2">
          <UnitLineItems
            lines={lineItems.filter((l) => l.kind === "unit")}
            workerNoun="Technician"
            catalogItems={catalogItems}
            onAdd={addUnitLine}
            onChange={changeUnitLine}
            onRemove={removeUnitLine}
          />
        </div>

        {/* ── Charges (flat fee / hourly / per-unit) ── */}
        <div className="sm:col-span-2">
          <ChargesEditor charges={charges} onChange={setCharges} />
        </div>

        {/* ── Price preview ── */}
        <div className="sm:col-span-2 rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-cyan-400">
            Price preview
          </div>
          <div className="space-y-1 text-sm">
            {charges.length === 0 && !quote.cfExtra && !quote.lineItemsPrice ? (
              <p className="text-slate-500">Add a charge above to see pricing.</p>
            ) : (
              <>
                {/* charges */}
                {quote.chargeItems.map((it: any, i: number) => (
                  <div key={i} className="flex justify-between text-slate-300">
                    <span>{it.label}</span>
                    <span>{it.amount !== null ? `${it.amount.toFixed(2)}` : <span className="text-slate-500 text-xs">billed at job time</span>}</span>
                  </div>
                ))}
                {quote.cfExtra > 0 && (
                  <div className="flex justify-between text-slate-300">
                    <span>Custom field add-ons</span>
                    <span>+${quote.cfExtra.toFixed(2)}</span>
                  </div>
                )}
                {quote.lineItemsPrice > 0 && (
                  <div className="flex justify-between text-slate-300">
                    <span>
                      Catalog items{" "}
                      <span className="text-[11px] text-emerald-400">
                        (margin ${quote.lineItemsMargin.toFixed(2)})
                      </span>
                    </span>
                    <span>+${quote.lineItemsPrice.toFixed(2)}</span>
                  </div>
                )}
                {(quote.chargesKnown > 0 || quote.cfExtra > 0 || quote.lineItemsPrice > 0) && (
                  <>
                    <div className="flex justify-between border-t border-white/10 pt-1 text-slate-400">
                      <span>Subtotal</span><span>${quote.subtotal.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-slate-400">
                      <span>{quote.taxLabel}</span><span>${quote.taxAmount.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between pt-1 text-base font-semibold text-white">
                      <span>Total</span><span>${quote.total.toFixed(2)}</span>
                    </div>
                    {quote.hasHourly && (
                      <p className="text-[11px] text-slate-500 pt-1">* Hourly charges billed at actual job time</p>
                    )}
                    {quote.chargesTechTotal > 0 && (
                      <div className="mt-1 flex justify-between border-t border-white/10 pt-1.5 text-amber-400">
                        <span>{noun} pay</span>
                        <span>${quote.chargesTechTotal.toFixed(2)}</span>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>

        {/* ── Custom fields section ── */}
        <div className="sm:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-white">Custom fields</p>
              <p className="text-xs text-slate-500">Add extra data collection, instructions, or pricing rules to this job.</p>
            </div>
            <TypePicker onPick={addField} />
          </div>

          {customFields.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/10 py-8 text-center text-sm text-slate-600">
              No custom fields yet — click <span className="text-brand font-medium">Add field</span> to start.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {customFields.map((cf, _i) => (
                <CfCard
                  key={cf.id}
                  cf={cf}
                  onChange={(updated) => {
                    setCustomFields((prev) =>
                      prev.map((x) => (x.id === cf.id ? updated : x)),
                    );
                    // Editing a field (even one that came from a template)
                    // means the fields have diverged from that template —
                    // protect this hand-touched work from a silent swap.
                    setFieldsFromTemplate(false);
                  }}
                  onRemove={() => {
                    setCustomFields((prev) => prev.filter((x) => x.id !== cf.id));
                    setFieldsFromTemplate(false);
                  }}
                />
              ))}
              {/* add another inline */}
              <div className="pt-1">
                <TypePicker onPick={addField} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Job Photos (only visible when editing an existing booking) ── */}
      {isEdit && editBooking?.id && (
        <div className="mt-4 space-y-4">
          <JobPhotosPanel bookingId={editBooking.id} />
          <FieldRecordPanel bookingId={editBooking.id} />
        </div>
      )}

      {err && (
        <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{err}</p>
      )}
    </Modal>

    <ConfirmModal
      open={!!pendingTemplateSwap}
      onClose={() => setPendingTemplateSwap(null)}
      onConfirm={() => {
        const id = pendingTemplateSwap!;
        setTemplateId(id);
        const tpl = (templates.data?.templates ?? []).find((t: any) => t.id === id);
        setCustomFields(tpl ? templateFieldsToCustomFields(tpl.fields) : []);
        setFieldsFromTemplate(true);
        setPendingTemplateSwap(null);
      }}
      title="Replace custom fields?"
      message={`Switching to "${pendingTemplateName}" will replace your current custom fields with this template's fields. Your existing custom fields will be lost.`}
      confirmLabel="Replace fields"
      danger
    />
    </>
  );
}

// ─── Time & Mileage Panel ────────────────────────────────────────────────────
// Read-only summary of what the driver app auto-tracked for this job:
//   - Mileage: accumulated from live GPS pings starting the moment the tech
//     tapped "Start Driving" (enrouteAt), through arrival, on-site, and return.
//   - Transit time: elapsed from "Start Driving" to first arrival on site.
//   - On-site time: geofence-gated clock — pauses automatically if the tech
//     leaves the site (e.g. lunch) and resumes when they return, banked in
//     accumulatedMs/clockState so it live-updates while running.
// Applies to every tenant — this is booking-schema level, not per-company.

function TimeMileagePanel({ booking }: { booking: any }) {
  const [, forceTick] = useState(0);
  const clockRunning = booking.clockState === "running";

  // re-render every 30s so the live on-site minutes counter keeps advancing
  // while this modal is open and the clock is currently running.
  useEffect(() => {
    if (!clockRunning) return;
    const t = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [clockRunning]);

  const onSiteMins = liveOnSiteMinutes({
    accumulatedMs: booking.accumulatedMs ?? 0,
    clockState: booking.clockState ?? "idle",
    lastResumeAt: booking.lastResumeAt ?? null,
  });
  const transitMins = Number(booking.transitMinutes || 0);
  const km = Number(booking.mileageKm || 0);

  const fmtMins = (m: number) => {
    if (!m) return "0 min";
    const h = Math.floor(m / 60);
    const mm = Math.round(m % 60);
    return h > 0 ? `${h}h ${mm}m` : `${mm} min`;
  };

  return (
    <Field label="Time & Mileage (auto-tracked from the driver app)">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="flex items-center gap-2.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5">
          <Navigation className="h-4 w-4 shrink-0 text-brand" />
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">Transit time</p>
            <p className="text-sm font-semibold text-white">{fmtMins(transitMins)}</p>
          </div>
        </div>
        <div className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 ${
          clockRunning ? "border-emerald-500/40 bg-emerald-500/5" : booking.clockState === "paused" ? "border-amber-500/40 bg-amber-500/5" : "border-white/10 bg-white/[0.03]"
        }`}>
          <Clock className={`h-4 w-4 shrink-0 ${clockRunning ? "text-emerald-400" : booking.clockState === "paused" ? "text-amber-400" : "text-brand"}`} />
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">
              On-site time{clockRunning ? " · live" : booking.clockState === "paused" ? " · paused" : ""}
            </p>
            <p className="text-sm font-semibold text-white">{fmtMins(onSiteMins)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5">
          <MapPin className="h-4 w-4 shrink-0 text-brand" />
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">Total mileage</p>
            <p className="text-sm font-semibold text-white">{km.toFixed(1)} km</p>
          </div>
        </div>
      </div>
      {booking.clockState === "paused" && (
        <p className="mt-1.5 text-[11px] text-amber-400">
          Technician stepped away from the job site — on-site clock is paused and will resume automatically when they return.
        </p>
      )}
    </Field>
  );
}

// ─── Field Record Panel ──────────────────────────────────────────────────────
// The office-side view of what was documented on site: the customer's
// signature and any voice notes the tech dictated (with transcript + audio).
// Voice notes are internal — they never appear on a customer-facing surface.

function FieldRecordPanel({ bookingId }: { bookingId: string }) {
  const q = useQuery({
    queryKey: ["job-events", bookingId],
    queryFn: async () => {
      const res = await fetch(`/api/bookings/${bookingId}/events`, { headers: apiHeaders() });
      if (!res.ok) return { events: [], signature: null };
      return (await res.json()) as {
        events: Array<{ id: string; kind: string; label: string; detail?: string; actorName?: string; createdAt?: any; meta?: any }>;
        signature: { url: string; name: string; at: any } | null;
      };
    },
    refetchInterval: 20000,
  });

  const sig = q.data?.signature ?? null;
  const voice = (q.data?.events ?? []).filter((e) => e.kind === "voice_note");
  if (!sig && voice.length === 0) return null;

  return (
    <div className="space-y-3">
      {sig && (
        <div>
          <p className="mb-1.5 text-sm font-semibold text-white flex items-center gap-2">
            <FileText className="h-4 w-4 text-brand" /> Customer sign-off
          </p>
          <div className="rounded-xl border border-white/10 bg-white p-3">
            <img src={sig.url} alt="Customer signature" className="mx-auto h-20 object-contain" />
          </div>
          <p className="mt-1.5 text-xs text-slate-500">
            {sig.name}
            {sig.at ? ` · ${new Date(Number(sig.at)).toLocaleString()}` : ""}
          </p>
        </div>
      )}

      {voice.length > 0 && (
        <div>
          <p className="mb-1.5 text-sm font-semibold text-white flex items-center gap-2">
            <Mic className="h-4 w-4 text-brand" /> Voice notes
            <span className="ml-1 rounded-full bg-brand/20 px-2 py-0.5 text-[10px] font-bold text-brand">
              {voice.length}
            </span>
            <span className="text-[10px] font-normal text-slate-500">internal only</span>
          </p>
          <div className="space-y-2">
            {voice.map((e) => (
              <div key={e.id} className="rounded-xl border border-white/10 bg-ink-3 p-2.5">
                <div className="mb-1.5 flex items-center justify-between text-[11px] text-slate-500">
                  <span>{e.actorName || "Technician"}</span>
                  <span>{e.createdAt ? new Date(Number(e.createdAt)).toLocaleString() : ""}</span>
                </div>
                {e.meta?.url && (
                  // eslint-disable-next-line jsx-a11y/media-has-caption
                  <audio controls aria-label={`Voice note from ${e.actorName || "the technician"}`} src={e.meta.url} className="w-full" />
                )}
                {e.detail ? (
                  <p className="mt-2 whitespace-pre-wrap text-xs text-slate-300">{e.detail}</p>
                ) : (
                  <p className="mt-2 text-xs italic text-slate-600">No transcript — play the recording.</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Job Photos Panel ────────────────────────────────────────────────────────

function JobPhotosPanel({ bookingId }: { bookingId: string }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  // Which stage the next upload documents. Before/after is what makes these
  // photos usable as liability evidence.
  const [phase, setPhase] = useState<"before" | "during" | "after">("before");

  const photos = useQuery({
    queryKey: ["job-photos", bookingId],
    queryFn: async () => {
      const res = await fetch(`/api/bookings/${bookingId}/photos`, { headers: apiHeaders() });
      const data = await res.json();
      return (data.photos ?? []) as Array<{
        id: string; url: string; caption?: string; createdAt?: string;
        phase?: string; customerVisible?: boolean;
      }>;
    },
    refetchInterval: 15000, // poll every 15s so new driver photos appear
  });

  async function handleUpload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("caption", "");
      fd.append("phase", phase);
      await fetch(`/api/bookings/${bookingId}/photos`, {
        method: "POST",
        headers: apiHeaders(),
        body: fd,
      });
      await qc.invalidateQueries({ queryKey: ["job-photos", bookingId] });
    } finally {
      setUploading(false);
    }
  }

  const list = photos.data ?? [];

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-white flex items-center gap-2">
            <Camera className="h-4 w-4 text-brand" />
            Job Photos
            {list.length > 0 && (
              <span className="ml-1 rounded-full bg-brand/20 px-2 py-0.5 text-[10px] font-bold text-brand">
                {list.length}
              </span>
            )}
          </p>
          <p className="text-xs text-slate-500">Photos uploaded by the technician in the field</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border border-white/10">
            {(["before", "during", "after"] as const).map((ph) => (
              <button
                key={ph}
                type="button"
                onClick={() => setPhase(ph)}
                className={`px-2 py-1.5 text-[11px] font-semibold capitalize transition ${
                  phase === ph ? "bg-brand/20 text-brand" : "text-slate-400 hover:bg-white/5"
                }`}
              >
                {ph}
              </button>
            ))}
          </div>
        <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-semibold text-slate-300 hover:bg-white/10">
          {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
          {uploading ? "Uploading…" : "Add photo"}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            aria-label="Upload job photo"
            className="sr-only"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.target.value = ""; }}
            disabled={uploading}
          />
        </label>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 py-6 text-center text-sm text-slate-600">
          <ImageIcon className="mx-auto mb-2 h-6 w-6 opacity-40" />
          No photos yet — technician photos will appear here automatically.
        </div>
      ) : (
        <div className="space-y-3">
          {(["before", "during", "after"] as const).map((ph) => {
            const group = list.filter((p) =>
              ph === "during" ? !p.phase || p.phase === "during" : p.phase === ph,
            );
            if (!group.length) return null;
            return (
              <div key={ph}>
                <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  {ph} <span className="text-slate-600">({group.length})</span>
                </p>
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                  {group.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setLightbox(p.url)}
                      className="group relative aspect-square overflow-hidden rounded-lg border border-white/10 bg-ink-3 hover:border-brand/40"
                    >
                      <img
                        src={p.url}
                        alt={p.caption || "Job photo"}
                        className="h-full w-full object-cover transition-transform group-hover:scale-105"
                      />
                      {p.customerVisible === false && (
                        <span className="absolute right-1 top-1 rounded bg-black/70 px-1 text-[8px] font-bold uppercase text-amber-warn">
                          Internal
                        </span>
                      )}
                      {p.caption && (
                        <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5 text-[9px] text-white truncate">
                          {p.caption}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Lightbox */}
      {lightbox && (
        <dialog
          open
          aria-label="Job photo viewer"
          onCancel={() => setLightbox(null)}
          className="fixed inset-0 z-[9999] m-0 flex h-full w-full max-h-none max-w-none items-center justify-center bg-black/90 p-4 backdrop-blur-sm border-none"
        >
          {/* Invisible backdrop — click to dismiss */}
          <button
            type="button"
            aria-label="Close photo viewer"
            onClick={() => setLightbox(null)}
            className="fixed inset-0 h-full w-full cursor-default border-none bg-transparent"
          />
          {/* X close */}
          <button
            type="button"
            onClick={() => setLightbox(null)}
            className="absolute right-4 top-4 z-10 grid h-9 w-9 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20"
          >
            <X className="h-5 w-5" />
          </button>
          {/* Image — above backdrop */}
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            className="relative z-10 border-none bg-transparent p-0 cursor-default"
            aria-label="Full size photo"
          >
            <img
              src={lightbox}
              alt="Full size view"
              className="max-h-[90vh] max-w-[90vw] rounded-xl object-contain shadow-2xl"
            />
          </button>
        </dialog>
      )}
    </div>
  );
}

