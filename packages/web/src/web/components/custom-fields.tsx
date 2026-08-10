import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Field, inputCls, BtnPrimary } from "./modal";
import { SignaturePad } from "./signature-pad";
import { DollarSign, Save } from "lucide-react";

interface FieldDef {
  id: string;
  entity: string;
  label: string;
  type: string;
  options: string;
  placeholder: string;
  required: boolean;
  section: string;
}

/** Renders admin-defined custom fields for an entity and persists values. */
export function CustomFieldsForm({
  entity,
  entityType,
  entityId,
}: {
  entity: "client" | "tech" | "work_order";
  entityType: string;
  entityId: string;
}) {
  const qc = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);

  const fields = useQuery({
    queryKey: ["custom-fields", entity],
    queryFn: async () => (await api["custom-fields"].$get({ query: { entity } })).json(),
  });
  const stored = useQuery({
    queryKey: ["custom-field-values", entityType, entityId],
    queryFn: async () =>
      (await api["custom-fields"].values[":type"][":id"].$get({ param: { type: entityType, id: entityId } })).json(),
  });

  useEffect(() => {
    if (stored.data) setValues((stored.data as any).values ?? {});
  }, [stored.data]);

  const save = useMutation({
    mutationFn: async () => {
      await api["custom-fields"].values[":type"][":id"].$put({
        param: { type: entityType, id: entityId },
        json: { values },
      });
    },
    onSuccess: () => {
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["custom-field-values", entityType, entityId] });
    },
  });

  const defs: FieldDef[] = ((fields.data as any)?.fields ?? []).filter((f: any) => f.active !== false);
  if (defs.length === 0)
    return (
      <p className="rounded-lg border border-dashed border-white/10 px-3 py-6 text-center text-xs text-slate-600">
        No custom fields defined. Add them in Tags &amp; Fields.
      </p>
    );

  function set(id: string, v: string) {
    setValues((p) => ({ ...p, [id]: v }));
    setDirty(true);
  }

  // group by section
  const sections = [...new Set(defs.map((d) => d.section || "General"))];

  return (
    <div className="space-y-4">
      {sections.map((sec) => (
        <div key={sec} className="space-y-3">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{sec}</p>
          {defs
            .filter((d) => (d.section || "General") === sec)
            .map((d) => (
              <Field key={d.id} label={d.label + (d.required ? " *" : "")}>
                <FieldInput def={d} value={values[d.id] ?? ""} onChange={(v) => set(d.id, v)} />
              </Field>
            ))}
        </div>
      ))}
      <BtnPrimary disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
        <Save className="h-4 w-4" /> {save.isPending ? "Saving…" : "Save fields"}
      </BtnPrimary>
    </div>
  );
}

function FieldInput({
  def,
  value,
  onChange,
}: {
  def: FieldDef;
  value: string;
  onChange: (v: string) => void;
}) {
  // Defence in depth. The API now rejects a non-array `options`, but a row
  // written before that validation existed stored `"\"a,b,c\""`, and
  // `JSON.parse(...).map(...)` on it threw "o.map is not a function" — which
  // put this whole component (and the technician drawer that mounts it) behind
  // the error boundary. A malformed definition must degrade to "no choices",
  // never crash the screen.
  const opts: string[] = (() => {
    try {
      const parsed = JSON.parse(def.options || "[]");
      if (Array.isArray(parsed)) return parsed.map((o) => String(o));
      if (typeof parsed === "string" && parsed.trim())
        return parsed.split(",").map((s) => s.trim()).filter(Boolean);
      return [];
    } catch {
      return [];
    }
  })();

  switch (def.type) {
    case "textarea":
    case "note":
      return (
        <textarea aria-label={def.placeholder}
          className={inputCls}
          rows={3}
          value={value}
          placeholder={def.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "number":
      return (
        <input aria-label={def.placeholder}
          type="number"
          className={inputCls}
          value={value}
          placeholder={def.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "date":
      return <input aria-label="Value" type="date" className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} />;
    case "select":
      return (
        <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Select…</option>
          {opts.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      );
    case "checkbox":
      return (
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input aria-label="Value"
            type="checkbox"
            checked={value === "true"}
            onChange={(e) => onChange(e.target.checked ? "true" : "false")}
            className="h-4 w-4 rounded border-white/20 bg-ink-3 text-brand"
          />
          Yes
        </label>
      );
    case "signature":
      return <SignaturePad value={value} onChange={onChange} />;
    case "payment":
      return (
        <div className="relative">
          <DollarSign className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-emerald-live" />
          <input aria-label="0.00"
            type="number"
            step="0.01"
            className={`${inputCls} pl-9`}
            value={value}
            placeholder="0.00"
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );
    default:
      return (
        <input aria-label={def.placeholder}
          className={inputCls}
          value={value}
          placeholder={def.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}
