import { useState, useEffect, useRef, useCallback } from "react";
import { activate, dismiss } from "../lib/utils";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, apiHeaders } from "../lib/api";
import { inputCls, BtnPrimary, BtnGhost } from "./modal";
import {
  Type, AlignLeft, MousePointerClick, Image as ImageIcon, Minus, MoveVertical,
  Table, Trash2, ChevronUp, ChevronDown, Plus, Eye, Send, Save, BookMarked,
  X, Smartphone, Monitor, Sparkles, GripVertical, Bold, Italic, Link as LinkIcon,
  ImagePlus,
} from "lucide-react";
import { useWorkerNoun, useCustomerNoun } from "../lib/use-brand";

/* ---------------- types (mirror services/email-render.ts) ---------------- */
export type EmailBlock =
  | { id: string; type: "heading"; text: string; align?: "left" | "center" | "right"; size?: "sm" | "md" | "lg" }
  | { id: string; type: "text"; text: string; align?: "left" | "center" | "right" }
  | { id: string; type: "button"; label: string; url: string; align?: "left" | "center" | "right" }
  | { id: string; type: "image"; url: string; alt?: string; width?: number; align?: "left" | "center" | "right" }
  | { id: string; type: "divider" }
  | { id: string; type: "spacer"; size?: "sm" | "md" | "lg" }
  | { id: string; type: "details"; rows: { label: string; value: string }[] };

const uid = () => Math.random().toString(36).slice(2, 9);

const TOKENS = [
  { key: "firstName", label: "Customer name" },
  { key: "company", label: "Company" },
  { key: "jobName", label: "Job name" },
  { key: "jobNumber", label: "Job #" },
  { key: "service", label: "Service" },
  { key: "techName", label: "Technician" },
  { key: "address", label: "Address" },
  { key: "when", label: "Date/time" },
  { key: "price", label: "Price" },
  { key: "trackUrl", label: "Tracking link" },
];

const BLOCK_TYPES: { type: EmailBlock["type"]; label: string; icon: any; make: () => EmailBlock }[] = [
  { type: "heading", label: "Heading", icon: Type, make: () => ({ id: uid(), type: "heading", text: "Your heading here", size: "lg", align: "left" }) },
  { type: "text", label: "Text", icon: AlignLeft, make: () => ({ id: uid(), type: "text", text: "Write your message here. Use **bold**, *italic*, and [links](https://example.com).", align: "left" }) },
  { type: "button", label: "Button", icon: MousePointerClick, make: () => ({ id: uid(), type: "button", label: "View details", url: "{{trackUrl}}", align: "left" }) },
  { type: "image", label: "Image", icon: ImageIcon, make: () => ({ id: uid(), type: "image", url: "", alt: "", align: "center" }) },
  { type: "details", label: "Detail table", icon: Table, make: () => ({ id: uid(), type: "details", rows: [{ label: "Service", value: "{{service}}" }, { label: "When", value: "{{when}}" }] }) },
  { type: "divider", label: "Divider", icon: Minus, make: () => ({ id: uid(), type: "divider" }) },
  { type: "spacer", label: "Spacer", icon: MoveVertical, make: () => ({ id: uid(), type: "spacer", size: "md" }) },
];

function ensureIds(design: any[]): EmailBlock[] {
  return (design || []).map((b) => ({ ...b, id: b.id || uid() }));
}

/* ---------------- main editor ---------------- */
export function EmailEditor({
  initialDesign,
  initialSubject,
  onSave,
  saving,
  onClose,
  contextLabel,
}: {
  initialDesign: EmailBlock[];
  initialSubject: string;
  onSave: (subject: string, design: EmailBlock[]) => void;
  saving?: boolean;
  onClose: () => void;
  contextLabel?: string;
}) {
  const [blocks, setBlocks] = useState<EmailBlock[]>(() => ensureIds(initialDesign));
  const [subject, setSubject] = useState(initialSubject || "");
  const [selected, setSelected] = useState<string | null>(blocks[0]?.id ?? null);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [preview, setPreview] = useState<string>("");
  const [showLibrary, setShowLibrary] = useState(false);
  const [showSaveTpl, setShowSaveTpl] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const qc = useQueryClient();

  const render = useMutation({
    mutationFn: async (design: EmailBlock[]) => (await api["notif-config"].email.render.$post({ json: { design } })).json(),
    onSuccess: (d: any) => setPreview(d.html),
  });

  // debounced live preview
  const tRef = useRef<any>(null);
  useEffect(() => {
    clearTimeout(tRef.current);
    tRef.current = setTimeout(() => render.mutate(blocks), 350);
    return () => clearTimeout(tRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(blocks)]);

  const update = useCallback((id: string, patch: any) => {
    setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }, []);
  const remove = (id: string) => setBlocks((bs) => bs.filter((b) => b.id !== id));
  const move = (id: string, dir: -1 | 1) => {
    setBlocks((bs) => {
      const i = bs.findIndex((b) => b.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= bs.length) return bs;
      const copy = [...bs];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  };
  const add = (mk: () => EmailBlock) => {
    const b = mk();
    setBlocks((bs) => {
      const i = selected ? bs.findIndex((x) => x.id === selected) : bs.length - 1;
      const copy = [...bs];
      copy.splice(i + 1, 0, b);
      return copy;
    });
    setSelected(b.id);
  };

  const sendTest = useMutation({
    mutationFn: async () => (await api["notif-config"].email.test.$post({ json: { to: testTo, subject, design: blocks } })).json(),
    onSuccess: (d: any) => setTestMsg(d.ok ? "Test email sent ✓" : d.skipped ? "Email isn't configured (no RESEND_API_KEY)." : `Failed: ${d.error || "unknown"}`),
  });

  const saveTpl = useMutation({
    mutationFn: async (meta: { name: string; description: string }) =>
      (await api["notif-config"].email.templates.$post({ json: { ...meta, subject, design: blocks } })).json(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["email-templates"] }); setShowSaveTpl(false); },
  });

  const selBlock = blocks.find((b) => b.id === selected) || null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-ink">
      {/* top bar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-white/10 bg-ink-2 px-5 py-3">
        <div className="flex items-center gap-2 text-white">
          <Sparkles className="h-5 w-5 text-cyan-glow" />
          <span className="font-bold">Email Designer</span>
          {contextLabel && <span className="rounded-md bg-white/5 px-2 py-0.5 text-xs text-slate-400">{contextLabel}</span>}
        </div>
        <div className="flex-1" />
        <button onClick={() => setShowLibrary(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-ink px-3 py-1.5 text-xs font-semibold text-slate-300 hover:text-cyan-glow">
          <BookMarked className="h-3.5 w-3.5" /> Templates
        </button>
        <button onClick={() => setShowSaveTpl(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-ink px-3 py-1.5 text-xs font-semibold text-slate-300 hover:text-cyan-glow">
          <Save className="h-3.5 w-3.5" /> Save as template
        </button>
        <BtnPrimary onClick={() => onSave(subject, blocks)} disabled={saving}>
          {saving ? "Saving…" : "Save & apply"}
        </BtnPrimary>
        <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* LEFT: block list + add palette */}
        <div className="flex w-72 shrink-0 flex-col border-r border-white/10 bg-ink-2">
          <div className="border-b border-white/5 p-3">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Subject line</div>
            <input aria-label="e.g. {{company}}: your job update" className={`${inputCls} text-sm`} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. {{company}}: your job update" />
          </div>
          <HeaderLogoPanel onChange={() => render.mutate(blocks)} />
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Blocks</div>
            <div className="space-y-1.5">
              {blocks.map((b, i) => {
                const meta = BLOCK_TYPES.find((t) => t.type === b.type);
                const Icon = meta?.icon ?? Type;
                return (
                  <div
                    key={b.id}
                    {...activate(() => setSelected(b.id))}
                    aria-label={`Edit ${b.type} block`}
                    className={`group flex items-center gap-2 rounded-lg border px-2.5 py-2 text-sm cursor-pointer transition ${
                      selected === b.id ? "border-brand/50 bg-brand/10 text-white" : "border-white/5 bg-ink text-slate-400 hover:text-white hover:border-white/10"
                    }`}
                  >
                    <GripVertical className="h-3.5 w-3.5 shrink-0 text-slate-600" />
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="flex-1 truncate text-xs font-medium capitalize">{b.type}</span>
                    <button onClick={(e) => { e.stopPropagation(); move(b.id, -1); }} disabled={i === 0} className="opacity-0 group-hover:opacity-100 disabled:opacity-0 text-slate-500 hover:text-white"><ChevronUp className="h-3.5 w-3.5" /></button>
                    <button onClick={(e) => { e.stopPropagation(); move(b.id, 1); }} disabled={i === blocks.length - 1} className="opacity-0 group-hover:opacity-100 disabled:opacity-0 text-slate-500 hover:text-white"><ChevronDown className="h-3.5 w-3.5" /></button>
                    <button onClick={(e) => { e.stopPropagation(); remove(b.id); }} className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                );
              })}
              {blocks.length === 0 && <p className="rounded-lg border border-dashed border-white/10 p-4 text-center text-xs text-slate-500">Empty email. Add a block below.</p>}
            </div>
          </div>
          <div className="border-t border-white/5 p-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Add block</div>
            <div className="grid grid-cols-2 gap-1.5">
              {BLOCK_TYPES.map((t) => (
                <button key={t.type} onClick={() => add(t.make)} className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-ink px-2.5 py-2 text-xs font-semibold text-slate-300 hover:border-brand/40 hover:text-cyan-glow">
                  <t.icon className="h-3.5 w-3.5" /> {t.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* CENTER: live preview */}
        <div className="flex min-w-0 flex-1 flex-col bg-[#0a0f1c]">
          <div className="flex items-center gap-2 border-b border-white/5 px-4 py-2">
            <Eye className="h-4 w-4 text-slate-500" />
            <span className="text-xs font-semibold text-slate-400">Live preview (sample data)</span>
            <div className="flex-1" />
            <div className="flex rounded-lg border border-white/10 bg-ink p-0.5">
              <button onClick={() => setDevice("desktop")} className={`grid h-7 w-8 place-items-center rounded-md ${device === "desktop" ? "bg-brand/20 text-cyan-glow" : "text-slate-500"}`}><Monitor className="h-4 w-4" /></button>
              <button onClick={() => setDevice("mobile")} className={`grid h-7 w-8 place-items-center rounded-md ${device === "mobile" ? "bg-brand/20 text-cyan-glow" : "text-slate-500"}`}><Smartphone className="h-4 w-4" /></button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className={`mx-auto transition-all ${device === "mobile" ? "max-w-[380px]" : "max-w-[640px]"}`}>
              <div className="overflow-hidden rounded-xl border border-white/10 bg-white shadow-2xl">
                <iframe title="email-preview" srcDoc={preview} className="h-[70vh] w-full border-0" />
              </div>
            </div>
          </div>
          {/* test send bar */}
          <div className="flex flex-wrap items-center gap-2 border-t border-white/5 bg-ink-2 px-4 py-2.5">
            <Send className="h-4 w-4 text-slate-500" />
            <input aria-label="you@email.com" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@email.com" className={`${inputCls} h-9 max-w-[240px] text-sm`} />
            <button onClick={() => sendTest.mutate()} disabled={!testTo || sendTest.isPending} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-ink px-3 py-2 text-xs font-semibold text-slate-300 hover:text-cyan-glow disabled:opacity-40">
              {sendTest.isPending ? "Sending…" : "Send test"}
            </button>
            {testMsg && <span className={`text-xs ${testMsg.includes("✓") ? "text-green-400" : "text-amber-400"}`}>{testMsg}</span>}
          </div>
        </div>

        {/* RIGHT: inspector */}
        <div className="w-80 shrink-0 overflow-y-auto border-l border-white/10 bg-ink-2 p-4">
          {selBlock ? (
            <BlockInspector block={selBlock} onChange={(patch) => update(selBlock.id, patch)} />
          ) : (
            <p className="text-sm text-slate-500">Select a block to edit it.</p>
          )}
        </div>
      </div>

      {showLibrary && <TemplateLibrary onPick={(d, s) => { setBlocks(ensureIds(d)); if (s) setSubject(s); setShowLibrary(false); }} onClose={() => setShowLibrary(false)} />}
      {showSaveTpl && <SaveTemplateModal onSave={(name, description) => saveTpl.mutate({ name, description })} saving={saveTpl.isPending} onClose={() => setShowSaveTpl(false)} />}
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Header logo — separate from body blocks on purpose.
 *
 * This is the logo shown in the colored header bar at the very top of every
 * branded email (see renderEmailDesign's brandMark in email-render.ts). It is
 * saved once on the tenant's notification channel config (emailLogoUrl) and
 * then automatically applied to every email this company sends — the header,
 * the Email Designer, and the raw event templates all read the same value.
 * No need to drop an Image block into the body to get a logo at the top.
 * -------------------------------------------------------------------------- */
function HeaderLogoPanel({ onChange }: { onChange: () => void }) {
  const qc = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const cfg = useQuery({
    queryKey: ["notif-channels"],
    queryFn: async () => (await api["notif-config"].channels.$get()).json(),
  });
  const logo = (cfg.data as any)?.channels?.emailLogoUrl || "";

  const saveLogo = useMutation({
    mutationFn: async (emailLogoUrl: string) => (await api["notif-config"].channels.$patch({ json: { emailLogoUrl } })).json(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["notif-channels"] }); onChange(); },
  });

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/notif-config/email/logo", { method: "POST", body: fd, credentials: "include", headers: apiHeaders() });
      const d = await res.json();
      // /email/logo already persists it on the channel config server-side —
      // just refresh our local view so the panel + live preview pick it up.
      if (d.url) { qc.invalidateQueries({ queryKey: ["notif-channels"] }); onChange(); }
    } finally { setUploading(false); }
  };

  return (
    <div className="border-b border-white/5 p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <ImagePlus className="h-3 w-3" /> Header logo
      </div>
      <p className="mb-2 text-[10px] leading-relaxed text-slate-600">
        Shown at the top of every email this company sends. Upload once — saved on this tenant, no need to re-add it per template.
      </p>
      <div className="flex items-center gap-2 rounded-lg border border-white/5 bg-ink p-2">
        <div className="grid h-11 w-16 shrink-0 place-items-center rounded-md bg-white/90 p-1">
          {logo ? <img src={logo} alt="header logo" className="max-h-9 max-w-full object-contain" /> : <span className="text-[9px] text-slate-400">None</span>}
        </div>
        <div className="flex-1 space-y-1">
          <button onClick={() => fileRef.current?.click()} disabled={uploading} className="w-full rounded-md bg-brand px-2 py-1.5 text-[11px] font-bold text-white hover:bg-brand-deep disabled:opacity-50">
            {uploading ? "Uploading…" : "Upload logo"}
          </button>
          {logo && (
            <button onClick={() => saveLogo.mutate("")} className="w-full rounded-md border border-white/10 text-[10px] font-semibold text-slate-400 hover:text-red-400">
              Remove
            </button>
          )}
        </div>
      </div>
      <input aria-label="File upload" ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      <div className="mt-1.5 flex gap-1">
        <input
          aria-label="…or paste a logo URL"
          className={`${inputCls} text-xs`}
          value={urlDraft}
          onChange={(e) => setUrlDraft(e.target.value)}
          placeholder="…or paste a logo URL"
        />
        <button
          onClick={() => { if (urlDraft.trim()) { saveLogo.mutate(urlDraft.trim()); setUrlDraft(""); } }}
          disabled={!urlDraft.trim() || saveLogo.isPending}
          className="shrink-0 rounded-lg border border-white/10 bg-ink px-2.5 text-xs font-semibold text-slate-300 hover:text-cyan-glow disabled:opacity-40"
        >
          Set
        </button>
      </div>
    </div>
  );
}

/* ---------------- token inserter ---------------- */
function TokenRow({ onInsert }: { onInsert: (k: string) => void }) {
  const { noun } = useWorkerNoun();
  const { noun: customerNoun } = useCustomerNoun();
  const tokenLabel = (t: { key: string; label: string }) =>
    t.key === "techName" ? noun
    : t.key === "firstName" ? `${customerNoun} name`
    : t.label;
  return (
    <div className="mb-2 flex flex-wrap gap-1">
      {TOKENS.map((t) => (
        <button key={t.key} onClick={() => onInsert(`{{${t.key}}}`)} title={tokenLabel(t)} className="rounded-md border border-white/10 bg-ink px-1.5 py-0.5 text-[10px] font-mono text-slate-400 hover:border-brand/40 hover:text-cyan-glow">
          {t.key}
        </button>
      ))}
    </div>
  );
}

/* ---------------- markdown text editor with formatting toolbar ---------------- */
function RichTextArea({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const wrap = (before: string, after: string, placeholder: string) => {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart, end = el.selectionEnd;
    const sel = value.slice(start, end) || placeholder;
    const next = value.slice(0, start) + before + sel + after + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = start + before.length;
      el.selectionEnd = start + before.length + sel.length;
    });
  };
  const tools: { icon: any; label: string; fn: () => void }[] = [
    { icon: Bold, label: "Bold", fn: () => wrap("**", "**", "bold text") },
    { icon: Italic, label: "Italic", fn: () => wrap("*", "*", "italic text") },
    { icon: LinkIcon, label: "Link", fn: () => wrap("[", "](https://)", "link text") },
  ];
  return (
    <div className="overflow-hidden rounded-lg border border-white/10 bg-ink focus-within:border-brand/50">
      <div className="flex items-center gap-0.5 border-b border-white/5 bg-ink-2/60 px-1.5 py-1">
        {tools.map((t) => (
          <button key={t.label} type="button" aria-label={t.label} onMouseDown={(e) => { e.preventDefault(); t.fn(); }} title={t.label}
            className="grid h-7 w-7 place-items-center rounded text-slate-400 hover:bg-white/5 hover:text-cyan-glow">
            <t.icon className="h-3.5 w-3.5" />
          </button>
        ))}
        <span className="ml-auto pr-1.5 text-[10px] text-slate-600">select text, then format</span>
      </div>
      <textarea aria-label="Value" ref={ref} rows={5} value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full resize-y bg-transparent px-3 py-2 text-sm text-white placeholder-slate-600 outline-none" />
    </div>
  );
}

/* ---------------- per-block inspector ---------------- */
function BlockInspector({ block, onChange }: { block: EmailBlock; onChange: (patch: any) => void }) {
  const AlignButtons = (
    <div className="flex gap-1">
      {(["left", "center", "right"] as const).map((a) => (
        <button key={a} onClick={() => onChange({ align: a })} className={`flex-1 rounded-md border px-2 py-1 text-[11px] font-semibold capitalize ${(block as any).align === a ? "border-brand/50 bg-brand/15 text-cyan-glow" : "border-white/10 bg-ink text-slate-400"}`}>{a}</button>
      ))}
    </div>
  );
  const lbl = "mb-1.5 mt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500";

  return (
    <div>
      <div className="mb-3 text-sm font-bold capitalize text-white">{block.type} block</div>

      {block.type === "heading" && (
        <>
          <div className={lbl}>Text</div>
          <TokenRow onInsert={(k) => onChange({ text: (block.text || "") + " " + k })} />
          <textarea aria-label="Text" rows={2} className={inputCls} value={block.text} onChange={(e) => onChange({ text: e.target.value })} />
          <div className={lbl}>Size</div>
          <div className="flex gap-1">
            {(["sm", "md", "lg"] as const).map((s) => (
              <button key={s} onClick={() => onChange({ size: s })} className={`flex-1 rounded-md border px-2 py-1 text-[11px] font-semibold uppercase ${block.size === s ? "border-brand/50 bg-brand/15 text-cyan-glow" : "border-white/10 bg-ink text-slate-400"}`}>{s}</button>
            ))}
          </div>
          <div className={lbl}>Align</div>
          {AlignButtons}
        </>
      )}

      {block.type === "text" && (
        <>
          <div className={lbl}>Body</div>
          <TokenRow onInsert={(k) => onChange({ text: (block.text || "") + " " + k })} />
          <RichTextArea value={block.text} onChange={(text) => onChange({ text })} />
          <div className={lbl}>Align</div>
          {AlignButtons}
        </>
      )}

      {block.type === "button" && (
        <>
          <div className={lbl}>Label</div>
          <input aria-label="Label" className={inputCls} value={block.label} onChange={(e) => onChange({ label: e.target.value })} />
          <div className={lbl}>Link URL</div>
          <TokenRow onInsert={(k) => onChange({ url: k })} />
          <input aria-label="https://… or {{trackUrl}}" className={inputCls} value={block.url} onChange={(e) => onChange({ url: e.target.value })} placeholder="https://… or {{trackUrl}}" />
          <div className={lbl}>Align</div>
          {AlignButtons}
        </>
      )}

      {block.type === "image" && (
        <>
          <div className={lbl}>Image</div>
          <ImagePicker url={block.url} onChange={(url) => onChange({ url })} />
          <div className={lbl}>Alt text</div>
          <input aria-label="Alt" className={inputCls} value={block.alt || ""} onChange={(e) => onChange({ alt: e.target.value })} />
          <div className={lbl}>Width (px, blank = full)</div>
          <input aria-label="auto" type="number" className={inputCls} value={block.width || ""} onChange={(e) => onChange({ width: e.target.value ? Number(e.target.value) : undefined })} placeholder="auto" />
          <div className={lbl}>Align</div>
          {AlignButtons}
        </>
      )}

      {block.type === "spacer" && (
        <>
          <div className={lbl}>Height</div>
          <div className="flex gap-1">
            {(["sm", "md", "lg"] as const).map((s) => (
              <button key={s} onClick={() => onChange({ size: s })} className={`flex-1 rounded-md border px-2 py-1 text-[11px] font-semibold uppercase ${block.size === s ? "border-brand/50 bg-brand/15 text-cyan-glow" : "border-white/10 bg-ink text-slate-400"}`}>{s}</button>
            ))}
          </div>
        </>
      )}

      {block.type === "divider" && <p className="text-xs text-slate-500">A horizontal line. No options.</p>}

      {block.type === "details" && <DetailsEditor block={block} onChange={onChange} />}
    </div>
  );
}

function DetailsEditor({ block, onChange }: { block: Extract<EmailBlock, { type: "details" }>; onChange: (patch: any) => void }) {
  const rows = block.rows || [];
  const set = (i: number, key: "label" | "value", v: string) => {
    const next = rows.map((r, idx) => (idx === i ? { ...r, [key]: v } : r));
    onChange({ rows: next });
  };
  return (
    <>
      <div className="mb-1.5 mt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Rows</div>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="rounded-lg border border-white/5 bg-ink p-2">
            <div className="flex gap-1.5">
              <input aria-label="Label" className={`${inputCls} h-8 text-xs`} value={r.label} onChange={(e) => set(i, "label", e.target.value)} placeholder="Label" />
              <button onClick={() => onChange({ rows: rows.filter((_, idx) => idx !== i) })} className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-slate-500 hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
            <input aria-label="Value or {{token}}" className={`${inputCls} mt-1.5 h-8 text-xs`} value={r.value} onChange={(e) => set(i, "value", e.target.value)} placeholder="Value or {{token}}" />
          </div>
        ))}
      </div>
      <button onClick={() => onChange({ rows: [...rows, { label: "", value: "" }] })} className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-ink px-3 py-1.5 text-xs font-semibold text-slate-300 hover:text-cyan-glow">
        <Plus className="h-3.5 w-3.5" /> Add row
      </button>
    </>
  );
}

/* ---------------- image picker (upload or URL) ---------------- */
function ImagePicker({ url, onChange }: { url: string; onChange: (url: string) => void }) {
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = async (f: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch("/api/notif-config/email/logo", { method: "POST", body: fd, credentials: "include", headers: apiHeaders() });
      const d = await res.json();
      if (d.url) onChange(d.url);
    } finally { setUploading(false); }
  };
  return (
    <div>
      {url && <img src={url} alt="" className="mb-2 max-h-24 rounded-lg border border-white/10 bg-white object-contain p-1" />}
      <div className="flex gap-1.5">
        <button onClick={() => fileRef.current?.click()} className="flex-1 rounded-lg border border-white/10 bg-ink px-3 py-2 text-xs font-semibold text-slate-300 hover:text-cyan-glow">{uploading ? "Uploading…" : "Upload"}</button>
        {url && <button onClick={() => onChange("")} className="rounded-lg border border-white/10 bg-ink px-3 py-2 text-xs font-semibold text-slate-400 hover:text-red-400">Clear</button>}
      </div>
      <input aria-label="…or paste image URL" className={`${inputCls} mt-1.5 text-xs`} value={url} onChange={(e) => onChange(e.target.value)} placeholder="…or paste image URL" />
      <input aria-label="File upload" ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
    </div>
  );
}

/* ---------------- template library ---------------- */
function TemplateLibrary({ onPick, onClose }: { onPick: (design: any[], subject?: string) => void; onClose: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["email-templates"], queryFn: async () => (await api["notif-config"].email.templates.$get()).json() });
  const del = useMutation({
    mutationFn: async (id: string) => (await api["notif-config"].email.templates[":id"].$delete({ param: { id } })).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["email-templates"] }),
  });
  const templates = (list.data as any)?.templates ?? [];
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-6" {...dismiss(onClose)}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" aria-hidden="true" />
      <div className="relative max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-white/10 bg-ink-2 p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-bold text-white">Template library</h3>
          <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white"><X className="h-5 w-5" /></button>
        </div>
        {list.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : (
          <div className="grid gap-2.5 sm:grid-cols-2">
            {templates.map((t: any) => (
              <div key={t.id} className="group flex flex-col rounded-xl border border-white/5 bg-ink p-4 hover:border-brand/40">
                <div className="mb-1 flex items-center gap-2">
                  <span className="font-semibold text-white">{t.name}</span>
                  {t.isBuiltin ? <span className="rounded bg-brand/15 px-1.5 py-0.5 text-[10px] font-bold text-cyan-glow">BUILT-IN</span> : null}
                </div>
                <p className="flex-1 text-xs text-slate-500">{t.description || "—"}</p>
                <div className="mt-3 flex items-center gap-2">
                  <button onClick={() => onPick(JSON.parse(t.design || "[]"), t.subject)} className="flex-1 rounded-lg bg-brand px-3 py-1.5 text-xs font-bold text-white hover:bg-brand-deep">Use this</button>
                  {!t.isBuiltin && <button onClick={() => del.mutate(t.id)} className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:text-red-400"><Trash2 className="h-4 w-4" /></button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SaveTemplateModal({ onSave, saving, onClose }: { onSave: (name: string, description: string) => void; saving?: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-6" {...dismiss(onClose)}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" aria-hidden="true" />
      <div className="relative w-full max-w-md rounded-2xl border border-white/10 bg-ink-2 p-6 shadow-2xl">
        <h3 className="mb-4 text-lg font-bold text-white">Save as reusable template</h3>
        <div className="space-y-3">
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Name</div>
            <input aria-label="e.g. Winter promo" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Winter promo"  />
          </div>
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Description</div>
            <input aria-label="Optional" className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <BtnGhost onClick={onClose}>Cancel</BtnGhost>
            <BtnPrimary onClick={() => onSave(name || "Untitled template", description)} disabled={saving}>{saving ? "Saving…" : "Save template"}</BtnPrimary>
          </div>
        </div>
      </div>
    </div>
  );
}
