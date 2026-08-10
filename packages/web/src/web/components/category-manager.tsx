/**
 * Shared category manager — a single, editable list of work-order/product
 * categories used by BOTH the Form Builder template "Category" dropdown and
 * the Product Catalog item "Category" field. Backed by /api/catalog/categories,
 * seeded once from the tenant's industry preset, editable from here forever
 * after. Rendered as a small trigger button + modal so it can be dropped next
 * to any category <select> without disrupting that page's layout.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Modal, inputCls, BtnGhost, ConfirmModal } from "./modal";
import { Settings2, Plus, Trash2, Pencil, Check, X, GripVertical } from "lucide-react";

export interface CategoryRow { id: string; name: string; sortOrder: number }

/** Small "Manage" trigger + the modal itself. Drop next to any category <select>. */
export function CategoryManagerButton({ label = "Manage" }: { label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-white/10 bg-ink-3/60 px-2 py-2 text-[11px] font-semibold text-slate-400 hover:border-brand/40 hover:text-cyan-glow"
        title="Add, rename, or remove categories"
      >
        <Settings2 className="h-3.5 w-3.5" /> {label}
      </button>
      {open && <CategoryManagerModal onClose={() => setOpen(false)} />}
    </>
  );
}

export function CategoryManagerModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["form-categories"],
    queryFn: async () => (await api.catalog.categories.$get()).json(),
  });
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [delRow, setDelRow] = useState<CategoryRow | null>(null);
  const [delError, setDelError] = useState("");

  const invalidateEverywhere = () => {
    qc.invalidateQueries({ queryKey: ["form-categories"] });
    qc.invalidateQueries({ queryKey: ["catalog"] });
    qc.invalidateQueries({ queryKey: ["catalog-categories"] });
    qc.invalidateQueries({ queryKey: ["templates"] });
  };

  const create = useMutation({
    mutationFn: async (name: string) => {
      const res = await api.catalog.categories.$post({ json: { name } });
      const j = await res.json();
      if (!res.ok) throw new Error((j as any).message || "Failed to add category");
      return j;
    },
    onSuccess: () => { setNewName(""); setError(""); invalidateEverywhere(); },
    onError: (e: any) => setError(e.message || "Failed to add category"),
  });

  const rename = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) =>
      (await api.catalog.categories[":id"].$patch({ param: { id }, json: { name } })).json(),
    onSuccess: () => { setEditingId(null); invalidateEverywhere(); },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.catalog.categories[":id"].$delete({ param: { id } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((j as any).message || "Failed to delete category");
      return j;
    },
    onSuccess: () => { setDelRow(null); setDelError(""); invalidateEverywhere(); },
    onError: (e: any) => setDelError(e.message || "Failed to delete category"),
  });

  const categories: CategoryRow[] = (list.data as any)?.categories ?? [];

  return (
    <Modal open onClose={onClose} title="Manage categories" subtitle="Shared by Form Builder templates and the Product Catalog">
      <div className="space-y-3">
        <div className="flex gap-2">
          <input
            aria-label="New category name"
            className={inputCls}
            value={newName}
            onChange={(e) => { setNewName(e.target.value); setError(""); }}
            placeholder="e.g. Seasonal Maintenance"
            onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) create.mutate(newName.trim()); }}
          />
          <button
            type="button"
            disabled={!newName.trim() || create.isPending}
            onClick={() => create.mutate(newName.trim())}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white hover:bg-brand-deep disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}

        {list.isLoading ? (
          <p className="py-6 text-center text-xs text-slate-500">Loading…</p>
        ) : categories.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-600">No categories yet.</p>
        ) : (
          <div className="max-h-80 space-y-1.5 overflow-y-auto">
            {categories.map((cat) => (
              <div key={cat.id} className="flex items-center gap-2 rounded-lg border border-white/10 bg-ink-3/50 px-2.5 py-2">
                <GripVertical className="h-3.5 w-3.5 shrink-0 text-slate-700" />
                {editingId === cat.id ? (
                  <>
                    <input
                      aria-label="Rename category"
                      // deliberate focus management: this input only exists after the user clicks Rename, so moving focus into it is expected, not a surprise page-load focus grab.
                      // eslint-disable-next-line jsx-a11y/no-autofocus
                      autoFocus
                      className="min-w-0 flex-1 rounded-md border border-brand/40 bg-ink px-2 py-1 text-sm text-white outline-none"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && editValue.trim()) rename.mutate({ id: cat.id, name: editValue.trim() }); if (e.key === "Escape") setEditingId(null); }}
                    />
                    <button type="button" aria-label="Save category name" onClick={() => editValue.trim() && rename.mutate({ id: cat.id, name: editValue.trim() })} className="shrink-0 rounded-md p-1 text-emerald-400 hover:bg-white/5"><Check className="h-4 w-4" /></button>
                    <button type="button" aria-label="Cancel rename" onClick={() => setEditingId(null)} className="shrink-0 rounded-md p-1 text-slate-500 hover:bg-white/5"><X className="h-4 w-4" /></button>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-sm text-white">{cat.name}</span>
                    <button type="button" aria-label={`Rename ${cat.name}`} onClick={() => { setEditingId(cat.id); setEditValue(cat.name); }} className="shrink-0 rounded-md p-1 text-slate-500 hover:bg-white/5 hover:text-white"><Pencil className="h-3.5 w-3.5" /></button>
                    <button type="button" aria-label={`Delete ${cat.name}`} onClick={() => { setDelRow(cat); setDelError(""); }} className="shrink-0 rounded-md p-1 text-slate-500 hover:bg-red-500/10 hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end pt-1">
          <BtnGhost onClick={onClose}>Done</BtnGhost>
        </div>
      </div>

      <ConfirmModal
        open={!!delRow}
        onClose={() => setDelRow(null)}
        onConfirm={() => delRow && remove.mutate(delRow.id)}
        title="Delete category?"
        message={delError || `"${delRow?.name}" will be removed from the shared list. This is blocked if any catalog item or template still uses it.`}
        confirmLabel="Delete"
        pending={remove.isPending}
        danger
      />
    </Modal>
  );
}
