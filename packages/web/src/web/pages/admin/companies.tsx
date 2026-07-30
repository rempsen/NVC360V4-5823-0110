import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useAuth } from "../../hooks/use-auth";
import { activeCompany, switchCompany } from "../../lib/tenant";
import { INDUSTRY_LABELS, INDUSTRY_GROUPS } from "../../../services/industry-presets";
import { AddressAutocomplete } from "../../components/address-autocomplete";
import { FullLoader } from "../../components/loader";
import { PageHead } from "./shell";
import {
  Modal,
  Field,
  inputCls,
  BtnPrimary,
  BtnGhost,
} from "../../components/modal";
import {
  Building2,
  Plus,
  LogIn,
  CheckCircle2,
  Mail,
  Phone,
  Crown,
  Users as UsersIcon,
  Sparkles,
  Globe,
  Wand2,
  Hammer,
  Loader2,
} from "lucide-react";

type Company = {
  id: string;
  name: string;
  contactEmail: string;
  phone: string;
  plan: string;
  status: string;
};

const PLAN_TINT: Record<string, string> = {
  starter: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  pro: "bg-cyan-500/15 text-cyan-glow border-cyan-500/30",
  enterprise: "bg-amber-500/15 text-amber-300 border-amber-500/30",
};

const EMPTY = {
  name: "",
  slug: "",
  contactEmail: "",
  phone: "",
  plan: "starter",
  industry: "",
  industryOther: "",
  website: "",
  adminName: "",
  adminEmail: "",
  adminPassword: "",
  managerName: "",
  managerEmail: "",
  managerPassword: "",
};

type BrandProposal = {
  website: string;
  primaryColor: string | null;
  accentColor: string | null;
  logoUrl: string | null;
  logoSourceUrl: string | null;
  workerNoun: string | null;
  workerNounPlural: string | null;
  customerNoun: string | null;
  customerNounPlural: string | null;
  jobNoun: string | null;
  jobNounPlural: string | null;
  tagline: string | null;
  description: string | null;
  services: string[];
  hours: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
  socials: Record<string, string>;
  suggestedIndustry: string | null;
  suggestedIndustryOther: string | null;
  suggestedIndustryRationale: string | null;
  warnings: string[];
};

export default function CompaniesPage() {
  const { role } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...EMPTY });
  const [err, setErr] = useState("");
  // AI brand-scout state — null until the admin grabs assets.
  const [brand, setBrand] = useState<BrandProposal | null>(null);
  const setBrandField = <K extends keyof BrandProposal>(
    k: K,
    v: BrandProposal[K],
  ) => setBrand((b) => (b ? { ...b, [k]: v } : b));

  const active = activeCompany();

  const { data, isLoading } = useQuery({
    queryKey: ["superadmin", "companies"],
    queryFn: async () => (await api.superadmin.companies.$get()).json(),
    enabled: role === "superadmin",
  });

  // email sending-domain approval queue (cross-tenant)
  const domainsQ = useQuery({
    queryKey: ["superadmin", "email-domains"],
    queryFn: async () => (await (api.superadmin as any)["email-domains"].$get()).json() as Promise<{ domains: any[]; resendAvailable: boolean }>,
    enabled: role === "superadmin",
    refetchInterval: 30000,
  });
  const approveDomain = useMutation({
    mutationFn: async (id: string) => {
      const res = await (api.superadmin as any)["email-domains"][":id"].approve.$post({ param: { id } });
      const d = await res.json();
      if (!res.ok) throw new Error((d as any)?.message || "Approve failed");
      return d;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["superadmin", "email-domains"] }),
  });
  const verifyDomain = useMutation({
    mutationFn: async (id: string) => (await (api.superadmin as any)["email-domains"][":id"].verify.$post({ param: { id } })).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["superadmin", "email-domains"] }),
  });
  const rejectDomain = useMutation({
    mutationFn: async (id: string) => (await (api.superadmin as any)["email-domains"][":id"].$delete({ param: { id } })).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["superadmin", "email-domains"] }),
  });

  const create = useMutation({
    mutationFn: async () => {
      const res = await api.superadmin.companies.$post({
        json: { ...form, brand: brand ?? undefined } as any,
      });
      const d = await res.json();
      if (!res.ok) throw new Error((d as any).message || "Failed");
      return d;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["superadmin", "companies"] });
      setOpen(false);
      setForm({ ...EMPTY });
      setBrand(null);
      setErr("");
    },
    onError: (e: any) => setErr(e.message),
  });

  // "Grab Brand Assets" — scrape the website and propose brand data to review.
  const scout = useMutation({
    mutationFn: async () => {
      const res = await (api.superadmin as any)["brand-scout"].$post({
        json: { website: form.website, name: form.name },
      });
      const d = await res.json();
      if (!res.ok) throw new Error((d as any).message || "Scout failed");
      return d.proposal as BrandProposal;
    },
    onSuccess: (p) => {
      setBrand(p);
      // pre-fill contact fields + the AI-suggested ICP from what we learned,
      // if the admin hasn't already picked something. Still fully overridable
      // — this is a suggestion, not a lock-in.
      const knownIndustry = p.suggestedIndustry && INDUSTRY_LABELS.some((i) => i.id === p.suggestedIndustry);
      setForm((f) => ({
        ...f,
        contactEmail: f.contactEmail || p.email || "",
        phone: f.phone || p.phone || "",
        industry: f.industry || (knownIndustry ? p.suggestedIndustry! : p.suggestedIndustry === "other" ? "other" : f.industry),
        industryOther: f.industryOther || (p.suggestedIndustry === "other" ? p.suggestedIndustryOther || "" : f.industryOther),
      }));
    },
    onError: (e: any) => setErr(e.message),
  });

  if (role !== "superadmin")
    return (
      <div className="p-8 text-center text-slate-400">
        Superadmin access only.
      </div>
    );

  if (isLoading) return <FullLoader />;
  const companies = ((data as any)?.companies ?? []) as Company[];

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="p-5 md:p-8">
      <PageHead
        title="Companies"
        subtitle="Provision and switch between B2B tenants. Each company is fully isolated."
        actions={
          <BtnPrimary onClick={() => { setForm({ ...EMPTY }); setBrand(null); setErr(""); setOpen(true); }}>
            <Plus className="h-4 w-4" /> New Company
          </BtnPrimary>
        }
      />

      {/* Email sending-domain approval queue */}
      {(() => {
        const allDomains = domainsQ.data?.domains || [];
        if (allDomains.length === 0) return null;
        const badge = (s: string) => {
          const map: Record<string, string> = {
            verified: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
            verifying: "bg-amber-500/15 text-amber-400 border-amber-500/30",
            pending: "bg-slate-500/15 text-slate-300 border-slate-500/30",
            failed: "bg-red-500/15 text-red-400 border-red-500/30",
          };
          return <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${map[s] || map.pending}`}>{s}</span>;
        };
        return (
          <div className="mb-6 rounded-2xl border border-white/5 bg-ink-2 p-5">
            <div className="mb-3 flex items-center gap-2">
              <Mail className="h-4 w-4 text-cyan-glow" />
              <h3 className="text-sm font-bold uppercase tracking-wide text-slate-300">Email sending domains</h3>
              {domainsQ.data && !domainsQ.data.resendAvailable && (
                <span className="text-[10px] text-amber-400">RESEND_API_KEY not configured</span>
              )}
            </div>
            <div className="space-y-2">
              {allDomains.map((d: any) => (
                <div key={d.id} className="rounded-xl border border-white/5 bg-ink p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm text-slate-200">{d.domain}</span>
                      {badge(d.status)}
                      <span className="text-[11px] text-slate-500">· {d.companyName}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {d.status === "pending" && !d.resendDomainId && (
                        <button
                          onClick={() => approveDomain.mutate(d.id)}
                          disabled={approveDomain.isPending}
                          className="rounded-lg bg-brand/15 px-2.5 py-1 text-[11px] font-semibold text-cyan-glow hover:bg-brand/25 disabled:opacity-50"
                        >
                          {approveDomain.isPending ? "Approving…" : "Approve & create"}
                        </button>
                      )}
                      {d.resendDomainId && d.status !== "verified" && (
                        <button
                          onClick={() => verifyDomain.mutate(d.id)}
                          disabled={verifyDomain.isPending}
                          className="rounded-lg border border-white/10 px-2.5 py-1 text-[11px] font-semibold text-slate-300 hover:bg-white/5"
                        >
                          {verifyDomain.isPending ? "Checking…" : "Re-check"}
                        </button>
                      )}
                      <button
                        onClick={() => rejectDomain.mutate(d.id)}
                        className="rounded-lg border border-white/10 px-2 py-1 text-[11px] text-slate-500 hover:text-red-400"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                  {approveDomain.isError && approveDomain.variables === d.id && (
                    <p className="mt-1.5 text-[11px] text-red-400">{(approveDomain.error as any)?.message}</p>
                  )}
                  {Array.isArray(d.records) && d.records.length > 0 && (
                    <p className="mt-2 text-[11px] text-slate-500">
                      {d.records.length} DNS record{d.records.length > 1 ? "s" : ""} generated — visible to the tenant in their Notifications → Email sender panel.
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {companies.map((co) => {
          const isActive = active === co.id || (!active && co.id === "default");
          return (
            <div
              key={co.id}
              className="rounded-2xl border border-white/5 bg-ink-2 p-5 transition hover:border-brand/30"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="grid h-11 w-11 place-items-center rounded-xl bg-brand/15 text-cyan-glow">
                    <Building2 className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="font-semibold text-slate-100">{co.name}</p>
                    <p className="text-xs text-slate-500">{co.id}</p>
                  </div>
                </div>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${
                    PLAN_TINT[co.plan] ?? PLAN_TINT.starter
                  }`}
                >
                  {co.plan}
                </span>
              </div>

              <div className="mt-4 space-y-1.5 text-sm text-slate-400">
                {co.contactEmail && (
                  <p className="flex items-center gap-2">
                    <Mail className="h-3.5 w-3.5" /> {co.contactEmail}
                  </p>
                )}
                {co.phone && (
                  <p className="flex items-center gap-2">
                    <Phone className="h-3.5 w-3.5" /> {co.phone}
                  </p>
                )}
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-white/5 pt-3">
                <span
                  className={`text-xs font-medium ${
                    co.status === "active" ? "text-emerald-live" : "text-slate-500"
                  }`}
                >
                  {co.status}
                </span>
                {isActive ? (
                  <span className="inline-flex items-center gap-1.5 rounded-lg bg-brand/15 px-3 py-1.5 text-xs font-semibold text-cyan-glow">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Active
                  </span>
                ) : (
                  <button
                    onClick={() => switchCompany(co.id)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-brand hover:text-brand"
                  >
                    <LogIn className="h-3.5 w-3.5" /> Switch to
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Provision a new company"
        subtitle={create.isPending ? "⏳ Provisioning — this can take up to a minute, please don't close this window." : undefined}
        footer={
          <>
            <BtnGhost onClick={() => setOpen(false)} disabled={create.isPending}>Cancel</BtnGhost>
            <BtnPrimary
              onClick={() => create.mutate()}
              disabled={
                create.isPending ||
                !form.name ||
                !form.industry ||
                (form.industry === "other" && !form.industryOther.trim()) ||
                !form.adminEmail ||
                !form.adminPassword
              }
            >
              {create.isPending ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" /> Provisioning…
                </span>
              ) : (
                "Create company"
              )}
            </BtnPrimary>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Company name">
              <input aria-label="Acme HVAC"
                className={inputCls}
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="Acme HVAC"
              />
            </Field>
            <Field label="Slug (optional)">
              <input aria-label="auto from name"
                className={inputCls}
                value={form.slug}
                onChange={(e) => set("slug", e.target.value)}
                placeholder="auto from name"
              />
            </Field>
            <Field label="Contact email">
              <input aria-label="Contact Email"
                className={inputCls}
                value={form.contactEmail}
                onChange={(e) => set("contactEmail", e.target.value)}
              />
            </Field>
            <Field label="Phone">
              <input aria-label="Phone"
                className={inputCls}
                value={form.phone}
                onChange={(e) => set("phone", e.target.value)}
              />
            </Field>
            <Field label="Plan">
              <select
                className={inputCls}
                value={form.plan}
                onChange={(e) => set("plan", e.target.value)}
              >
                <option value="starter">Starter</option>
                <option value="pro">Pro</option>
                <option value="enterprise">Enterprise</option>
              </select>
            </Field>
          </div>

          <Field label="Primary Industry (ICP)">
            <select
              className={inputCls}
              value={form.industry}
              onChange={(e) => set("industry", e.target.value)}
            >
              <option value="">Select industry…</option>
              {INDUSTRY_GROUPS.map((g) => (
                <optgroup key={g} label={g}>
                  {INDUSTRY_LABELS.filter((i) => i.group === g).map((i) => (
                    <option key={i.id} value={i.id}>{i.label}</option>
                  ))}
                </optgroup>
              ))}
              <option value="other">Other — describe their business…</option>
            </select>
            <p className="mt-1 text-xs text-slate-500">
              Drives starter templates, the service library, work-order intelligence, AI tone,
              and terminology (customer/job naming) for this tenant.
            </p>
            {brand?.suggestedIndustry && form.industry === brand.suggestedIndustry && (
              <p className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-brand/10 px-2.5 py-1.5 text-[11px] text-cyan-300">
                <Sparkles className="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  AI suggested this from their website
                  {brand.suggestedIndustryRationale ? `: ${brand.suggestedIndustryRationale}` : "."}
                  {" "}Change it above if it's not quite right.
                </span>
              </p>
            )}
            {form.industry === "other" && (
              <div className="mt-2">
                <Field label="What kind of business is this?">
                  <input
                    aria-label="Describe their business"
                    className={inputCls}
                    value={form.industryOther}
                    onChange={(e) => set("industryOther", e.target.value)}
                    placeholder="e.g. Wedding Photography, Pest Control, Mobile Notary…"
                  />
                </Field>
                <p className="mt-1 text-xs text-slate-500">
                  No preset fits yet — this description drives AI-generated templates &
                  intake forms instead. We can add it as a full preset later.
                </p>
              </div>
            )}
          </Field>

          {/* Website + AI brand scout ---------------------------------- */}
          <div className="rounded-xl border border-brand/20 bg-gradient-to-br from-brand/[0.07] to-transparent p-4">
            <Field label="Company website">
              <div className="flex items-center gap-2">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-brand/15 text-cyan-glow">
                  <Globe className="h-4 w-4" />
                </span>
                <input
                  aria-label="Company website"
                  className={inputCls}
                  value={form.website}
                  onChange={(e) => set("website", e.target.value)}
                  placeholder="acmehvac.com"
                />
              </div>
            </Field>
            <button
              type="button"
              onClick={() => { setErr(""); scout.mutate(); }}
              disabled={!form.website.trim() || scout.isPending}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand to-cyan-500 py-2.5 text-sm font-bold text-white shadow-lg shadow-brand/20 transition hover:opacity-95 disabled:opacity-50"
            >
              {scout.isPending ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Reading their website & brand…</>
              ) : (
                <><Sparkles className="h-4 w-4" /> Grab Brand Assets</>
              )}
            </button>
            <p className="mt-2 text-center text-[11px] text-slate-500">
              AI scans the site for colors, logo, services & the right name for their field staff.
            </p>

            {brand && (
              <BrandReview
                brand={brand}
                setField={setBrandField}
              />
            )}
          </div>

          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <p className="mb-3 flex items-center gap-2 text-sm font-semibold text-rose-300">
              <Crown className="h-4 w-4" /> Admin account
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Name">
                <input aria-label="Admin Name" className={inputCls} value={form.adminName} onChange={(e) => set("adminName", e.target.value)} />
              </Field>
              <Field label="Email">
                <input aria-label="Admin Email" className={inputCls} value={form.adminEmail} onChange={(e) => set("adminEmail", e.target.value)} />
              </Field>
              <Field label="Password">
                <input aria-label="Admin Password" className={inputCls} type="password" value={form.adminPassword} onChange={(e) => set("adminPassword", e.target.value)} />
              </Field>
            </div>
          </div>

          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <p className="mb-3 flex items-center gap-2 text-sm font-semibold text-violet-300">
              <UsersIcon className="h-4 w-4" /> Manager account <span className="text-xs font-normal text-slate-500">(optional)</span>
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Name">
                <input aria-label="Manager Name" className={inputCls} value={form.managerName} onChange={(e) => set("managerName", e.target.value)} />
              </Field>
              <Field label="Email">
                <input aria-label="Manager Email" className={inputCls} value={form.managerEmail} onChange={(e) => set("managerEmail", e.target.value)} />
              </Field>
              <Field label="Password">
                <input aria-label="Manager Password" className={inputCls} type="password" value={form.managerPassword} onChange={(e) => set("managerPassword", e.target.value)} />
              </Field>
            </div>
          </div>

          {err && <p className="text-sm text-red-400">{err}</p>}
        </div>
      </Modal>
    </div>
  );
}

/** Editable review of the AI-detected brand, shown before the tenant is created. */
function BrandReview({
  brand,
  setField,
}: {
  brand: BrandProposal;
  setField: <K extends keyof BrandProposal>(k: K, v: BrandProposal[K]) => void;
}) {
  return (
    <div className="mt-4 space-y-4 rounded-xl border border-white/10 bg-ink-3/40 p-4">
      <p className="flex items-center gap-2 text-sm font-bold text-cyan-glow">
        <Wand2 className="h-4 w-4" /> Review brand — this applies on create
      </p>

      {brand.warnings.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-[11px] text-amber-200">
          {brand.warnings.map((w, i) => (
            <li key={i}>• {w}</li>
          ))}
        </ul>
      )}

      {/* logo + colors */}
      <div className="flex items-center gap-4">
        <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-xl border border-white/10 bg-white/5">
          {brand.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brand.logoUrl} alt="logo" className="max-h-14 max-w-14 object-contain" />
          ) : (
            <Building2 className="h-6 w-6 text-slate-500" />
          )}
        </div>
        <div className="flex-1 space-y-2">
          <Field label="Logo URL">
            <input
              aria-label="Logo URL"
              className={inputCls}
              value={brand.logoUrl ?? ""}
              onChange={(e) => setField("logoUrl", e.target.value || null)}
              placeholder="https://…"
            />
          </Field>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Primary color">
          <div className="flex items-center gap-2">
            <input
              aria-label="Primary color"
              type="color"
              value={brand.primaryColor || "#06B6D4"}
              onChange={(e) => setField("primaryColor", e.target.value)}
              className="h-10 w-10 shrink-0 cursor-pointer rounded-lg border border-white/10 bg-transparent"
            />
            <input
              aria-label="Primary hex"
              className={inputCls}
              value={brand.primaryColor ?? ""}
              onChange={(e) => setField("primaryColor", e.target.value || null)}
            />
          </div>
        </Field>
        <Field label="Accent color">
          <div className="flex items-center gap-2">
            <input
              aria-label="Accent color"
              type="color"
              value={brand.accentColor || "#0ea5e9"}
              onChange={(e) => setField("accentColor", e.target.value)}
              className="h-10 w-10 shrink-0 cursor-pointer rounded-lg border border-white/10 bg-transparent"
            />
            <input
              aria-label="Accent hex"
              className={inputCls}
              value={brand.accentColor ?? ""}
              onChange={(e) => setField("accentColor", e.target.value || null)}
            />
          </div>
        </Field>
      </div>

      {/* worker noun */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Call their field staff…">
          <div className="flex items-center gap-2">
            <Hammer className="h-4 w-4 shrink-0 text-cyan-glow" />
            <input
              aria-label="Worker noun"
              className={inputCls}
              value={brand.workerNoun ?? ""}
              onChange={(e) => setField("workerNoun", e.target.value || null)}
              placeholder="Technician"
            />
          </div>
        </Field>
        <Field label="…plural">
          <input
            aria-label="Worker noun plural"
            className={inputCls}
            value={brand.workerNounPlural ?? ""}
            onChange={(e) => setField("workerNounPlural", e.target.value || null)}
            placeholder="Technicians"
          />
        </Field>
      </div>

      {/* customer + job noun — same terminology system as worker noun */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Call the people they serve…">
          <input
            aria-label="Customer noun"
            className={inputCls}
            value={brand.customerNoun ?? ""}
            onChange={(e) => setField("customerNoun", e.target.value || null)}
            placeholder="Customer"
          />
        </Field>
        <Field label="…plural">
          <input
            aria-label="Customer noun plural"
            className={inputCls}
            value={brand.customerNounPlural ?? ""}
            onChange={(e) => setField("customerNounPlural", e.target.value || null)}
            placeholder="Customers"
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Call a unit of work…">
          <input
            aria-label="Job noun"
            className={inputCls}
            value={brand.jobNoun ?? ""}
            onChange={(e) => setField("jobNoun", e.target.value || null)}
            placeholder="Job"
          />
        </Field>
        <Field label="…plural">
          <input
            aria-label="Job noun plural"
            className={inputCls}
            value={brand.jobNounPlural ?? ""}
            onChange={(e) => setField("jobNounPlural", e.target.value || null)}
            placeholder="Jobs"
          />
        </Field>
      </div>

      <Field label="Tagline">
        <input
          aria-label="Tagline"
          className={inputCls}
          value={brand.tagline ?? ""}
          onChange={(e) => setField("tagline", e.target.value || null)}
          placeholder="What they say about themselves"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Address">
          <AddressAutocomplete
            value={brand.address ?? ""}
            onResolve={({ address }) => setField("address", address || null)}
          />
        </Field>
        <Field label="Hours">
          <input
            aria-label="Hours"
            className={inputCls}
            value={brand.hours ?? ""}
            onChange={(e) => setField("hours", e.target.value || null)}
          />
        </Field>
      </div>

      {brand.services.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-medium text-slate-400">Services detected</p>
          <div className="flex flex-wrap gap-1.5">
            {brand.services.map((s, i) => (
              <span
                key={i}
                className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-slate-300"
              >
                {s}
              </span>
            ))}
          </div>
        </div>
      )}

      {Object.keys(brand.socials).length > 0 && (
        <p className="text-[11px] text-slate-500">
          Socials: {Object.entries(brand.socials).map(([k]) => k).join(", ")}
        </p>
      )}
    </div>
  );
}
