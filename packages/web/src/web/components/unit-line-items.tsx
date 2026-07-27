// ─── Ad-hoc per-unit line items (charge + tech pay) ──────────────────────────
// Shared between the admin New Work Order modal (work-order-modal.tsx) and
// the public, PIN-gated employee work-order form (pages/work-order-form.tsx)
// so a job priced from either place uses identical UI + math, including the
// tech-pay-per-unit rate (e.g. $6.00/sq-yd charge to client, $3.50/sq-yd pay
// to the tech — set charge to $0 for a pay-only line).

import { Plus, Ruler, X } from "lucide-react";
import { money } from "../lib/utils";
import type { LineItem } from "../../shared/catalog";

export const UNIT_OPTIONS = ["sq/ft", "sq/yd", "linear ft", "piece", "each", "hour"];

export function UnitLineItems({
  lines,
  workerNoun,
  onAdd,
  onChange,
  onRemove,
}: {
  lines: LineItem[];
  workerNoun: string;
  onAdd: () => void;
  onChange: (
    itemId: string,
    patch: Partial<{ name: string; unit: string; qty: number; unitPrice: number; unitPayRate: number; taxable: boolean }>,
  ) => void;
  onRemove: (itemId: string) => void;
}) {
  const totalCharge = lines.reduce((s, l) => s + (l.price || 0), 0);
  const totalPay = lines.reduce((s, l) => s + (l.cost || 0), 0);

  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-semibold text-white">
            <Ruler className="h-4 w-4 text-brand" /> Per-unit line items
          </p>
          <p className="text-xs text-slate-500">
            Charge the client and pay the {workerNoun.toLowerCase()} by measured unit
            (e.g. $6.00/sq-yd carpet install). Set charge to $0 for a pay-only line.
          </p>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-deep"
        >
          <Plus className="h-3.5 w-3.5" /> Add line
        </button>
      </div>

      {lines.length === 0 ? (
        <p className="text-xs text-slate-500">No per-unit lines added.</p>
      ) : (
        <div className="space-y-2">
          {/* header (sm+) */}
          <div className="hidden gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 sm:grid sm:grid-cols-[1fr_80px_52px_82px_82px_72px_24px]">
            <span>Description</span>
            <span>Unit</span>
            <span className="text-right">Qty</span>
            <span className="text-right">Charge/unit</span>
            <span className="text-right">Pay/unit</span>
            <span className="text-right">Line</span>
            <span />
          </div>

          {lines.map((l) => {
            const lineCharge = l.price || 0;
            const linePay = l.cost || 0;
            const customUnit = !UNIT_OPTIONS.includes(l.unit);
            return (
              <div
                key={l.itemId}
                className="grid grid-cols-2 gap-1.5 rounded-lg bg-white/5 p-2 sm:grid-cols-[1fr_80px_52px_82px_82px_72px_24px] sm:items-center sm:bg-transparent sm:p-1"
              >
                {/* description */}
                <input
                  aria-label="Line description"
                  value={l.name}
                  onChange={(e) => onChange(l.itemId, { name: e.target.value })}
                  placeholder="e.g. LVP install"
                  className="col-span-2 rounded-md border border-white/10 bg-ink-2 px-2 py-1.5 text-sm outline-none focus:border-brand sm:col-span-1"
                />

                {/* unit */}
                <div className="flex flex-col gap-1">
                  <select
                    aria-label="Unit"
                    value={customUnit ? "__custom__" : l.unit}
                    onChange={(e) => {
                      const v = e.target.value;
                      onChange(l.itemId, { unit: v === "__custom__" ? "" : v });
                    }}
                    className="rounded-md border border-white/10 bg-ink-2 px-1.5 py-1.5 text-xs outline-none focus:border-brand"
                  >
                    {UNIT_OPTIONS.map((u) => (
                      <option key={u} value={u}>{u}</option>
                    ))}
                    <option value="__custom__">Custom…</option>
                  </select>
                  {customUnit && (
                    <input
                      aria-label="Custom unit"
                      value={l.unit}
                      onChange={(e) => onChange(l.itemId, { unit: e.target.value })}
                      placeholder="unit"
                      className="rounded-md border border-white/10 bg-ink-2 px-1.5 py-1 text-xs outline-none focus:border-brand"
                    />
                  )}
                </div>

                {/* qty */}
                <input
                  aria-label="Quantity"
                  type="number"
                  min={0}
                  step="any"
                  inputMode="decimal"
                  value={l.qty}
                  onChange={(e) =>
                    onChange(l.itemId, { qty: e.target.value === "" ? 0 : Math.max(0, Number(e.target.value) || 0) })
                  }
                  className="rounded-md border border-white/10 bg-ink-2 px-2 py-1.5 text-right text-sm outline-none focus:border-brand"
                />

                {/* charge per unit */}
                <div className="relative">
                  <span aria-hidden className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-slate-500">$</span>
                  <input
                    aria-label="Charge per unit"
                    type="number"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    value={l.unitPrice}
                    onChange={(e) => onChange(l.itemId, { unitPrice: Math.max(0, Number(e.target.value) || 0) })}
                    className="w-full rounded-md border border-white/10 bg-ink-2 py-1.5 pl-5 pr-1.5 text-right text-sm outline-none focus:border-brand"
                  />
                </div>

                {/* pay per unit */}
                <div className="relative">
                  <span aria-hidden className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-amber-500/70">$</span>
                  <input
                    aria-label="Pay per unit"
                    type="number"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    value={l.unitCost}
                    onChange={(e) => onChange(l.itemId, { unitPayRate: Math.max(0, Number(e.target.value) || 0) })}
                    className="w-full rounded-md border border-white/10 bg-ink-2 py-1.5 pl-5 pr-1.5 text-right text-sm text-amber-300 outline-none focus:border-brand"
                  />
                </div>

                {/* line totals */}
                <div className="text-right text-sm leading-tight">
                  <div className="font-semibold text-white">{money(lineCharge)}</div>
                  <div className="text-[11px] text-amber-400">pay {money(linePay)}</div>
                </div>

                {/* remove */}
                <button
                  type="button"
                  aria-label="Remove line"
                  onClick={() => onRemove(l.itemId)}
                  className="grid h-7 w-7 shrink-0 place-items-center justify-self-end rounded-md text-slate-500 hover:bg-white/10 hover:text-red-400"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}

          <div className="flex items-center justify-between border-t border-white/10 pt-2 text-xs">
            <span className="text-slate-400">
              {lines.length} line{lines.length > 1 ? "s" : ""}
            </span>
            <span className="flex gap-3">
              <span className="text-white">charge {money(totalCharge)}</span>
              <span className="text-amber-400">{workerNoun.toLowerCase()} pay {money(totalPay)}</span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
