import { useRef, useState } from "react";
import { StoredImage } from "./stored-image";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, apiHeaders } from "../lib/api";
import { FileText, ImageIcon, Upload, Trash2, Loader2, Download } from "lucide-react";

interface Attachment {
  id: string;
  filename: string;
  url: string;
  mime: string;
  size: number;
  label: string;
  uploadedBy: string;
  createdAt: string;
}

const fmtSize = (b: number) =>
  b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`;

const LABELS = ["Driver License", "Safety Certification", "Insurance", "Photo", "Contract", "Other"];

export function AttachmentManager({
  entityType,
  entityId,
}: {
  entityType: "client" | "tech" | "work_order";
  entityId: string;
}) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState("Other");
  const [err, setErr] = useState("");

  const list = useQuery({
    queryKey: ["attachments", entityType, entityId],
    queryFn: async () =>
      (await api.uploads[":type"][":id"].$get({ param: { type: entityType, id: entityId } })).json(),
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("entityType", entityType);
      fd.append("entityId", entityId);
      fd.append("label", label);
      const res = await fetch("/api/uploads", {
        method: "POST",
        headers: apiHeaders(),
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Upload failed");
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["attachments", entityType, entityId] });
      setErr("");
    },
    onError: (e: any) => setErr(e.message),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      await api.uploads[":id"].$delete({ param: { id } });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["attachments", entityType, entityId] }),
  });

  const files: Attachment[] = (list.data as any)?.attachments ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="rounded-lg border border-white/10 bg-ink-3/60 px-2 py-1.5 text-xs text-slate-300 focus:border-brand focus:outline-none"
        >
          {LABELS.map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={upload.isPending}
          className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-white/5 disabled:opacity-50"
        >
          {upload.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          Upload file
        </button>
        <input aria-label="File upload"
          ref={fileRef}
          type="file"
          accept="image/*,application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload.mutate(f);
            e.target.value = "";
          }}
        />
        <span className="text-[11px] text-slate-600">JPG, PNG, PDF · max 15MB</span>
      </div>
      {err && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{err}</p>}

      {files.length === 0 ? (
        <p className="rounded-lg border border-dashed border-white/10 px-3 py-6 text-center text-xs text-slate-600">
          No files attached yet.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {files.map((f) => {
            const isImg = f.mime.startsWith("image/");
            return (
              <li
                key={f.id}
                className="flex items-center gap-3 rounded-lg border border-white/5 bg-ink-3/40 px-3 py-2"
              >
                {isImg ? (
                  <a href={f.url} target="_blank" rel="noreferrer" aria-label={`Open ${f.filename}`}>
                    <StoredImage
                      src={f.url}
                      className="h-9 w-9 rounded object-cover"
                      fallback={
                        <span className="grid h-9 w-9 place-items-center rounded bg-brand/10 text-brand">
                          <ImageIcon className="h-4 w-4" />
                        </span>
                      }
                    />
                  </a>
                ) : (
                  <span className="grid h-9 w-9 place-items-center rounded bg-brand/10 text-brand">
                    {isImg ? <ImageIcon className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-white">{f.filename}</p>
                  <p className="text-[11px] text-slate-500">
                    {f.label} · {fmtSize(f.size)}
                  </p>
                </div>
                <a
                  href={f.url}
                  target="_blank"
                  rel="noreferrer"
                  className="grid h-7 w-7 place-items-center rounded-lg text-slate-500 hover:bg-white/5 hover:text-white"
                >
                  <Download className="h-3.5 w-3.5" />
                </a>
                <button
                  onClick={() => del.mutate(f.id)}
                  className="grid h-7 w-7 place-items-center rounded-lg text-slate-600 hover:bg-red-500/10 hover:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
