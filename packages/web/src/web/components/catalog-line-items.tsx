// ─── Catalog line-item picker ────────────────────────────────────────────────
// Shared between the admin New Work Order modal (work-order-modal.tsx) and
// the public, PIN-gated employee work-order form (pages/work-order-form.tsx)
// so a job priced from either place uses identical UI + math (cost/margin).

import { useState } from "react";
import { Plus, Search, X, Package, Wrench, Layers } from "lucide-react";
import { money } from "../lib/utils";
import { sumLineItems, itemUnitPrice, type CatalogItem, type LineItem } from "../../shared/catalog";

export const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  service: Wrench,
  product: Package,
  assembly: Layers,
};

export function CatalogLineItems({
  items,
  lineItems,
  lookup,
  onAdd,
  onQty,
  onRemove,
}: {
  items: CatalogItem[];
  lineItems: LineItem[];
  lookup: (id: string) => CatalogItem | undefined;
  onAdd: (item: CatalogItem, qty: number) => void;
  onQty: (itemId: string, qty: number) => void;
  onRemove: (itemId: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState("");

  const totals = sumLineItems(lineItems);
  const filtered = items.filter((i) => {
    if (!q) return true;
    const s = q.toLowerCase();
    return (
      i.name.toLowerCase().includes(s) ||
      i.sku.toLowerCase().includes(s) ||
      i.category.toLowerCase().includes(s)
    );
  });

  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-white">Products & materials</p>
          <p className="text-xs text-slate-500">
            Add catalog items (parts, materials, fixed services, assemblies).
          </p>
        </div>
        <button
          type="button"
          onClick={() => setPicking((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-deep"
        >
          <Plus className="h-3.5 w-3.5" /> Add from catalog
        </button>
      </div>

      {picking && (
        <div className="mb-3 rounded-lg border border-white/10 bg-ink-2 p-2">
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              aria-label="Search catalog"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search catalog…"
              className="w-full rounded-md border border-white/10 bg-ink px-2.5 py-1.5 pl-8 text-sm outline-none focus:border-brand"
            />
          </div>
          <div className="max-h-52 space-y-1 overflow-y-auto">
            {filtered.map((i) => {
              const Icon = KIND_ICON[i.kind] ?? Package;
              const price = itemUnitPrice(i, lookup);
              return (
                <button
                  type="button"
                  key={i.id}
                  onClick={() => {
                    onAdd(i, 1);
                    setPicking(false);
                    setQ("");
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-white/5"
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-200">{i.name}</span>
                  <span className="shrink-0 text-xs text-slate-500">
                    {money(price)}/{i.unit}
                  </span>
                </button>
              );
            })}
            {filtered.length === 0 && (
              <p className="px-2 py-3 text-center text-xs text-slate-500">No items found.</p>
            )}
          </div>
        </div>
      )}

      {lineItems.length === 0 ? (
        <p className="text-xs text-slate-500">No items added.</p>
      ) : (
        <div className="space-y-1.5">
          {lineItems.map((li) => {
            const Icon = KIND_ICON[li.kind] ?? Package;
            return (
              <div key={li.itemId} className="rounded-lg bg-white/5 px-3 py-2">
                <div className="flex items-center gap-2">
                  <Icon className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-white">{li.name}</div>
                    <div className="text-[11px] text-slate-500">
                      {money(li.unitPrice)}/{li.unit}
                      {!li.taxable && <span className="ml-1 text-slate-600">· no tax</span>}
                    </div>
                  </div>
                  <input
                    aria-label={`Quantity for ${li.name}`}
                    type="number"
                    min={0}
                    step="any"
                    value={li.qty}
                    inputMode="decimal"
                    onChange={(e) => {
                      const v = e.target.value;
                      onQty(li.itemId, v === "" ? 0 : Math.max(0, Number(v) || 0));
                    }}
                    className="w-16 rounded-md border border-white/10 bg-ink-2 px-2 py-1 text-sm outline-none focus:border-brand"
                  />
                  <span className="w-20 shrink-0 text-right text-sm font-semibold text-white">
                    {money(li.price)}
                  </span>
                  <button
                    type="button"
                    onClick={() => onRemove(li.itemId)}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-slate-500 hover:bg-white/10 hover:text-red-400"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                {li.components && li.components.length > 0 && (
                  <div className="mt-1.5 space-y-0.5 border-l border-white/10 pl-4">
                    {li.components.map((c, idx) => (
                      <div key={idx} className="flex justify-between text-[11px] text-slate-500">
                        <span>
                          {c.name} × {c.qty} {c.unit}
                        </span>
                        <span>{money(c.unitPrice * c.qty)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <div className="flex items-center justify-between border-t border-white/10 pt-2 text-xs">
            <span className="text-slate-400">
              {lineItems.length} item{lineItems.length > 1 ? "s" : ""} · cost {money(totals.cost)}
            </span>
            <span className="text-emerald-400">
              {money(totals.price)} · {totals.marginPct}% margin
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
