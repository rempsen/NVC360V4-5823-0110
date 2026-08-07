// ─── Admin: Options/Tier Catalog ───────────────────────────────────────────
// Build reusable option categories (e.g. "Flooring", "Garage Door Model")
// each with 2+ tiers carrying a price delta (e.g. Good/Better/Best). These
// get attached to any booking via its public selections link (/s/:token —
// same token already used for live tracking) so the customer can pick a
// tier and e-sign. See routes/option-catalog.ts + routes/option-selections.ts.
import { useState } from "react";
import { ApiError } from "../../lib/api-error";
import { useConfirm } from "../../components/confirm-dialog";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiHeaders } from "../../lib/api";
import { FullLoader } from "../../components/loader";
import { money } from "../../lib/utils";
import { Plus, X, Trash2, ChevronDown, ChevronRight, Star, TrendingUp } from "lucide-react";

type OptionItem = {
  id: string;
  categoryId: string;
  tierLabel: string;
  name: string;
  description: string;
  priceDelta: number;
  unitCost: number;
  isDefault: boolean;
  sortOrder: number;
  active: boolean;
};

type OptionCategory = {
  id: string;
  name: string;
  description: string;
  sortOrder: number;
  active: boolean;
  items: OptionItem[];
};

type AttachRateRow = {
  categoryId: string;
  categoryName: string;
  totalSelections: number;
  upgradeSelections: number;
  attachRatePct: number;
  incrementalRevenue: number;
};

async function jget(url: string) {
  const res = await fetch(url, { headers: apiHeaders() });
  if (!res.ok) throw new Error(`GET ${url} failed`);
  return res.json();
}
async function jsend(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...apiHeaders() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const msg = await res.json().catch(() => ({}));
    // Throw the same ApiError the typed client throws, so the global mutation
    // error handler can map the status to a proper message.
    throw new ApiError({
      status: res.status,
      message: (msg as { message?: string }).message || `${method} ${url} failed`,
      body: msg,
    });
  }
  return res.json();
}

const EMPTY_ITEM = { tierLabel: "", name: "", description: "", priceDelta: 0, unitCost: 0, isDefault: false };

export default function AdminOptionsCatalog() {
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [newCategoryName, setNewCategoryName] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [addingItemFor, setAddingItemFor] = useState<string | null>(null);
  const [itemDraft, setItemDraft] = useState(EMPTY_ITEM);
  const [showAttachRate, setShowAttachRate] = useState(false);

  const categories = useQuery({
    queryKey: ["option-categories"],
    queryFn: async () => (await jget("/api/option-catalog/categories")).categories as OptionCategory[],
  });

  const attachRate = useQuery({
    queryKey: ["option-attach-rate"],
    queryFn: async () => jget("/api/option-catalog/attach-rate") as Promise<{ report: AttachRateRow[]; summary: any }>,
    enabled: showAttachRate,
  });

  const createCategory = useMutation({
    mutationFn: (name: string) => jsend("/api/option-catalog/categories", "POST", { name }),
    onSuccess: () => {
      setNewCategoryName("");
      qc.invalidateQueries({ queryKey: ["option-categories"] });
    },
    // No onError needed: the global MutationCache handler toasts every failure.
  });

  const deleteCategory = useMutation({
    mutationFn: (id: string) => jsend(`/api/option-catalog/categories/${id}`, "DELETE"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["option-categories"] }),
  });

  const addItem = useMutation({
    mutationFn: ({ categoryId, item }: { categoryId: string; item: typeof EMPTY_ITEM }) =>
      jsend(`/api/option-catalog/categories/${categoryId}/items`, "POST", item),
    onSuccess: () => {
      setAddingItemFor(null);
      setItemDraft(EMPTY_ITEM);
      qc.invalidateQueries({ queryKey: ["option-categories"] });
    },
  });

  const deleteItem = useMutation({
    mutationFn: ({ categoryId, itemId }: { categoryId: string; itemId: string }) =>
      jsend(`/api/option-catalog/categories/${categoryId}/items/${itemId}`, "DELETE"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["option-categories"] }),
  });

  const setDefault = useMutation({
    mutationFn: ({ categoryId, itemId }: { categoryId: string; itemId: string }) =>
      jsend(`/api/option-catalog/categories/${categoryId}/items/${itemId}`, "PATCH", { isDefault: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["option-categories"] }),
  });

  if (categories.isLoading) return <FullLoader label="Loading options catalog…" />;
  const cats = categories.data ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-extrabold text-white">Options & Tiers</h1>
          <p className="text-sm text-slate-400">
            Good/Better/Best pricing tiers customers pick from on their selections link — the
            proven Karma/Glendale upgrade-pricing engine, generalized for any job.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowAttachRate((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-white/10"
        >
          <TrendingUp className="h-3.5 w-3.5" /> {showAttachRate ? "Hide" : "Show"} attach-rate report
        </button>
      </div>

      {showAttachRate && (
        <div className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
          {attachRate.isLoading ? (
            <div className="p-4 text-sm text-slate-500">Loading…</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2.5">Category</th>
                  <th className="px-4 py-2.5">Selections</th>
                  <th className="px-4 py-2.5">Upgrade rate</th>
                  <th className="px-4 py-2.5">Incremental revenue</th>
                </tr>
              </thead>
              <tbody>
                {(attachRate.data?.report ?? []).map((r) => (
                  <tr key={r.categoryId} className="border-b border-white/5 last:border-0">
                    <td className="px-4 py-2.5 font-medium text-white">{r.categoryName}</td>
                    <td className="px-4 py-2.5 text-slate-300">{r.totalSelections}</td>
                    <td className="px-4 py-2.5 text-slate-300">
                      {r.upgradeSelections}/{r.totalSelections} ({r.attachRatePct}%)
                    </td>
                    <td className="px-4 py-2.5 text-emerald-400">{money(r.incrementalRevenue)}</td>
                  </tr>
                ))}
                {(attachRate.data?.report ?? []).length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-slate-500">
                      No selections recorded yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <div className="flex items-center gap-2">
          <input
            aria-label="New category name"
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            placeholder="New category name (e.g. Flooring, Paint Grade, Garage Door Model)…"
            className="flex-1 rounded-md border border-white/10 bg-ink px-3 py-2 text-sm outline-none focus:border-brand"
            onKeyDown={(e) => {
              if (e.key === "Enter" && newCategoryName.trim()) createCategory.mutate(newCategoryName.trim());
            }}
          />
          <button
            type="button"
            disabled={!newCategoryName.trim() || createCategory.isPending}
            onClick={() => createCategory.mutate(newCategoryName.trim())}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white hover:bg-brand-deep disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" /> Add category
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {cats.map((cat) => {
          const isOpen = expanded.has(cat.id);
          return (
            <div key={cat.id} className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
              <button
                type="button"
                onClick={() =>
                  setExpanded((s) => {
                    const next = new Set(s);
                    if (next.has(cat.id)) next.delete(cat.id);
                    else next.add(cat.id);
                    return next;
                  })
                }
                className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-white/5"
              >
                <div className="flex items-center gap-2">
                  {isOpen ? <ChevronDown className="h-4 w-4 text-slate-500" /> : <ChevronRight className="h-4 w-4 text-slate-500" />}
                  <span className="text-sm font-semibold text-white">{cat.name}</span>
                  <span className="text-xs text-slate-500">
                    {cat.items.length} tier{cat.items.length !== 1 ? "s" : ""}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (await confirm({ title: `Delete category "${cat.name}"?`, message: "All of its tiers will be deleted too. This can't be undone." }))
                      deleteCategory.mutate(cat.id);
                  }}
                  className="grid h-7 w-7 place-items-center rounded-md text-slate-500 hover:bg-white/10 hover:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </button>

              {isOpen && (
                <div className="space-y-2 border-t border-white/10 p-4">
                  {cat.items.map((it) => (
                    <div key={it.id} className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2">
                      <button
                        type="button"
                        title={it.isDefault ? "Default (included) tier" : "Set as default (included) tier"}
                        onClick={() => setDefault.mutate({ categoryId: cat.id, itemId: it.id })}
                        className={`grid h-6 w-6 shrink-0 place-items-center rounded-full ${it.isDefault ? "text-amber-400" : "text-slate-600 hover:text-amber-300"}`}
                      >
                        <Star className="h-3.5 w-3.5" fill={it.isDefault ? "currentColor" : "none"} />
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-white">
                          {it.tierLabel && <span className="mr-1.5 rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">{it.tierLabel}</span>}
                          {it.name}
                        </div>
                        {it.description && <div className="truncate text-[11px] text-slate-500">{it.description}</div>}
                      </div>
                      <span className="shrink-0 text-sm font-semibold text-white">
                        {it.priceDelta === 0 ? "Included" : `+${money(it.priceDelta)}`}
                      </span>
                      <button
                        type="button"
                        onClick={() => deleteItem.mutate({ categoryId: cat.id, itemId: it.id })}
                        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-slate-500 hover:bg-white/10 hover:text-red-400"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}

                  {addingItemFor === cat.id ? (
                    <div className="space-y-2 rounded-lg border border-white/10 bg-ink-2 p-3">
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          aria-label="Tier label"
                          value={itemDraft.tierLabel}
                          onChange={(e) => setItemDraft((d) => ({ ...d, tierLabel: e.target.value }))}
                          placeholder="Tier label (Good/Better/Best)"
                          className="rounded-md border border-white/10 bg-ink px-2.5 py-1.5 text-sm outline-none focus:border-brand"
                        />
                        <input
                          aria-label="Option name"
                          value={itemDraft.name}
                          onChange={(e) => setItemDraft((d) => ({ ...d, name: e.target.value }))}
                          placeholder="Option name (e.g. Luxury Vinyl Plank)"
                          className="rounded-md border border-white/10 bg-ink px-2.5 py-1.5 text-sm outline-none focus:border-brand"
                        />
                      </div>
                      <input
                        aria-label="Description"
                        value={itemDraft.description}
                        onChange={(e) => setItemDraft((d) => ({ ...d, description: e.target.value }))}
                        placeholder="Description shown to the customer (optional)"
                        className="w-full rounded-md border border-white/10 bg-ink px-2.5 py-1.5 text-sm outline-none focus:border-brand"
                      />
                      <div className="flex items-center gap-2">
                        <label htmlFor="opt-price-delta" className="text-xs text-slate-400">Price delta</label>
                        <input
                          id="opt-price-delta"
                          aria-label="Price delta"
                          type="number"
                          step="any"
                          value={itemDraft.priceDelta}
                          onChange={(e) => setItemDraft((d) => ({ ...d, priceDelta: Number(e.target.value) || 0 }))}
                          className="w-28 rounded-md border border-white/10 bg-ink px-2.5 py-1.5 text-sm outline-none focus:border-brand"
                        />
                        <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-400">
                          <input
                            type="checkbox"
                            aria-label="Default (included) tier"
                            checked={itemDraft.isDefault}
                            onChange={(e) => setItemDraft((d) => ({ ...d, isDefault: e.target.checked }))}
                          />
                          Default (included) tier
                        </label>
                      </div>
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => { setAddingItemFor(null); setItemDraft(EMPTY_ITEM); }}
                          className="rounded-md px-3 py-1.5 text-xs text-slate-400 hover:bg-white/5"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={!itemDraft.name.trim() || addItem.isPending}
                          onClick={() => addItem.mutate({ categoryId: cat.id, item: itemDraft })}
                          className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-deep disabled:opacity-50"
                        >
                          Save tier
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setAddingItemFor(cat.id)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-white/15 px-3 py-1.5 text-xs text-slate-400 hover:border-brand hover:text-brand"
                    >
                      <Plus className="h-3.5 w-3.5" /> Add tier
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {cats.length === 0 && (
          <p className="rounded-xl border border-dashed border-white/10 p-6 text-center text-sm text-slate-500">
            No option categories yet. Add one above — e.g. "Flooring" with Good/Better/Best
            tiers — then send customers their selections link (find it on any work order) to
            let them pick a tier and e-sign.
          </p>
        )}
      </div>
    </div>
  );
}
