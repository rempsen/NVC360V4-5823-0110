import { useMemo, useRef, useState } from "react";
import { useConfirm } from "../../components/confirm-dialog";
import { DialogPanel } from "../../components/dialog-panel";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, apiHeaders } from "../../lib/api";
import { FullLoader } from "../../components/loader";
import { CategoryManagerButton } from "../../components/category-manager";
import { money, dismiss } from "../../lib/utils";
import {
  Plus,
  X,
  Pencil,
  Trash2,
  Search,
  Package,
  Wrench,
  Layers,
  Upload,
  Loader2,
} from "lucide-react";
import {
  itemUnitCost,
  itemUnitPrice,
  marginPct,
  normalizeCatalogItem,
  round2,
  type CatalogItem,
  type CatalogKind,
  type AssemblyComponent,
} from "../../../shared/catalog";

type Row = CatalogItem & {
  resolvedUnitCost?: number;
  resolvedUnitPrice?: number;
  resolvedMarginPct?: number;
  createdAt?: unknown;
};

const KIND_META: Record<CatalogKind, { label: string; icon: typeof Package; tint: string }> = {
  service: { label: "Service", icon: Wrench, tint: "text-cyan-glow" },
  product: { label: "Product", icon: Package, tint: "text-emerald-400" },
  assembly: { label: "Assembly", icon: Layers, tint: "text-amber-400" },
};

const UNITS = ["each", "job", "hour", "sqft", "sqm", "ft", "m", "box", "set", "gal", "L"];

const EMPTY: Partial<Row> = {
  kind: "product",
  name: "",
  sku: "",
  category: "General",
  description: "",
  image: "",
  unit: "each",
  unitCost: 0,
  markupPct: 40,
  priceMode: "auto",
  unitPrice: 0,
  taxable: true,
  components: [],
};

export default function AdminCatalog() {
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Partial<Row> | null>(null);
  const [kind, setKind] = useState<"all" | CatalogKind>("all");
  const [q, setQ] = useState("");

  const catalog = useQuery({
    queryKey: ["catalog"],
    queryFn: async () => (await api.catalog.$get({ query: {} })).json(),
  });

  const del = useMutation({
    mutationFn: async (id: string) => api.catalog[":id"].$delete({ param: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["catalog"] }),
  });

  if (catalog.isLoading) return <FullLoader label="Loading catalog…" />;
  const all: Row[] = ((catalog.data as any)?.items ?? []).map((r: any) => ({
    ...normalizeCatalogItem(r),
    resolvedUnitCost: r.resolvedUnitCost,
    resolvedUnitPrice: r.resolvedUnitPrice,
    resolvedMarginPct: r.resolvedMarginPct,
  }));

  const list = all.filter((r) => {
    if (kind !== "all" && r.kind !== kind) return false;
    if (q) {
      const s = q.toLowerCase();
      if (
        !r.name.toLowerCase().includes(s) &&
        !r.sku.toLowerCase().includes(s) &&
        !r.category.toLowerCase().includes(s)
      )
        return false;
    }
    return true;
  });

  const counts = {
    all: all.length,
    service: all.filter((r) => r.kind === "service").length,
    product: all.filter((r) => r.kind === "product").length,
    assembly: all.filter((r) => r.kind === "assembly").length,
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-extrabold text-white">Catalog</h1>
          <p className="text-sm text-slate-500">
            {all.length} items · services, products & assemblies
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setEditing({ ...EMPTY, kind: "assembly", markupPct: 0, priceMode: "auto" })}
            className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-4 py-2.5 text-sm font-semibold text-slate-200 hover:bg-white/10"
          >
            <Layers className="h-4 w-4" /> New assembly
          </button>
          <button
            onClick={() => setEditing(EMPTY)}
            className="inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-deep"
          >
            <Plus className="h-4 w-4" /> New item
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-full bg-white/5 p-1">
          {(["all", "service", "product", "assembly"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`rounded-full px-3.5 py-1.5 text-xs font-semibold capitalize transition ${
                kind === k ? "bg-brand text-white" : "text-slate-400 hover:text-white"
              }`}
            >
              {k === "all" ? "All" : KIND_META[k].label + "s"}{" "}
              <span className="opacity-60">{counts[k]}</span>
            </button>
          ))}
        </div>
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input aria-label="Search name, SKU, category…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, SKU, category…"
            className="w-64 rounded-full border border-white/10 bg-ink-2 py-2 pl-9 pr-3 text-sm outline-none focus:border-brand"
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {list.map((r) => {
          const M = KIND_META[r.kind];
          const Icon = M.icon;
          const price = r.resolvedUnitPrice ?? 0;
          const cost = r.resolvedUnitCost ?? 0;
          const margin = r.resolvedMarginPct ?? marginPct(cost, price);
          return (
            <div key={r.id} className="overflow-hidden rounded-2xl border border-white/5 nvc-card">
              {r.image ? (
                <img src={r.image} alt="" className="h-28 w-full object-cover" />
              ) : (
                <div className="grid h-28 w-full place-items-center bg-white/5">
                  <Icon className={`h-8 w-8 ${M.tint} opacity-40`} />
                </div>
              )}
              <div className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate font-bold text-white">{r.name}</h3>
                    <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${M.tint}`}>
                      <Icon className="h-3 w-3" /> {M.label} · {r.category}
                    </span>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-extrabold text-white">{money(price)}</div>
                    <span className="text-[10px] text-slate-500">/{r.unit}</span>
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-3 text-[11px] text-slate-500">
                  <span>cost {money(cost)}</span>
                  <span
                    className={
                      margin >= 30 ? "text-emerald-400" : margin >= 10 ? "text-amber-400" : "text-red-400"
                    }
                  >
                    {margin}% margin
                  </span>
                  {!r.taxable && <span className="text-slate-600">no tax</span>}
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => setEditing(r)}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-white/5 py-2 text-xs font-semibold text-slate-200 hover:bg-white/10"
                  >
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </button>
                  <button
                    onClick={async () => {
                      if (await confirm({ title: `Archive "${r.name}"?`, message: "It stays on past work orders but can't be added to new ones.", confirmLabel: "Archive" }))
                        del.mutate(r.id);
                    }}
                    className="grid w-10 place-items-center rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        {list.length === 0 && (
          <div className="col-span-full grid place-items-center rounded-2xl border border-dashed border-white/10 py-16 text-sm text-slate-500">
            No items match.
          </div>
        )}
      </div>

      {editing && (
        <CatalogModal
          row={editing}
          allItems={all}
          onClose={() => setEditing(null)}
          onDone={() => {
            qc.invalidateQueries({ queryKey: ["catalog"] });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function CatalogModal({
  row,
  allItems,
  onClose,
  onDone,
}: {
  row: Partial<Row>;
  allItems: Row[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState<Partial<Row>>({ ...row, components: row.components ?? [] });
  const isEdit = !!row.id;
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // Shared category list — same source as the Form Builder template category
  // dropdown, so admins manage categories once and see them everywhere.
  const categoriesQ = useQuery({
    queryKey: ["form-categories"],
    queryFn: async () => (await api.catalog.categories.$get()).json(),
  });
  const categoryOptions: string[] = ((categoriesQ.data as any)?.categories ?? []).map((c: any) => c.name);

  const lookup = useMemo(() => {
    const map = new Map(allItems.map((i) => [i.id, i]));
    // include in-progress edits so assembly preview reflects current form for self
    return (id: string) => map.get(id);
  }, [allItems]);

  const liveItem: CatalogItem = normalizeCatalogItem({
    ...form,
    id: form.id ?? "__new__",
    components: form.components ?? [],
  });
  const liveCost = itemUnitCost(liveItem, lookup);
  const livePrice = itemUnitPrice(liveItem, lookup);
  const liveMargin = marginPct(liveCost, livePrice);

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        kind: form.kind,
        name: form.name,
        sku: form.sku,
        category: form.category,
        description: form.description,
        image: form.image,
        unit: form.unit,
        unitCost: Number(form.unitCost) || 0,
        markupPct: Number(form.markupPct) || 0,
        priceMode: form.priceMode,
        unitPrice: Number(form.unitPrice) || 0,
        taxable: form.taxable !== false,
        components: form.components ?? [],
      };
      if (isEdit) return api.catalog[":id"].$patch({ param: { id: row.id! }, json: payload as any });
      return api.catalog.$post({ json: payload as any });
    },
    onSuccess: onDone,
  });

  function set<K extends keyof Row>(k: K, v: Row[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function uploadImage(file: File) {
    let id = form.id;
    // need an item to attach the image to — create first if new
    if (!id) {
      const res = await api.catalog.$post({
        json: {
          kind: form.kind,
          name: form.name || "Untitled",
          sku: form.sku,
          category: form.category,
          description: form.description,
          unit: form.unit,
          unitCost: Number(form.unitCost) || 0,
          markupPct: Number(form.markupPct) || 0,
          priceMode: form.priceMode,
          unitPrice: Number(form.unitPrice) || 0,
          taxable: form.taxable !== false,
          components: form.components ?? [],
        } as any,
      });
      const created: any = await res.json();
      id = created.item?.id;
      setForm((f) => ({ ...f, id }));
    }
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch(`/api/catalog/${id}/image`, {
      method: "POST",
      headers: apiHeaders(),
      body: fd,
    });
    const j = await r.json();
    if (j.url) setForm((f) => ({ ...f, image: j.url }));
  }

  const isAssembly = form.kind === "assembly";
  const components = form.components ?? [];

  function addComponent(itemId: string) {
    if (components.some((c) => c.itemId === itemId)) return;
    set("components", [...components, { itemId, qty: 1 }] as AssemblyComponent[]);
  }
  function setComponentQty(itemId: string, qty: number) {
    set(
      "components",
      components.map((c) => (c.itemId === itemId ? { ...c, qty } : c)) as AssemblyComponent[]
    );
  }
  function removeComponent(itemId: string) {
    set("components", components.filter((c) => c.itemId !== itemId) as AssemblyComponent[]);
  }

  const componentChoices = allItems.filter((i) => i.kind !== "assembly" && i.id !== form.id);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
      {...dismiss(onClose)}
    >
      <DialogPanel onClose={onClose} label={isEdit ? `Edit ${form.kind}` : `New ${form.kind}`} className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl bg-ink-2 shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/5 px-5 py-4">
          <h3 className="font-bold text-white">
            {isEdit ? `Edit ${form.kind}` : `New ${form.kind}`}
          </h3>
          <button
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-white/5"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid flex-1 gap-4 overflow-y-auto p-5 md:grid-cols-2">
          {/* left column */}
          <div className="space-y-3">
            <Field label="Type">
              <div className="flex gap-2">
                {(["product", "service", "assembly"] as CatalogKind[]).map((k) => {
                  const M = KIND_META[k];
                  return (
                    <button
                      key={k}
                      onClick={() => set("kind", k)}
                      className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-semibold capitalize ${
                        form.kind === k ? "bg-brand text-white" : "bg-white/5 text-slate-300 hover:bg-white/10"
                      }`}
                    >
                      <M.icon className="h-3.5 w-3.5" /> {M.label}
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="Name">
              <input aria-label="e.g. Laminate Plank"
                value={form.name ?? ""}
                onChange={(e) => set("name", e.target.value)}
                className={inputCls}
                placeholder="e.g. Laminate Plank"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="SKU">
                <input aria-label="optional" value={form.sku ?? ""} onChange={(e) => set("sku", e.target.value)} className={inputCls} placeholder="optional" />
              </Field>
              <Field label="Category">
                <div className="flex gap-1.5">
                  <select aria-label="Category" value={form.category ?? ""} onChange={(e) => set("category", e.target.value)} className={inputCls}>
                    {/* keep an unknown legacy category selectable so editing never loses it */}
                    {form.category && !categoryOptions.includes(form.category) && (
                      <option value={form.category}>{form.category}</option>
                    )}
                    {categoryOptions.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <CategoryManagerButton label="" />
                </div>
              </Field>
            </div>
            <Field label="Unit">
              <select value={form.unit ?? "each"} onChange={(e) => set("unit", e.target.value)} className={inputCls}>
                {UNITS.map((u) => (
                  <option key={u}>{u}</option>
                ))}
              </select>
            </Field>
            <Field label="Description">
              <textarea aria-label="Description"
                value={form.description ?? ""}
                onChange={(e) => set("description", e.target.value)}
                rows={2}
                className={inputCls}
              />
            </Field>
            <Field label="Picture">
              <div className="flex items-center gap-3">
                {form.image ? (
                  <img src={form.image} alt="" className="h-14 w-14 rounded-lg object-cover" />
                ) : (
                  <div className="grid h-14 w-14 place-items-center rounded-lg bg-white/5 text-slate-600">
                    <Package className="h-5 w-5" />
                  </div>
                )}
                <input aria-label="File upload"
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    setUploading(true);
                    try {
                      await uploadImage(f);
                    } finally {
                      setUploading(false);
                    }
                  }}
                />
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-white/5 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-white/10 disabled:opacity-50"
                >
                  {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                  {uploading ? "Uploading…" : "Upload"}
                </button>
              </div>
            </Field>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input aria-label="Taxable"
                type="checkbox"
                checked={form.taxable !== false}
                onChange={(e) => set("taxable", e.target.checked)}
                className="h-4 w-4 rounded border-white/20 bg-ink-2"
              />
              Taxable
            </label>
          </div>

          {/* right column: pricing / assembly builder */}
          <div className="space-y-3">
            {!isAssembly && (
              <>
                <Field label="Unit cost ($)">
                  <input aria-label="Unit Cost"
                    type="number"
                    value={form.unitCost ?? 0}
                    onChange={(e) => set("unitCost", Number(e.target.value))}
                    className={inputCls}
                  />
                </Field>
                <Field label="Pricing">
                  <div className="flex rounded-lg bg-white/5 p-1">
                    {(["auto", "manual"] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => set("priceMode", m)}
                        className={`flex-1 rounded-md px-2 py-1.5 text-xs font-semibold capitalize ${
                          form.priceMode === m ? "bg-brand text-white" : "text-slate-400 hover:text-white"
                        }`}
                      >
                        {m === "auto" ? "Auto (markup)" : "Manual price"}
                      </button>
                    ))}
                  </div>
                </Field>
                {form.priceMode === "manual" ? (
                  <Field label="Unit price ($)">
                    <input aria-label="Unit Price"
                      type="number"
                      value={form.unitPrice ?? 0}
                      onChange={(e) => set("unitPrice", Number(e.target.value))}
                      className={inputCls}
                    />
                  </Field>
                ) : (
                  <Field label="Markup (%)">
                    <input aria-label="Markup Pct"
                      type="number"
                      value={form.markupPct ?? 0}
                      onChange={(e) => set("markupPct", Number(e.target.value))}
                      className={inputCls}
                    />
                  </Field>
                )}
              </>
            )}

            {isAssembly && (
              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-600">Components</div>
                <div className="space-y-2">
                  {components.map((c) => {
                    const it = lookup(c.itemId);
                    return (
                      <div key={c.itemId} className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-white">{it?.name ?? "Unknown"}</div>
                          <div className="text-[11px] text-slate-500">
                            {money(it ? itemUnitPrice(it, lookup) : 0)}/{it?.unit ?? "each"}
                          </div>
                        </div>
                        <input aria-label="Qty"
                          type="number"
                          value={c.qty}
                          min={0}
                          step="any"
                          onChange={(e) => setComponentQty(c.itemId, Number(e.target.value))}
                          className="w-16 rounded-md border border-white/10 bg-ink-2 px-2 py-1 text-sm outline-none focus:border-brand"
                        />
                        <button
                          onClick={() => removeComponent(c.itemId)}
                          className="grid h-7 w-7 place-items-center rounded-md text-slate-500 hover:bg-white/10 hover:text-red-400"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })}
                  {components.length === 0 && (
                    <div className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-xs text-slate-500">
                      Add products & services below.
                    </div>
                  )}
                </div>
                <select
                  value=""
                  onChange={(e) => e.target.value && addComponent(e.target.value)}
                  className={inputCls}
                >
                  <option value="">+ Add component…</option>
                  {componentChoices.map((i) => (
                    <option key={i.id} value={i.id}>
                      {KIND_META[i.kind].label}: {i.name}
                    </option>
                  ))}
                </select>
                <Field label="Override price (optional)">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => set("priceMode", form.priceMode === "manual" ? "auto" : "manual")}
                      className={`rounded-md px-2.5 py-1.5 text-xs font-semibold ${
                        form.priceMode === "manual" ? "bg-brand text-white" : "bg-white/5 text-slate-400"
                      }`}
                    >
                      {form.priceMode === "manual" ? "Manual" : "Roll-up"}
                    </button>
                    {form.priceMode === "manual" && (
                      <input aria-label="Override $"
                        type="number"
                        value={form.unitPrice ?? 0}
                        onChange={(e) => set("unitPrice", Number(e.target.value))}
                        className={inputCls}
                        placeholder="Override $"
                      />
                    )}
                  </div>
                </Field>
              </div>
            )}

            {/* live math */}
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">Cost</div>
                  <div className="font-bold text-white">{money(round2(liveCost))}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">Price</div>
                  <div className="font-bold text-white">{money(round2(livePrice))}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">Margin</div>
                  <div
                    className={`font-bold ${
                      liveMargin >= 30 ? "text-emerald-400" : liveMargin >= 10 ? "text-amber-400" : "text-red-400"
                    }`}
                  >
                    {liveMargin}%
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-white/5 px-5 py-4">
          <button onClick={onClose} className="rounded-full px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-white/5">
            Cancel
          </button>
          <button
            disabled={save.isPending || !form.name}
            onClick={() => save.mutate()}
            className="rounded-full bg-brand px-5 py-2 text-sm font-semibold text-white hover:bg-brand-deep disabled:opacity-50"
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </DialogPanel>
    </div>
  );
}

const inputCls =
  "w-full rounded-xl border border-white/10 bg-ink-2 px-3 py-2 text-sm outline-none focus:border-brand";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-slate-600">{label}</span>
      {children}
    </label>
  );
}
