import { useState, useEffect } from "react";
import { useConfirm } from "../../components/confirm-dialog";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { FullLoader } from "../../components/loader";
import { PageWrap } from "../../components/brand";
import { PageHead } from "./shell";
import { Field, inputCls, BtnPrimary, ConfirmModal } from "../../components/modal";
import { AddressAutocomplete } from "../../components/address-autocomplete";
import { Save, Building2, Check, Calendar, Copy, RefreshCw, ExternalLink, MapPin, Sparkles, Plug, KeyRound, ScrollText, Lock, Eye, EyeOff, Tag, Plus, Trash2, Pencil, X, Star, CalendarClock, Clock3 } from "lucide-react";
import { useWorkerNoun } from "../../lib/use-brand";
import { cn } from "../../lib/utils";
import AutomationPage from "./automation";
import IntegrationsPage from "./integrations";
import ApiAccessPage from "./api-access";
import AuditPage from "./audit";

const TIMEZONES = [
  "America/Winnipeg", "America/Toronto", "America/Vancouver", "America/Edmonton",
  "America/Halifax", "America/St_Johns", "America/New_York", "America/Chicago",
  "America/Denver", "America/Los_Angeles",
];
const CURRENCIES = ["CAD", "USD", "EUR", "GBP", "AUD"];

function CalendarSync() {
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [copied, setCopied] = useState<string | null>(null);

  const feed = useQuery({
    queryKey: ["calendar-feed"],
    queryFn: async () => (await (api as any).calendar.feed.$get()).json(),
  });

  const regen = useMutation({
    mutationFn: async () => (await (api as any).calendar.feed.regenerate.$post()).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["calendar-feed"] }),
  });

  const copy = (val: string, key: string) => {
    navigator.clipboard?.writeText(val);
    setCopied(key);
    setTimeout(() => setCopied((k) => (k === key ? null : k)), 1800);
  };

  const d = feed.data as any;

  return (
    <div className="nvc-card space-y-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <h3 className="flex items-center gap-2 font-bold text-white">
          <Calendar className="h-4 w-4 text-brand" /> Calendar Sync
        </h3>
        <button
          onClick={async () => {
            const ok = await confirm({
              title: "Regenerate your calendar link?",
              message: "Existing subscriptions will stop updating until they're re-added.",
              confirmLabel: "Regenerate",
            });
            if (ok) regen.mutate();
          }}
          disabled={regen.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-medium text-white/70 transition hover:bg-white/5 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${regen.isPending ? "animate-spin" : ""}`} /> Regenerate
        </button>
      </div>
      <p className="text-xs text-white/50">
        Subscribe to keep every job synced to your calendar app. Updates refresh automatically (~30 min). This is a read-only feed of all dispatch jobs.
      </p>

      {feed.isLoading || !d ? (
        <div className="h-24 animate-pulse rounded-lg bg-white/5" />
      ) : (
        <div className="space-y-3">
          <Field label="Subscription URL">
            <div className="flex items-center gap-2">
              <input aria-label="Webcal" className={inputCls} readOnly value={d.webcal} onFocus={(e) => e.target.select()} />
              <button
                onClick={() => copy(d.webcal, "webcal")}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-2 text-xs font-medium text-white/80 transition hover:bg-white/5"
              >
                {copied === "webcal" ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                {copied === "webcal" ? "Copied" : "Copy"}
              </button>
            </div>
          </Field>
          <div className="flex flex-wrap gap-2">
            <a
              href={d.google}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/5 px-3 py-2 text-xs font-medium text-white/90 transition hover:bg-white/10"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Add to Google
            </a>
            <a
              href={d.outlook}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/5 px-3 py-2 text-xs font-medium text-white/90 transition hover:bg-white/10"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Add to Outlook
            </a>
            <a
              href={d.webcal}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/5 px-3 py-2 text-xs font-medium text-white/90 transition hover:bg-white/10"
            >
              <Calendar className="h-3.5 w-3.5" /> Apple Calendar
            </a>
          </div>
          <p className="text-[11px] text-white/40">
            Apple Calendar: the “Apple Calendar” button opens the <code className="text-white/60">webcal://</code> link directly. For Google/Outlook, use the buttons above.
          </p>
        </div>
      )}
    </div>
  );
}

/** Small reusable switch matching the review-requests toggle style. */
function Toggle({
  on, onClick, label,
}: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full transition",
        on ? "bg-emerald-live" : "bg-white/10",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all",
          on ? "left-[22px]" : "left-0.5",
        )}
      />
    </button>
  );
}

/**
 * What a customer may do to their own appointment.
 *
 * The split here is deliberate and worth the words on screen, because it is the
 * difference between fewer phone calls and jobs quietly vanishing off the board:
 * moving a time is safe to hand to the customer while the day isn't routed yet,
 * but a cancellation is ALWAYS a request someone here approves.
 */
function CustomerChangesCard({
  form, set, noun,
}: { form: any; set: (k: string, v: any) => void; noun: string }) {
  const cutoff = Number(form.customerChangeCutoffHours ?? 12);
  const reschedule = form.allowCustomerReschedule ?? true;
  const cancelReq = form.allowCustomerCancelRequest ?? true;
  return (
    <div className="nvc-card space-y-4 p-5">
      <h3 className="flex items-center gap-2 font-bold text-white">
        <CalendarClock className="h-4 w-4 text-brand" /> Customer self-service
      </h3>
      <p className="text-xs text-white/50">
        What a customer can do from their appointment page. Cancellations are
        never automatic — they always come to you as a request to approve or
        decline, so nothing leaves the dispatch board without your say.
      </p>

      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-white/80">Let customers move their own appointment</span>
        <Toggle
          on={reschedule}
          label="Toggle customer reschedule"
          onClick={() => set("allowCustomerReschedule", !reschedule)}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-white/80">Let customers send a cancellation request</span>
        <Toggle
          on={cancelReq}
          label="Toggle customer cancellation requests"
          onClick={() => set("allowCustomerCancelRequest", !cancelReq)}
        />
      </div>

      <Field
        label="Approval cutoff (hours before the appointment)"
        hint="Default 12. Inside this window a reschedule becomes a request instead of going through. 0 = always self-serve."
      >
        <input
          aria-label="Customer change cutoff hours"
          type="number"
          min={0}
          max={336}
          step={1}
          className={inputCls}
          value={cutoff}
          onChange={(e) =>
            set("customerChangeCutoffHours", Math.min(336, Math.max(0, parseInt(e.target.value) || 0)))
          }
        />
      </Field>

      <p className="rounded-lg bg-white/5 p-3 text-[11px] leading-relaxed text-white/60">
        Right now: {reschedule
          ? cutoff > 0
            ? `a customer can move their appointment themselves up to ${cutoff} hour${cutoff === 1 ? "" : "s"} before it starts, then it needs your approval.`
            : "a customer can move their appointment themselves at any time."
          : "customers cannot reschedule online."}{" "}
        {cancelReq
          ? "Cancellations come to you for approval."
          : "Customers cannot request a cancellation online."}{" "}
        Either way, once the {noun.toLowerCase()} is on the way it&apos;s a phone call.
      </p>
    </div>
  );
}

/**
 * Running-late notices.
 *
 * The costly part of a delay is the silence around it: a customer who took the
 * morning off and hears nothing at 9:20 for a 9:00 slot phones the office, and
 * that call costs more than the slip did. Detection is always automatic; what
 * the tenant chooses here is how long dispatch gets to handle it personally
 * before the system speaks for them.
 */
function RunningLateCard({
  form, set, noun,
}: { form: any; set: (k: string, v: any) => void; noun: string }) {
  const enabled = form.delayNoticeEnabled ?? true;
  const threshold = Number(form.delayNoticeThresholdMins ?? 15);
  const auto = Number(form.delayNoticeAutoSendAfterMins ?? 10);
  return (
    <div className="nvc-card space-y-4 p-5">
      <h3 className="flex items-center gap-2 font-bold text-white">
        <Clock3 className="h-4 w-4 text-brand" /> Running-late notices
      </h3>
      <p className="text-xs text-white/50">
        We watch every live job against its promised time. When one slips, it
        lands on your dispatch board first so you can send it, adjust it, or
        mute it — and if nobody gets to it, the customer is told anyway. Notices
        go out by text and on the customer&apos;s tracking page. No email, and
        never a reschedule link.
      </p>

      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-white/80">Watch jobs for delays</span>
        <Toggle
          on={enabled}
          label="Toggle running-late notices"
          onClick={() => set("delayNoticeEnabled", !enabled)}
        />
      </div>

      <Field
        label="Count as late after (minutes past the promised time)"
        hint="Default 15. Also catches a tech who is driving but whose live ETA lands past the slot."
      >
        <input
          aria-label="Delay threshold minutes"
          type="number"
          min={5}
          max={240}
          step={5}
          className={inputCls}
          value={threshold}
          onChange={(e) =>
            set("delayNoticeThresholdMins", Math.min(240, Math.max(5, parseInt(e.target.value) || 15)))
          }
        />
      </Field>

      <Field
        label="Send it automatically after (minutes on the board)"
        hint="Default 10. Set to 0 to never send automatically — nothing goes out unless a dispatcher presses send."
      >
        <input
          aria-label="Delay auto send minutes"
          type="number"
          min={0}
          max={240}
          step={5}
          className={inputCls}
          value={auto}
          onChange={(e) =>
            set("delayNoticeAutoSendAfterMins", Math.min(240, Math.max(0, parseInt(e.target.value) || 0)))
          }
        />
      </Field>

      <p className="rounded-lg bg-white/5 p-3 text-[11px] leading-relaxed text-white/60">
        Right now: {enabled
          ? auto > 0
            ? `a job ${threshold} minutes past its promised time appears on your board, and if nobody acts within ${auto} minute${auto === 1 ? "" : "s"} the customer gets a text on their own.`
            : `a job ${threshold} minutes past its promised time appears on your board and waits there — nothing is sent until you press send.`
          : "delays are not tracked and no notices are sent."}{" "}
        A customer is never texted twice about the same slip, and never once the{" "}
        {noun.toLowerCase()} has arrived.
      </p>
    </div>
  );
}

function CompanySettingsTab() {
  const qc = useQueryClient();
  const { noun } = useWorkerNoun();
  const [form, setForm] = useState<any>(null);
  const [saved, setSaved] = useState(false);

  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: async () => (await api.settings.$get()).json(),
  });

  useEffect(() => {
    if (settings.data) setForm((settings.data as any).settings);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: async () => {
      const res = await api.settings.$put({ json: form });
      if (!res.ok) throw new Error("Save failed");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  if (settings.isLoading || !form) return <FullLoader label="Loading settings…" />;
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white">Company</h2>
          <p className="text-sm text-white/50">Business profile, branding, tax &amp; locale</p>
        </div>
        <BtnPrimary disabled={save.isPending} onClick={() => save.mutate()}>
          {saved ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
          {saved ? "Saved" : save.isPending ? "Saving…" : "Save changes"}
        </BtnPrimary>
      </div>

      <div className="grid gap-5 xl:grid-cols-3 xl:items-start">
        {/* Business profile + geofencing (left, 2-wide) */}
        <div className="space-y-5 xl:col-span-2">
        <div className="nvc-card space-y-4 p-5">
          <h3 className="flex items-center gap-2 font-bold text-white">
            <Building2 className="h-4 w-4 text-brand" /> Business Profile
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Company name">
              <input aria-label="Name" className={inputCls} value={form.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
            <Field label="Legal name">
              <input aria-label="Legal Name" className={inputCls} value={form.legalName} onChange={(e) => set("legalName", e.target.value)} />
            </Field>
            <Field label="Email">
              <input aria-label="Email" className={inputCls} type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
            </Field>
            <Field label="Phone">
              <input aria-label="Phone" className={inputCls} value={form.phone} onChange={(e) => set("phone", e.target.value)} />
            </Field>
            <Field label="Website">
              <input aria-label="Website" className={inputCls} value={form.website} onChange={(e) => set("website", e.target.value)} />
            </Field>
            <Field label="Business address" hint="Autocompletes & geocodes for dispatch & geofencing">
              <AddressAutocomplete
                value={form.address}
                onResolve={({ address, lat, lng }) =>
                  setForm((f: any) => ({ ...f, address, ...(lat != null && { lat, lng }) }))
                }
              />
            </Field>
          </div>
        </div>

          {/* Categories — shared by Form Builder templates and the Product Catalog */}
          <CategoriesCard />

          {/* Geofencing */}
          <div className="nvc-card space-y-4 p-5">
            <h3 className="flex items-center gap-2 font-bold text-white">
              <MapPin className="h-4 w-4 text-brand" /> Geofencing
            </h3>
            <p className="text-xs text-white/50">
              Auto-arrive a {noun.toLowerCase()} and start their on-site clock when they get within this distance of the job address. Leaving the radius pauses the clock automatically.
            </p>
            <Field label="Auto-arrive radius (meters)" hint="Default 20 m">
              <input aria-label="Geofence Radius M"
                type="number"
                min={5}
                step={5}
                className={inputCls}
                value={form.geofenceRadiusM ?? 20}
                onChange={(e) => set("geofenceRadiusM", Math.max(5, parseInt(e.target.value) || 20))}
              />
            </Field>
          </div>

          {/* Review requests + reputation routing */}
          <div className="nvc-card space-y-4 p-5">
            <h3 className="flex items-center gap-2 font-bold text-white">
              <Star className="h-4 w-4 text-brand" /> Review requests
            </h3>
            <p className="text-xs text-white/50">
              After a job completes we text the customer their job record and ask
              for a rating. 4-5 star ratings are offered your public review link;
              3 stars or below never are — they raise a private alert so you can
              fix it first.
            </p>
            {/* Not a <label>: the control is a button, which a label cannot be
                associated with. The button carries its own aria-label. */}
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-white/80">Ask for a review after every job</span>
              <button
                type="button"
                aria-label="Toggle review requests"
                onClick={() => set("reviewRequestEnabled", !(form.reviewRequestEnabled ?? true))}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                  (form.reviewRequestEnabled ?? true) ? "bg-emerald-live" : "bg-white/10"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                    (form.reviewRequestEnabled ?? true) ? "left-[22px]" : "left-0.5"
                  }`}
                />
              </button>
            </div>
            <Field label="Send how long after completion?" hint="Minutes. Default 120 (2 hours)">
              <input aria-label="Review request delay minutes"
                type="number"
                min={0}
                step={15}
                className={inputCls}
                value={form.reviewRequestDelayMins ?? 120}
                onChange={(e) => set("reviewRequestDelayMins", Math.max(0, parseInt(e.target.value) || 0))}
              />
            </Field>
            <Field label="Public review link" hint="Your Google review URL — shown only to 4-5 star reviewers">
              <input aria-label="Google review URL"
                className={inputCls}
                placeholder="https://g.page/r/…/review"
                value={form.googleReviewUrl ?? ""}
                onChange={(e) => set("googleReviewUrl", e.target.value)}
              />
            </Field>
          </div>

          <CustomerChangesCard form={form} set={set} noun={noun} />

          <RunningLateCard form={form} set={set} noun={noun} />
        </div>

        {/* Calendar + branding + locale (right column) */}
        <div className="space-y-5">
          <CalendarSync />

          <div className="nvc-card space-y-4 p-5">
            <h3 className="font-bold text-white">Branding</h3>
            <Field label="Brand color">
              <div className="flex items-center gap-2">
                <input aria-label="Brand Color"
                  type="color"
                  value={form.brandColor}
                  onChange={(e) => set("brandColor", e.target.value)}
                  className="h-9 w-12 cursor-pointer rounded border border-white/10 bg-transparent"
                />
                <input aria-label="Brand Color" className={inputCls} value={form.brandColor} onChange={(e) => set("brandColor", e.target.value)} />
              </div>
            </Field>
            <Field label="Logo URL">
              <input aria-label="https://…" className={inputCls} value={form.logo} onChange={(e) => set("logo", e.target.value)} placeholder="https://…" />
            </Field>
          </div>

          <div className="nvc-card space-y-4 p-5">
            <h3 className="font-bold text-white">Tax & Locale</h3>
            <Field label="Timezone">
              <select className={inputCls} value={form.timezone} onChange={(e) => set("timezone", e.target.value)}>
                {TIMEZONES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Currency">
                <select className={inputCls} value={form.currency} onChange={(e) => set("currency", e.target.value)}>
                  {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </Field>
              <Field label="Tax label">
                <input aria-label="Tax Label" className={inputCls} value={form.taxLabel} onChange={(e) => set("taxLabel", e.target.value)} />
              </Field>
            </div>
            <Field label="Tax rate (%)">
              <input aria-label="Tax Rate" type="number" step="0.1" className={inputCls} value={form.taxRate} onChange={(e) => set("taxRate", parseFloat(e.target.value) || 0)} />
            </Field>
          </div>

        </div>
      </div>
    </div>
  );
}

/**
 * Categories — one shared, ordered list used by BOTH the Form Builder
 * template "Category" dropdown and the Product Catalog item "Category"
 * field. Managing them here means they're set once and stay in sync
 * everywhere they're used, instead of being edited ad hoc in two places.
 */
function CategoriesCard() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["form-categories"],
    queryFn: async () => (await api.catalog.categories.$get()).json(),
  });
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [delRow, setDelRow] = useState<{ id: string; name: string } | null>(null);
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

  const categories: { id: string; name: string }[] = (list.data as any)?.categories ?? [];

  return (
    <div className="nvc-card space-y-4 p-5">
      <div>
        <h3 className="flex items-center gap-2 font-bold text-white">
          <Tag className="h-4 w-4 text-brand" /> Categories
        </h3>
        <p className="mt-1 text-xs text-white/50">
          Shared by Form Builder templates and the Product Catalog — add, rename, or remove them once here.
        </p>
      </div>

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
        <p className="py-4 text-center text-xs text-slate-500">Loading…</p>
      ) : categories.length === 0 ? (
        <p className="py-4 text-center text-xs text-slate-600">No categories yet.</p>
      ) : (
        <div className="space-y-1.5">
          {categories.map((cat) => (
            <div key={cat.id} className="flex items-center gap-2 rounded-lg border border-white/10 bg-ink-3/50 px-2.5 py-2">
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
                  <button type="button" aria-label="Save name" title="Save name" onClick={() => editValue.trim() && rename.mutate({ id: cat.id, name: editValue.trim() })} className="shrink-0 rounded-md p-1 text-emerald-400 hover:bg-white/5"><Check className="h-4 w-4" /></button>
                  <button type="button" aria-label="Cancel rename" title="Cancel rename" onClick={() => setEditingId(null)} className="shrink-0 rounded-md p-1 text-slate-500 hover:bg-white/5"><X className="h-4 w-4" /></button>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-sm text-white">{cat.name}</span>
                  <button type="button" aria-label={`Rename ${cat.name}`} title={`Rename ${cat.name}`} onClick={() => { setEditingId(cat.id); setEditValue(cat.name); }} className="shrink-0 rounded-md p-1 text-slate-500 hover:bg-white/5 hover:text-white"><Pencil className="h-3.5 w-3.5" /></button>
                  <button type="button" aria-label={`Delete ${cat.name}`} title={`Delete ${cat.name}`} onClick={() => { setDelRow(cat); setDelError(""); }} className="shrink-0 rounded-md p-1 text-slate-500 hover:bg-red-500/10 hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

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
    </div>
  );
}

/** Self-service password change for the signed-in user. */
function SecurityTab() {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  const change = useMutation({
    mutationFn: async () => {
      const res = await (api as any).admin.me["change-password"].$post({
        json: { currentPassword: cur, newPassword: next },
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data as any)?.message ?? "Could not change password");
      return data;
    },
    onSuccess: () => {
      setDone(true);
      setCur(""); setNext(""); setConfirm("");
      setTimeout(() => setDone(false), 3000);
    },
    onError: (e: any) => setErr(e.message),
  });

  function submit() {
    setErr("");
    if (next.length < 8) return setErr("New password must be at least 8 characters.");
    if (next !== confirm) return setErr("New passwords do not match.");
    change.mutate();
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-bold text-white">Security</h2>
        <p className="text-sm text-white/50">Change your account password</p>
      </div>
      <div className="nvc-card max-w-lg space-y-4 p-5">
        <h3 className="flex items-center gap-2 font-bold text-white">
          <Lock className="h-4 w-4 text-brand" /> Change password
        </h3>
        <Field label="Current password">
          <input aria-label="Current password" type={show ? "text" : "password"} className={inputCls} value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
        </Field>
        <Field label="New password" hint="At least 8 characters">
          <input aria-label="New password" type={show ? "text" : "password"} className={inputCls} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="Confirm new password">
          <input aria-label="Confirm new password" type={show ? "text" : "password"} className={inputCls} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </Field>
        <button type="button" onClick={() => setShow((s) => !s)} className="inline-flex items-center gap-1.5 text-xs text-white/60 hover:text-white/90">
          {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          {show ? "Hide passwords" : "Show passwords"}
        </button>
        {err && <p className="text-sm text-rose-400">{err}</p>}
        {done && <p className="text-sm text-emerald-400">Password updated.</p>}
        <div>
          <BtnPrimary disabled={change.isPending} onClick={submit}>
            {done ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
            {change.isPending ? "Updating…" : "Update password"}
          </BtnPrimary>
        </div>
      </div>
    </div>
  );
}

type SettingsSection = {
  key: string;
  label: string;
  icon: typeof Building2;
  render: () => React.ReactNode;
  /** sub-pages that already render their own PageWrap/PageHead */
  embedded?: boolean;
};

const SECTIONS: SettingsSection[] = [
  { key: "company", label: "Company", icon: Building2, render: () => <CompanySettingsTab /> },
  { key: "automation", label: "Automation & AI", icon: Sparkles, render: () => <AutomationPage />, embedded: true },
  { key: "integrations", label: "Integrations", icon: Plug, render: () => <IntegrationsPage />, embedded: true },
  { key: "api", label: "API & MCP", icon: KeyRound, render: () => <ApiAccessPage />, embedded: true },
  { key: "audit", label: "Audit Log", icon: ScrollText, render: () => <AuditPage />, embedded: true },
  { key: "security", label: "Security", icon: Lock, render: () => <SecurityTab /> },
];

export default function AdminSettings() {
  // remember last-opened section across reloads
  const [active, setActive] = useState<string>(() => {
    if (typeof localStorage === "undefined") return "company";
    return localStorage.getItem("settings_section") ?? "company";
  });
  const section = SECTIONS.find((s) => s.key === active) ?? SECTIONS[0];

  function select(key: string) {
    setActive(key);
    try { localStorage.setItem("settings_section", key); } catch { /* ignore */ }
  }

  const LeftNav = (
    <nav className="nvc-card flex flex-row gap-1 overflow-x-auto p-2 lg:flex-col lg:overflow-visible">
      {SECTIONS.map((s) => {
        const on = s.key === active;
        return (
          <button
            key={s.key}
            onClick={() => select(s.key)}
            className={cn(
              "flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition lg:w-full",
              on
                ? "bg-brand/15 text-cyan-glow nvc-glow-sm"
                : "text-slate-400 hover:bg-white/5 hover:text-slate-200",
            )}
          >
            <s.icon className="h-[18px] w-[18px] shrink-0" />
            <span className="whitespace-nowrap">{s.label}</span>
          </button>
        );
      })}
    </nav>
  );

  return (
    <PageWrap>
      <PageHead title="Settings" subtitle="Configure your workspace" />
      <div className="grid gap-5 lg:grid-cols-[220px_1fr] lg:items-start">
        {LeftNav}
        <div className="min-w-0">
          {/* Embedded pages bring their own header/spacing; render bare.
              Native tabs get a card surface. */}
          {section.embedded ? (
            <EmbeddedSection>{section.render()}</EmbeddedSection>
          ) : (
            <div className="nvc-card p-5 sm:p-6">{section.render()}</div>
          )}
        </div>
      </div>
    </PageWrap>
  );
}

/**
 * Embedded sub-pages (Automation, Integrations, API, Audit) were originally
 * standalone routes that render their own <PageWrap> (max-width + padding) and
 * <PageHead>. Inside the Settings layout we neutralize that outer wrapper so we
 * don't double-pad or re-constrain width — the content fills the column.
 */
function EmbeddedSection({ children }: { children: React.ReactNode }) {
  return (
    <div className="[&_.mx-auto]:mx-0 [&_.mx-auto]:max-w-none [&_.mx-auto]:!px-0 [&_.mx-auto]:!py-0 [&_.mx-auto]:!pb-0">
      {children}
    </div>
  );
}
