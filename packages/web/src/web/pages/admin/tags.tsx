import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { InferRequestType } from "hono/client";

/** Form shapes sourced from the routes, so a bad scope/entity can't compile. */
type TagForm = InferRequestType<typeof api.tags.$post>["json"];
type FieldEntity = InferRequestType<typeof api["custom-fields"]["$post"]>["json"]["entity"];
type FieldType = NonNullable<InferRequestType<typeof api["custom-fields"]["$post"]>["json"]["type"]>;
import { FullLoader } from "../../components/loader";
import { PageWrap } from "../../components/brand";
import { PageHead } from "./shell";
import { Modal, Field, inputCls, BtnPrimary, BtnGhost, ConfirmModal } from "../../components/modal";
import { Plus, Trash2, Tag as TagIcon, ListPlus, GripVertical } from "lucide-react";
import { useWorkerNoun, useCustomerNoun, useJobNoun } from "../../lib/use-brand";

const SCOPES: Array<NonNullable<TagForm["scope"]>> = ["both", "client", "tech"];
const ENTITIES: Array<{ id: FieldEntity; label: string }> = [
  { id: "client", label: "Clients" },
  { id: "tech", label: "Technicians" },
  { id: "work_order", label: "Work Orders" },
];
const FIELD_TYPES: FieldType[] = [
  "text", "textarea", "number", "date", "select", "checkbox", "file", "signature", "payment", "note",
];

export default function AdminTags() {
  const qc = useQueryClient();
  const { nounPlural } = useWorkerNoun();
  const { nounPlural: customerNounPlural } = useCustomerNoun();
  const { nounPlural: jobNounPlural } = useJobNoun();
  const entityLabel = (id: string) => (id === "tech" ? nounPlural : id === "client" ? customerNounPlural : id === "work_order" ? jobNounPlural : ENTITIES.find((e) => e.id === id)?.label ?? id);
  const [tagModal, setTagModal] = useState(false);
  const [tagForm, setTagForm] = useState<TagForm>({ label: "", color: "#06B6D4", scope: "both" });
  const [delTag, setDelTag] = useState<string | null>(null);

  const [entity, setEntity] = useState<FieldEntity>("client");
  const [fieldModal, setFieldModal] = useState(false);
  const [fieldForm, setFieldForm] = useState<{
    label: string;
    type: FieldType;
    section: string;
    placeholder: string;
    required: boolean;
    /** Comma-separated in the form; split into an array before submit. */
    options: string;
  }>({
    label: "", type: "text", section: "General", placeholder: "", required: false, options: "",
  });
  const [delField, setDelField] = useState<string | null>(null);

  const tags = useQuery({ queryKey: ["tags", "all"], queryFn: async () => (await api.tags.$get()).json() });
  const fields = useQuery({
    queryKey: ["custom-fields", entity],
    queryFn: async () => (await api["custom-fields"].$get({ query: { entity } })).json(),
  });

  const createTag = useMutation({
    mutationFn: async () => (await api.tags.$post({ json: tagForm })).json(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tags"] });
      setTagModal(false);
      setTagForm({ label: "", color: "#06B6D4", scope: "both" });
    },
  });
  const removeTag = useMutation({
    mutationFn: async (id: string) => api.tags[":id"].$delete({ param: { id } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["tags"] }); setDelTag(null); },
  });

  const createField = useMutation({
    mutationFn: async () => {
      const opts = fieldForm.type === "select"
        ? fieldForm.options.split(",").map((s) => s.trim()).filter(Boolean) : [];
      return (await api["custom-fields"].$post({
        json: { ...fieldForm, entity, options: opts },
      })).json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["custom-fields", entity] });
      setFieldModal(false);
      setFieldForm({ label: "", type: "text", section: "General", placeholder: "", required: false, options: "" });
    },
  });
  const removeField = useMutation({
    mutationFn: async (id: string) => api["custom-fields"][":id"].$delete({ param: { id } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["custom-fields", entity] }); setDelField(null); },
  });

  if (tags.isLoading) return <FullLoader label="Loading…" />;
  const tagList = (tags.data as any)?.tags ?? [];
  const fieldList = (fields.data as any)?.fields ?? [];

  return (
    <PageWrap>
      <PageHead title="Tags & Custom Fields" subtitle={`Customize what you collect from clients & ${nounPlural.toLowerCase()}`} />

      <div className="grid gap-5 lg:grid-cols-2">
        {/* TAGS */}
        <div className="nvc-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="flex items-center gap-2 font-bold text-white">
              <TagIcon className="h-4 w-4 text-brand" /> Tags
            </h3>
            <BtnPrimary onClick={() => setTagModal(true)}><Plus className="h-4 w-4" /> New tag</BtnPrimary>
          </div>
          {tagList.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-600">No tags yet.</p>
          ) : (
            <ul className="space-y-2">
              {tagList.map((t: any) => (
                <li key={t.id} className="flex items-center gap-3 rounded-lg border border-white/5 bg-ink-3/40 px-3 py-2">
                  <span className="h-3 w-3 rounded-full" style={{ background: t.color }} />
                  <span className="font-semibold text-white">{t.label}</span>
                  <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] capitalize text-slate-400">{t.scope}</span>
                  <button onClick={() => setDelTag(t.id)} aria-label={`Delete tag ${t.label}`} title={`Delete tag ${t.label}`} className="ml-auto grid h-7 w-7 place-items-center rounded-lg text-slate-600 hover:bg-red-500/10 hover:text-red-400">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* CUSTOM FIELDS */}
        <div className="nvc-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="flex items-center gap-2 font-bold text-white">
              <ListPlus className="h-4 w-4 text-brand" /> Custom Fields
            </h3>
            <BtnPrimary onClick={() => setFieldModal(true)}><Plus className="h-4 w-4" /> New field</BtnPrimary>
          </div>
          <div className="mb-3 flex gap-1.5">
            {ENTITIES.map((e) => (
              <button key={e.id} onClick={() => setEntity(e.id)}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${entity === e.id ? "bg-brand text-white" : "bg-ink-2 text-slate-400 hover:bg-white/5"}`}>
                {entityLabel(e.id)}
              </button>
            ))}
          </div>
          {fieldList.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-600">No custom fields for this record type.</p>
          ) : (
            <ul className="space-y-2">
              {fieldList.map((f: any) => (
                <li key={f.id} className="flex items-center gap-3 rounded-lg border border-white/5 bg-ink-3/40 px-3 py-2">
                  <GripVertical className="h-4 w-4 text-slate-700" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-white">{f.label}{f.required && <span className="text-red-400"> *</span>}</p>
                    <p className="text-[11px] text-slate-500">{f.section} · {f.type}</p>
                  </div>
                  <button onClick={() => setDelField(f.id)} className="grid h-7 w-7 place-items-center rounded-lg text-slate-600 hover:bg-red-500/10 hover:text-red-400">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Tag modal */}
      <Modal open={tagModal} onClose={() => setTagModal(false)} title="New tag"
        footer={<><BtnGhost onClick={() => setTagModal(false)}>Cancel</BtnGhost>
          <BtnPrimary disabled={!tagForm.label || createTag.isPending} onClick={() => createTag.mutate()}>Create</BtnPrimary></>}>
        <div className="space-y-3">
          <Field label="Label"><input aria-label="VIP, Net-30, Recurring…" className={inputCls} value={tagForm.label} onChange={(e) => setTagForm({ ...tagForm, label: e.target.value })} placeholder="VIP, Net-30, Recurring…" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Color">
              <div className="flex items-center gap-2">
                <input aria-label="Color" type="color" value={tagForm.color} onChange={(e) => setTagForm({ ...tagForm, color: e.target.value })} className="h-9 w-12 rounded border border-white/10 bg-transparent" />
                <input aria-label="Color" className={inputCls} value={tagForm.color} onChange={(e) => setTagForm({ ...tagForm, color: e.target.value })} />
              </div>
            </Field>
            <Field label="Applies to">
              <select className={inputCls} value={tagForm.scope} onChange={(e) => setTagForm({ ...tagForm, scope: e.target.value as TagForm["scope"] })}>
                {SCOPES.map((s) => <option key={s} value={s}>{s === "both" ? "Both" : s === "client" ? customerNounPlural : nounPlural}</option>)}
              </select>
            </Field>
          </div>
        </div>
      </Modal>

      {/* Field modal */}
      <Modal open={fieldModal} onClose={() => setFieldModal(false)} title="New custom field"
        subtitle={`For ${entityLabel(entity)}`}
        footer={<><BtnGhost onClick={() => setFieldModal(false)}>Cancel</BtnGhost>
          <BtnPrimary disabled={!fieldForm.label || createField.isPending} onClick={() => createField.mutate()}>Add field</BtnPrimary></>}>
        <div className="space-y-3">
          <Field label="Field label"><input aria-label="Gate code, Allergy notes…" className={inputCls} value={fieldForm.label} onChange={(e) => setFieldForm({ ...fieldForm, label: e.target.value })} placeholder="Gate code, Allergy notes…" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">
              <select className={inputCls} value={fieldForm.type} onChange={(e) => setFieldForm({ ...fieldForm, type: e.target.value as FieldType })}>
                {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Section"><input aria-label="General" className={inputCls} value={fieldForm.section} onChange={(e) => setFieldForm({ ...fieldForm, section: e.target.value })} placeholder="General" /></Field>
          </div>
          {fieldForm.type === "select" && (
            <Field label="Options (comma separated)"><input aria-label="Small, Medium, Large" className={inputCls} value={fieldForm.options} onChange={(e) => setFieldForm({ ...fieldForm, options: e.target.value })} placeholder="Small, Medium, Large" /></Field>
          )}
          <Field label="Placeholder"><input aria-label="Placeholder" className={inputCls} value={fieldForm.placeholder} onChange={(e) => setFieldForm({ ...fieldForm, placeholder: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input aria-label="Required" type="checkbox" checked={fieldForm.required} onChange={(e) => setFieldForm({ ...fieldForm, required: e.target.checked })} className="h-4 w-4 rounded border-white/20 bg-ink-3 text-brand" />
            Required field
          </label>
        </div>
      </Modal>

      <ConfirmModal open={!!delTag} onClose={() => setDelTag(null)} onConfirm={() => delTag && removeTag.mutate(delTag)} title="Delete tag" message="This removes the tag from all records." pending={removeTag.isPending} />
      <ConfirmModal open={!!delField} onClose={() => setDelField(null)} onConfirm={() => delField && removeField.mutate(delField)} title="Delete field" message="This removes the field and its stored values." pending={removeField.isPending} />
    </PageWrap>
  );
}
