import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, apiHeaders } from "../../lib/api";
import { useAuth } from "../../hooks/use-auth";
import { FullLoader } from "../../components/loader";
import { PageWrap } from "../../components/brand";
import { PageHead } from "./shell";
import { Modal } from "../../components/modal";
import { RefreshCw, Check, Plug, Link2Off, Settings, Copy, AlertTriangle, Clock, ShieldCheck, Save, Trash2, Eye, EyeOff, UploadCloud, ExternalLink } from "lucide-react";
import { useWorkerNoun, useCustomerNoun } from "../../lib/use-brand";
import { BrandIcon } from "../../components/brand-icons";

const CATEGORY_ORDER = ["Accounting", "Email", "Calendar", "File Storage", "Photos", "Productivity", "Service"];

export default function IntegrationsPage() {
  const qc = useQueryClient();
  const { role } = useAuth();
  const isOwner = role === "superadmin";
  const [connecting, setConnecting] = useState<string | null>(null);
  const [comingSoon, setComingSoon] = useState<any>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [driveExport, setDriveExport] = useState(false);

  const list = useQuery({
    queryKey: ["integrations"],
    queryFn: async () => (await api.integrations.$get()).json(),
  });

  const disconnect = useMutation({
    mutationFn: async (id: string) => (await api.integrations[":id"].disconnect.$post({ param: { id }, json: {} })).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["integrations"] }),
  });
  const sync = useMutation({
    mutationFn: async (id: string) => (await api.integrations[":id"].sync.$post({ param: { id }, json: {} })).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["integrations"] }),
  });

  async function connect(it: any) {
    // Provider not yet enabled by the platform owner → friendly "coming soon".
    if (!it.available) { setComingSoon(it); return; }
    setConnecting(it.id);
    try {
      const res = await fetch(`/api/integrations/${it.id}/authorize`, {
        method: "POST", headers: { ...apiHeaders(), "Content-Type": "application/json" }, body: "{}",
      });
      const j = await res.json();
      if (!res.ok) { setComingSoon(it); setConnecting(null); return; }
      // Hand off to the provider's own authorize page (QuickBooks, Google, …).
      const popup = window.open(j.authorizeUrl, "oauth", "width=560,height=720");
      const onMsg = (e: MessageEvent) => {
        if (e.data?.type === "oauth") {
          window.removeEventListener("message", onMsg);
          qc.invalidateQueries({ queryKey: ["integrations"] });
          setConnecting(null);
        }
      };
      window.addEventListener("message", onMsg);
      const timer = setInterval(() => {
        if (popup?.closed) { clearInterval(timer); window.removeEventListener("message", onMsg); qc.invalidateQueries({ queryKey: ["integrations"] }); setConnecting(null); }
      }, 800);
    } catch {
      setConnecting(null);
    }
  }

  if (list.isLoading) return <FullLoader label="Loading integrations…" />;
  const items = (list.data?.integrations ?? []) as any[];
  const connected = items.filter((i) => i.status === "connected").length;

  const grouped = CATEGORY_ORDER.map((cat) => ({ cat, items: items.filter((i) => i.category === cat) })).filter((g) => g.items.length);

  return (
    <PageWrap>
      <PageHead
        title="Integrations"
        subtitle={`Connect the tools your business already runs on · ${connected} connected`}
        actions={isOwner ? (
          <button onClick={() => setShowSetup(true)}
            className="flex items-center gap-2 rounded-xl border border-white/10 bg-ink-2 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-white/5">
            <Settings className="h-4 w-4 text-cyan-glow" /> Developer setup
          </button>
        ) : undefined}
      />

      <div className="space-y-7">
        {grouped.map((g) => (
          <div key={g.cat}>
            <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">{g.cat}</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {g.items.map((it) => {
                const on = it.status === "connected";
                const err = it.status === "error";
                const soon = !on && !err && !it.available;
                return (
                  <div key={it.id} className="nvc-card flex flex-col p-4">
                    <div className="mb-3 flex items-center gap-3">
                      <BrandIcon provider={it.provider} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold text-white">{it.name}</p>
                        <p className="text-xs text-slate-500">{it.category}</p>
                      </div>
                      {on && <span className="flex items-center gap-1 rounded-full bg-emerald-live/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-live"><Check className="h-3 w-3" /> Live</span>}
                      {err && <span className="flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-semibold text-red-400"><AlertTriangle className="h-3 w-3" /> Error</span>}
                      {soon && <span className="flex items-center gap-1 rounded-full bg-slate-500/15 px-2 py-0.5 text-[11px] font-semibold text-slate-400"><Clock className="h-3 w-3" /> Soon</span>}
                    </div>

                    {on && it.accountLabel && (
                      <p className="mb-3 truncate text-xs text-slate-400">
                        {it.accountLabel}
                        {it.lastSyncAt && <span className="block text-slate-600">Synced {new Date(it.lastSyncAt).toLocaleString()}</span>}
                      </p>
                    )}
                    {soon && (
                      <p className="mb-3 text-xs text-slate-500">Available soon — your admin is finishing setup for this tool.</p>
                    )}
                    {!on && !soon && !err && (
                      <p className="mb-3 text-xs text-slate-500">Securely connect with one click — authorize on {it.name}, no keys needed.</p>
                    )}

                    <div className="mt-auto flex gap-2 pt-1">
                      {on ? (
                        <>
                          {it.provider === "google_drive" ? (
                            <button onClick={() => setDriveExport(true)}
                              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand/15 py-2 text-xs font-semibold text-brand hover:bg-brand/25">
                              <UploadCloud className="h-3.5 w-3.5" /> Export data
                            </button>
                          ) : (
                            <button onClick={() => sync.mutate(it.id)} disabled={sync.isPending}
                              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-white/5 py-2 text-xs font-semibold text-slate-200 hover:bg-white/10 disabled:opacity-60">
                              <RefreshCw className={`h-3.5 w-3.5 ${sync.isPending && sync.variables === it.id ? "animate-spin" : ""}`} /> Sync
                            </button>
                          )}
                          <button onClick={() => disconnect.mutate(it.id)}
                            className="flex items-center justify-center gap-1.5 rounded-lg bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-400 hover:bg-red-500/20">
                            <Link2Off className="h-3.5 w-3.5" />
                          </button>
                        </>
                      ) : soon ? (
                        <button onClick={() => connect(it)}
                          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/5 py-2 text-xs font-semibold text-slate-400 hover:bg-white/10">
                          <Clock className="h-3.5 w-3.5" /> Coming soon
                        </button>
                      ) : err ? (
                        <button onClick={() => connect(it)} disabled={connecting === it.id}
                          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-red-500/15 py-2 text-xs font-semibold text-red-300 hover:bg-red-500/25 disabled:opacity-60">
                          <RefreshCw className="h-3.5 w-3.5" /> {connecting === it.id ? "Reconnecting…" : "Reconnect"}
                        </button>
                      ) : (
                        <button onClick={() => connect(it)} disabled={connecting === it.id}
                          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand py-2 text-xs font-semibold text-white hover:bg-brand-deep disabled:opacity-60">
                          <Plug className="h-3.5 w-3.5" /> {connecting === it.id ? "Connecting…" : "Connect"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <ComingSoonModal item={comingSoon} onClose={() => setComingSoon(null)} isOwner={isOwner} onSetup={() => { setComingSoon(null); setShowSetup(true); }} />
      {isOwner && <SetupModal open={showSetup} onClose={() => setShowSetup(false)} />}
      <DriveExportModal
        open={driveExport}
        onClose={() => { setDriveExport(false); qc.invalidateQueries({ queryKey: ["integrations"] }); }}
        onReconnect={() => {
          const driveItem = items.find((i) => i.provider === "google_drive");
          if (driveItem) connect(driveItem);
        }}
      />
    </PageWrap>
  );
}

/* Pick a dataset + format and back it up straight into the connected Drive. */
const DRIVE_DATASETS = [
  { id: "work-orders", label: "Work orders / jobs" },
  { id: "clients", label: "Clients" },
  { id: "technicians", label: "Technicians" },
  { id: "invoices", label: "Invoices" },
];
function DriveExportModal({ open, onClose, onReconnect }: { open: boolean; onClose: () => void; onReconnect?: () => void }) {
  const { nounPlural } = useWorkerNoun();
  const { nounPlural: customerNounPlural } = useCustomerNoun();
  const [dataset, setDataset] = useState("work-orders");
  const [format, setFormat] = useState<"csv" | "xlsx">("xlsx");
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");
  const [reauthRequired, setReauthRequired] = useState(false);
  const [showFolder, setShowFolder] = useState(false);

  // Folder settings (root name + subfolder toggles)
  const [folderName, setFolderName] = useState("NVC360 Backups");
  const [byDataset, setByDataset] = useState(true);
  const [byMonth, setByMonth] = useState(true);
  const [savedMsg, setSavedMsg] = useState("");

  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const r = await fetch("/api/integrations/drive/settings", { headers: apiHeaders() });
        const j = await r.json();
        if (r.ok) {
          setFolderName(j.folderName ?? "NVC360 Backups");
          setByDataset(j.subfolderByDataset !== false);
          setByMonth(j.subfolderByMonth !== false);
        }
      } catch { /* ignore */ }
    })();
  }, [open]);

  const saveSettings = useMutation({
    mutationFn: async () => {
      setSavedMsg("");
      const res = await fetch("/api/integrations/drive/settings", {
        method: "PUT",
        headers: { ...apiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ folderName, subfolderByDataset: byDataset, subfolderByMonth: byMonth }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message || "Save failed");
      return j;
    },
    onSuccess: (j) => { setFolderName(j.folderName); setSavedMsg("Folder settings saved."); setTimeout(() => setSavedMsg(""), 2500); },
    onError: (e: any) => setSavedMsg(e.message || "Save failed"),
  });

  // Live preview of where files will land
  const month = new Date().toISOString().slice(0, 7);
  const previewPath = [folderName || "NVC360 Backups", byDataset ? dataset : null, byMonth ? month : null]
    .filter(Boolean).join(" / ");

  const run = useMutation({
    mutationFn: async () => {
      setError("");
      setReauthRequired(false);
      const res = await fetch("/api/integrations/drive/export", {
        method: "POST",
        headers: { ...apiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ dataset, format }),
      });
      let j: any;
      try {
        j = await res.json();
      } catch {
        // Response wasn't JSON at all (e.g. an upstream proxy/CDN error page
        // slipped through) — give a clear message instead of surfacing the
        // raw "Unexpected token '<'..." parse error to the user.
        throw new Error("Something went wrong reaching the server. Please try again in a moment.");
      }
      if (!res.ok) {
        if (j.reauthRequired) setReauthRequired(true);
        throw new Error(j.message || "Export failed");
      }
      return j;
    },
    onSuccess: (j) => setResult(j),
    onError: (e: any) => setError(e.message || "Export failed"),
  });

  function close() {
    setResult(null);
    setError("");
    setReauthRequired(false);
    setShowFolder(false);
    onClose();
  }

  return (
    <Modal open={open} onClose={close} title="Back up to Google Drive" subtitle="Export a dataset to your Drive, organized in folders" size="sm">
      {result ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-emerald-live/20 bg-emerald-live/10 p-4 text-sm text-emerald-live">
            <p className="font-semibold">Backed up {result.rows} row(s).</p>
            <p className="mt-1 text-xs text-emerald-live/80">Saved as <span className="font-medium">{result.file}</span></p>
            {result.folderPath && (
              <p className="mt-0.5 text-xs text-emerald-live/80">in <span className="font-medium">{String(result.folderPath).replace(/\//g, " / ")}</span></p>
            )}
          </div>
          {result.folderLink && (
            <a href={result.folderLink} target="_blank" rel="noreferrer"
              className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand/15 py-2 text-xs font-semibold text-brand hover:bg-brand/25">
              <ExternalLink className="h-3.5 w-3.5" /> Open folder in Google Drive
            </a>
          )}
          <a href={result.link} target="_blank" rel="noreferrer"
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-white/5 py-2 text-xs font-semibold text-slate-200 hover:bg-white/10">
            <ExternalLink className="h-3.5 w-3.5" /> Open file
          </a>
          <button onClick={close} className="w-full rounded-lg bg-brand py-2 text-xs font-semibold text-white hover:bg-brand-deep">Done</button>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-slate-400">What to back up</span>
              <select value={dataset} onChange={(e) => setDataset(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white">
                {DRIVE_DATASETS.map((d) => <option key={d.id} value={d.id}>{d.id === "technicians" ? nounPlural : d.id === "clients" ? customerNounPlural : d.label}</option>)}
              </select>
            </label>
          </div>
          <div>
            <span className="mb-1.5 block text-xs font-semibold text-slate-400">File format</span>
            <div className="flex gap-2">
              {(["xlsx", "csv"] as const).map((f) => (
                <button key={f} onClick={() => setFormat(f)}
                  className={`flex-1 rounded-lg border py-2 text-xs font-semibold ${format === f ? "border-brand bg-brand/15 text-brand" : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10"}`}>
                  {f === "xlsx" ? "Excel (.xlsx)" : "CSV (.csv)"}
                </button>
              ))}
            </div>
          </div>

          {/* Destination folder preview + settings toggle */}
          <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Saves to</p>
                <p className="mt-0.5 truncate text-xs font-medium text-slate-200" title={previewPath}>📁 {previewPath}</p>
              </div>
              <button onClick={() => setShowFolder((s) => !s)}
                className="shrink-0 rounded-md bg-white/5 px-2 py-1 text-[11px] font-semibold text-slate-300 hover:bg-white/10">
                {showFolder ? "Hide" : "Change"}
              </button>
            </div>

            {showFolder && (
              <div className="mt-3 space-y-3 border-t border-white/10 pt-3">
                <label className="block">
                  <span className="mb-1 block text-[11px] font-semibold text-slate-400">Main folder name</span>
                  <input value={folderName} onChange={(e) => setFolderName(e.target.value)} maxLength={80}
                    placeholder="NVC360 Backups" aria-label="Main folder name"
                    className="w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white" />
                </label>
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input type="checkbox" aria-label="Sort into a subfolder per data type" checked={byDataset} onChange={(e) => setByDataset(e.target.checked)} className="accent-brand" />
                  Sort into a subfolder per data type (work-orders/, clients/…)
                </label>
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input type="checkbox" aria-label="Add a month subfolder" checked={byMonth} onChange={(e) => setByMonth(e.target.checked)} className="accent-brand" />
                  Add a month subfolder ({month})
                </label>
                <div className="flex items-center gap-2">
                  <button onClick={() => saveSettings.mutate()} disabled={saveSettings.isPending}
                    className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-deep disabled:opacity-60">
                    {saveSettings.isPending ? "Saving…" : "Save folder settings"}
                  </button>
                  {savedMsg && <span className="text-[11px] text-emerald-live">{savedMsg}</span>}
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="space-y-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
              <p>{error}</p>
              {reauthRequired && onReconnect && (
                <button
                  onClick={() => { close(); onReconnect(); }}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-red-500/20 px-3 py-1.5 text-xs font-semibold text-red-200 hover:bg-red-500/30"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Reconnect Google Drive
                </button>
              )}
            </div>
          )}
          <button onClick={() => run.mutate()} disabled={run.isPending}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand py-2.5 text-sm font-semibold text-white hover:bg-brand-deep disabled:opacity-60">
            <UploadCloud className={`h-4 w-4 ${run.isPending ? "animate-pulse" : ""}`} /> {run.isPending ? "Backing up…" : "Back up now"}
          </button>
        </div>
      )}
    </Modal>
  );
}

/* Friendly "not available yet" message for tenants. */
function ComingSoonModal({ item, onClose, isOwner, onSetup }: { item: any; onClose: () => void; isOwner: boolean; onSetup: () => void }) {
  if (!item) return null;
  return (
    <Modal open={!!item} onClose={onClose} title={`${item.name} — coming soon`} subtitle="This connection isn’t available just yet" size="sm">
      <div className="flex items-start gap-3 rounded-xl border border-white/10 bg-ink-3/50 p-4">
        <BrandIcon provider={item.provider} />
        <p className="text-sm text-slate-300">
          One-click connect to <span className="font-semibold text-white">{item.name}</span> is being set up by your administrator.
          Once it’s enabled, you’ll authorize directly on {item.name} — no API keys to manage.
        </p>
      </div>
      {isOwner ? (
        <button onClick={onSetup} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-brand py-2.5 text-sm font-semibold text-white hover:bg-brand-deep">
          <Settings className="h-4 w-4" /> Open developer setup
        </button>
      ) : (
        <p className="mt-4 text-center text-xs text-slate-500">Need it sooner? Contact your account admin.</p>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Owner-only: register OAuth apps (Client ID/Secret) per provider.    */
/* ------------------------------------------------------------------ */
function SetupModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const status = useQuery({
    queryKey: ["integration-creds"],
    enabled: open,
    queryFn: async () => (await fetch("/api/integrations/credential-status", { headers: apiHeaders() })).json(),
  });
  const stored = useQuery({
    queryKey: ["integration-app-creds"],
    enabled: open,
    queryFn: async () => (await fetch("/api/integrations/app-credentials", { headers: apiHeaders() })).json(),
  });

  const providers = (status.data as any)?.providers ?? [];
  const credMap = (stored.data as any)?.credentials ?? {};

  return (
    <Modal open={open} onClose={onClose} title="Developer setup" subtitle="Register each tool once — tenants then connect with one click" size="lg">
      <div className="mb-4 flex items-start gap-2 rounded-xl border border-cyan-glow/20 bg-cyan-glow/5 p-3 text-xs text-slate-300">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-cyan-glow" />
        <p>Create an OAuth app in each provider’s developer console, add the <strong>Redirect URI</strong> shown below, then paste the Client ID & Secret here. Saved keys go live instantly — no restart. Tenants never see these.</p>
      </div>
      <div className="space-y-2.5">
        {providers.map((p: any) => (
          <ProviderForm key={p.provider} p={p} stored={credMap[p.provider]} onSaved={() => { status.refetch(); stored.refetch(); }} />
        ))}
      </div>
    </Modal>
  );
}

function ProviderForm({ p, stored, onSaved }: { p: any; stored: any; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState(stored?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [copied, setCopied] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/integrations/app-credentials/${p.provider}`, {
        method: "PUT", headers: { ...apiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, clientSecret }),
      });
      if (!res.ok) throw new Error("save_failed");
      return res.json();
    },
    onSuccess: () => { setClientSecret(""); onSaved(); },
  });
  const remove = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/integrations/app-credentials/${p.provider}`, { method: "DELETE", headers: apiHeaders() });
      if (!res.ok) throw new Error("delete_failed");
      return res.json();
    },
    onSuccess: () => { setClientId(""); setClientSecret(""); onSaved(); },
  });

  const copy = (v: string, k: string) => { navigator.clipboard?.writeText(v); setCopied(k); setTimeout(() => setCopied(""), 1500); };
  const isDb = p.source === "db";
  const isEnv = p.source === "env";

  return (
    <div className={`rounded-xl border p-3.5 ${p.configured ? "border-emerald-live/25 bg-emerald-live/5" : "border-white/10 bg-ink-3/40"}`}>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between text-left">
        <div className="flex items-center gap-2.5">
          <BrandIcon provider={p.provider} />
          <div>
            <p className="text-sm font-semibold text-white">{p.name}</p>
            <p className="text-[11px] text-slate-500">{p.category}</p>
          </div>
        </div>
        {p.configured
          ? <span className="flex items-center gap-1 text-[11px] font-semibold text-emerald-live"><Check className="h-3 w-3" /> {isDb ? "Registered" : "Registered (env)"}</span>
          : <span className="text-[11px] font-semibold text-amber-warn">Not set up</span>}
      </button>

      {open && (
        <div className="mt-3 space-y-2.5 border-t border-white/5 pt-3">
          <div className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-[11px] text-slate-500">Redirect URI</span>
            <code className="min-w-0 flex-1 truncate rounded bg-ink/60 px-2 py-1 font-mono text-[11px] text-slate-300">{p.redirectUri}</code>
            <button onClick={() => copy(p.redirectUri, "uri")} className="shrink-0 rounded bg-white/5 p-1.5 text-slate-400 hover:bg-white/10 hover:text-white">
              {copied === "uri" ? <Check className="h-3 w-3 text-emerald-live" /> : <Copy className="h-3 w-3" />}
            </button>
          </div>

          {isEnv && (
            <p className="rounded bg-amber-warn/10 px-2.5 py-1.5 text-[11px] text-amber-warn">
              Currently using env vars (<code>{p.envPrefix}_CLIENT_ID</code>). Saving below overrides them.
            </p>
          )}

          <div>
            <span className="mb-1 block text-[11px] text-slate-500">Client ID</span>
            <input aria-label="Paste Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)}
              placeholder="Paste Client ID" autoComplete="off"
              className="w-full rounded-lg border border-white/10 bg-ink/60 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-brand/50" />
          </div>
          <div>
            <span className="mb-1 block text-[11px] text-slate-500">Client Secret</span>
            <div className="flex items-center gap-2">
              <input aria-label={stored?.hasSecret ? "•••••••• (leave blank to keep)" : "Paste Client Secret"} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)}
                type={showSecret ? "text" : "password"}
                placeholder={stored?.hasSecret ? "•••••••• (leave blank to keep)" : "Paste Client Secret"} autoComplete="new-password"
                className="w-full rounded-lg border border-white/10 bg-ink/60 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-brand/50" />
              <button onClick={() => setShowSecret((s) => !s)} className="shrink-0 rounded bg-white/5 p-2 text-slate-400 hover:bg-white/10 hover:text-white">
                {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button onClick={() => save.mutate()} disabled={save.isPending || !clientId}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand py-2 text-xs font-semibold text-white hover:bg-brand-deep disabled:opacity-50">
              <Save className="h-3.5 w-3.5" /> {save.isPending ? "Saving…" : save.isSuccess ? "Saved ✓" : "Save & enable"}
            </button>
            {isDb && (
              <button onClick={() => remove.mutate()} disabled={remove.isPending}
                className="flex items-center justify-center gap-1.5 rounded-lg bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-400 hover:bg-red-500/20 disabled:opacity-50">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {save.isError && <p className="text-[11px] text-red-400">Couldn’t save — check the values and try again.</p>}
        </div>
      )}
    </div>
  );
}
