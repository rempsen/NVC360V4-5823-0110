import { useState, useEffect } from "react";
import { DialogPanel } from "../../components/dialog-panel";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { FullLoader } from "../../components/loader";
import { PageWrap } from "../../components/brand";
import { PageHead } from "./shell";
import { fmtDateShort, dismiss, activate } from "../../lib/utils";
import {
  Modal,
  Field,
  inputCls,
  BtnPrimary,
  BtnGhost,
  ConfirmModal,
} from "../../components/modal";
import { AddressAutocomplete } from "../../components/address-autocomplete";
import { TagPicker } from "../../components/tag-picker";
import { AttachmentManager } from "../../components/attachment-manager";
import { CustomFieldsForm } from "../../components/custom-fields";
import { WorkOrderModal } from "../../components/work-order-modal";
import { Search, UserPlus, Trash2, Plus, X, Mail, Phone, ClipboardList } from "lucide-react";
import { useWorkerNoun, useCustomerNoun } from "../../lib/use-brand";

const ROLE_LABEL_BASE: Record<string, string> = {
  superadmin: "Super Admin",
  admin: "Dispatcher",
  rider: "Technician",
};
const ROLE_TINT: Record<string, string> = {
  superadmin: "bg-amber-500/15 text-amber-300",
  admin: "bg-violet-500/15 text-violet-300",
  rider: "bg-brand/15 text-cyan-glow",
  customer: "bg-emerald-live/15 text-emerald-live",
};

export default function AdminClients() {
  const qc = useQueryClient();
  const { noun, nounPlural } = useWorkerNoun();
  const { noun: customerNoun, nounPlural: customerNounPlural } = useCustomerNoun();
  const roleLabel = (r: string) =>
    r === "rider" ? noun : r === "customer" ? customerNoun : ROLE_LABEL_BASE[r] ?? r;
  const [q, setQ] = useState("");
  const [role, setRole] = useState("all");
  const [showAdd, setShowAdd] = useState(false);
  const [delUser, setDelUser] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    phone: "",
    role: "customer",
  });

  const users = useQuery({
    queryKey: ["admin-users"],
    queryFn: async () => (await api.admin.users.$get()).json(),
  });

  const create = useMutation({
    mutationFn: async () => {
      const res = await api.admin.users.$post({ json: form });
      const data = await res.json();
      if (!res.ok) throw new Error((data as any).message || "Failed");
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      setShowAdd(false);
      setForm({ name: "", email: "", password: "", phone: "", role: "customer" });
      setErr("");
    },
    onError: (e: any) => setErr(e.message),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.admin.users[":id"].$delete({ param: { id } });
      const data = await res.json();
      if (!res.ok) throw new Error((data as any).message || "Failed");
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      setDelUser(null);
    },
    onError: () => setDelUser(null),
  });

  if (users.isLoading) return <FullLoader label="Loading directory…" />;
  let list = users.data?.users ?? [];
  if (role !== "all") list = list.filter((u) => u.role === role);
  if (q.trim()) {
    const t = q.toLowerCase();
    list = list.filter(
      (u) =>
        u.name?.toLowerCase().includes(t) || u.email?.toLowerCase().includes(t),
    );
  }

  return (
    <PageWrap>
      <PageHead
        title="Directory"
        subtitle={`${list.length} accounts`}
        actions={
          <BtnPrimary onClick={() => setShowAdd(true)}>
            <UserPlus className="h-4 w-4" /> Add {customerNoun}
          </BtnPrimary>
        }
      />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-1.5">
          {[
            ["all", "All"],
            ["customer", customerNounPlural],
            ["rider", nounPlural],
            ["admin", "Dispatchers"],
          ].map(([r, label]) => (
            <button
              key={r}
              onClick={() => setRole(r)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                role === r
                  ? "bg-brand text-white"
                  : "bg-ink-2 text-slate-400 hover:bg-white/5"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input aria-label="Search…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            className="w-full rounded-full border border-white/10 bg-ink-2 py-2 pl-9 pr-4 text-sm text-white outline-none placeholder:text-slate-600 focus:border-brand sm:w-56"
          />
        </div>
      </div>

      <div className="nvc-card overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-white/5 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-3 font-semibold">Name</th>
              <th className="hidden px-4 py-3 font-semibold sm:table-cell">Email</th>
              <th className="hidden px-4 py-3 font-semibold md:table-cell">Phone</th>
              <th className="px-4 py-3 font-semibold">Role</th>
              <th className="hidden px-4 py-3 text-right font-semibold sm:table-cell">Joined</th>
              <th className="px-4 py-3 text-right font-semibold"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {list.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-12 text-center text-slate-500">
                  No accounts found
                </td>
              </tr>
            ) : (
              list.map((u) => (
                <tr key={u.id} onClick={() => setDetail(u)} className="cursor-pointer hover:bg-white/[0.03]">
                  <td className="px-4 py-3" aria-label={u.name}>
                    <div className="flex items-center gap-2.5">
                      <div className="grid h-8 w-8 place-items-center rounded-full bg-brand/15 text-xs font-bold text-cyan-glow">
                        {u.name?.[0]?.toUpperCase() ?? "U"}
                      </div>
                      <span className="font-semibold text-slate-100">
                        {u.name}
                      </span>
                    </div>
                  </td>
                  <td className="hidden px-4 py-3 text-slate-400 sm:table-cell">
                    {u.email}
                  </td>
                  <td className="hidden px-4 py-3 text-slate-400 md:table-cell">
                    {u.phone ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-semibold ${ROLE_TINT[u.role] ?? "bg-white/5 text-slate-400"}`}
                    >
                      {roleLabel(u.role)}
                    </span>
                  </td>
                  <td className="hidden px-4 py-3 text-right text-slate-500 sm:table-cell">
                    {u.createdAt ? fmtDateShort(u.createdAt) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={(e) => { e.stopPropagation(); setDelUser(u); }}
                      title="Delete account"
                      className="grid h-7 w-7 place-items-center rounded-lg text-slate-600 transition hover:bg-red-500/10 hover:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        </div>
      </div>

      {/* add client modal */}
      <Modal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        title="Add Account"
        subtitle="Create a client or dispatcher login"
        footer={
          <>
            <BtnGhost onClick={() => setShowAdd(false)}>Cancel</BtnGhost>
            <BtnPrimary
              disabled={!form.name || !form.email || !form.password || create.isPending}
              onClick={() => create.mutate()}
            >
              <Plus className="h-4 w-4" />
              {create.isPending ? "Creating…" : "Create"}
            </BtnPrimary>
          </>
        }
      >
        <div className="space-y-3">
          {err && (
            <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{err}</p>
          )}
          <Field label="Full name">
            <input aria-label="Jane Doe" className={inputCls} value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Jane Doe" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Email">
              <input aria-label="jane@email.com" className={inputCls} type="email" value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="jane@email.com" />
            </Field>
            <Field label="Temp password">
              <input aria-label="min 8 chars" className={inputCls} value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="min 8 chars" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Phone">
              <input aria-label="+1 416 555 9999" className={inputCls} value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+1 416 555 9999" />
            </Field>
            <Field label="Account type">
              <select className={inputCls} value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="customer">{customerNoun}</option>
                <option value="admin">Dispatcher</option>
              </select>
            </Field>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={!!delUser}
        onClose={() => setDelUser(null)}
        onConfirm={() => delUser && del.mutate(delUser.id)}
        title="Delete account"
        message={`Permanently delete ${delUser?.name ?? "this account"} (${delUser?.email ?? ""})? This cannot be undone.`}
        pending={del.isPending}
      />

      <ClientDrawer user={detail} onClose={() => setDetail(null)} />
    </PageWrap>
  );
}

function updateArr(
  form: any,
  setForm: (v: any) => void,
  key: string,
  index: number,
  patch: Record<string, any>,
) {
  const next = form[key].map((item: any, i: number) =>
    i === index ? { ...item, ...patch } : item,
  );
  setForm({ ...form, [key]: next });
}

/**
 * Best-effort split of a formatted address ("123 Main St, Toronto, ON M5V 2T6,
 * Canada") into the structured fields the additional-site rows use. The street
 * line keeps everything before the first comma; the rest is parsed loosely so a
 * single autocomplete pick fills city / region / postal where we can detect them.
 */
function parseAddressFields(formatted: string): {
  line: string;
  city?: string;
  region?: string;
  postalCode?: string;
} {
  const parts = formatted.split(",").map((p) => p.trim()).filter(Boolean);
  const line = parts[0] ?? formatted;
  const city = parts.length >= 2 ? parts[1] : undefined;
  // "ON M5V 2T6" -> region "ON", postal "M5V 2T6"
  const regionChunk = parts.length >= 3 ? parts[2] : "";
  const m = regionChunk.match(/^([A-Za-z]{2,})\s*(.*)$/);
  return {
    line,
    ...(city ? { city } : {}),
    ...(m?.[1] ? { region: m[1] } : {}),
    ...(m?.[2] ? { postalCode: m[2].trim() } : {}),
  };
}

/** Same parse but mapped onto the primary-address form's flat field names. */
function applyAddressParts(prev: any, formatted: string) {
  const p = parseAddressFields(formatted);
  return {
    address: formatted,
    ...(p.city ? { city: p.city } : { city: prev.city }),
    ...(p.region ? { region: p.region } : { region: prev.region }),
    ...(p.postalCode ? { postalCode: p.postalCode } : { postalCode: prev.postalCode }),
  };
}

function ClientDrawer({ user, onClose }: { user: any; onClose: () => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"profile" | "jobs" | "files">("profile");
  const [viewJob, setViewJob] = useState<any>(null);
  const [, navigate] = useLocation();
  // Completed jobs are historical now — open the read-only report instead
  // of the editable work order.
  const openJob = (b: any) => {
    if (b.status === "completed") navigate(`/admin/jobs/${b.id}/report`);
    else setViewJob(b);
  };
  const [form, setForm] = useState<any>({
    name: "",
    email: "",
    phone: "",
    altPhone: "",
    company: "",
    address: "",
    city: "",
    region: "",
    postalCode: "",
    country: "",
    notes: "",
    addresses: [] as any[],
    contacts: [] as any[],
  });
  const [saveErr, setSaveErr] = useState("");

  useEffect(() => {
    if (user) {
      setForm({
        name: user.name ?? "",
        email: user.email ?? "",
        phone: user.phone ?? "",
        altPhone: user.altPhone ?? "",
        company: user.company ?? "",
        address: user.address ?? "",
        city: user.city ?? "",
        region: user.region ?? "",
        postalCode: user.postalCode ?? "",
        country: user.country ?? "",
        notes: user.notes ?? "",
        addresses: Array.isArray(user.addresses) ? user.addresses : [],
        contacts: Array.isArray(user.contacts) ? user.contacts : [],
      });
      setSaveErr("");
    }
  }, [
	user?.id,
	user?.company,
	user?.notes,
	user?.city,
	user?.region,
	user?.phone,
	user?.altPhone,
	user?.postalCode,
	user?.contacts,
	user?.address,
	user?.email,
	user?.name,
	user?.addresses,
	user?.country,
	user
]);

  const save = useMutation({
    mutationFn: async () => {
      const res = await api.admin.users[":id"].$patch({ param: { id: user.id }, json: form });
      const data = await res.json();
      if (!res.ok) throw new Error((data as any).message || "Save failed");
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      setSaveErr("");
    },
    onError: (e: any) => setSaveErr(e.message),
  });

  const bookings = useQuery({
    queryKey: ["admin-bookings"],
    enabled: !!user,
    queryFn: async () => (await api.bookings.$get()).json(),
  });

  if (!user) return null;
  const isClient = user.role === "customer";
  const allBookings = (() => {
    const d: any = bookings.data;
    if (Array.isArray(d)) return d;
    if (Array.isArray(d?.bookings)) return d.bookings;
    return [];
  })();
  const jobs = allBookings.filter((b: any) => b && b.customerId === user.id);

  return (
    <div className="fixed inset-0 z-[1000] flex justify-end">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" {...dismiss(onClose)} />
      <DialogPanel onClose={onClose} label={`Client details: ${user.name ?? ""}`} className="relative h-full w-full max-w-xl overflow-y-auto border-l border-white/10 bg-ink shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-white/10 bg-ink/95 px-5 py-4 backdrop-blur">
          <span className="grid h-11 w-11 place-items-center rounded-full bg-brand/15 text-base font-extrabold text-cyan-glow">
            {user.name?.[0]?.toUpperCase() ?? "U"}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-bold text-white">{user.name}</h2>
            <p className="flex items-center gap-3 text-xs text-slate-400">
              {user.email && <span className="flex items-center gap-1"><Mail className="h-3 w-3" /> {user.email}</span>}
              {user.phone && <span className="flex items-center gap-1"><Phone className="h-3 w-3" /> {user.phone}</span>}
            </p>
          </div>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex gap-1 border-b border-white/10 px-5 pt-3">
          {(["profile", "jobs", "files"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`rounded-t-lg px-3 py-2 text-sm font-semibold capitalize transition ${tab === t ? "border-b-2 border-brand text-white" : "text-slate-400 hover:text-white"}`}>
              {t === "jobs" ? "Job history" : t}
            </button>
          ))}
        </div>

        <div className="space-y-5 p-5">
          {tab === "profile" && (
            <>
              {saveErr && (
                <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{saveErr}</p>
              )}
              {/* --- Contact --- */}
              <div className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Contact</p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Full name">
                    <input aria-label="Jane Doe" className={inputCls} value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Jane Doe" />
                  </Field>
                  <Field label="Company">
                    <input aria-label="Acme Inc." className={inputCls} value={form.company}
                      onChange={(e) => setForm({ ...form, company: e.target.value })} placeholder="Acme Inc." />
                  </Field>
                </div>
                <Field label="Email">
                  <input aria-label="jane@email.com" className={inputCls} type="email" value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="jane@email.com" />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Primary phone">
                    <input aria-label="+1 416 555 9999" className={inputCls} value={form.phone}
                      onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+1 416 555 9999" />
                  </Field>
                  <Field label="Secondary phone">
                    <input aria-label="+1 416 555 0000" className={inputCls} value={form.altPhone}
                      onChange={(e) => setForm({ ...form, altPhone: e.target.value })} placeholder="+1 416 555 0000" />
                  </Field>
                </div>
              </div>

              {/* --- Primary address --- */}
              <div className="space-y-3 border-t border-white/10 pt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Primary address</p>
                <Field label="Street address">
                  <AddressAutocomplete
                    value={form.address}
                    placeholder="123 Main St, Unit 4"
                    onResolve={({ address }) =>
                      setForm((f: any) => ({ ...f, ...applyAddressParts(f, address) }))
                    }
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="City">
                    <input aria-label="Toronto" className={inputCls} value={form.city}
                      onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="Toronto" />
                  </Field>
                  <Field label="Province / State">
                    <input aria-label="ON" className={inputCls} value={form.region}
                      onChange={(e) => setForm({ ...form, region: e.target.value })} placeholder="ON" />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Postal / ZIP">
                    <input aria-label="M5V 2T6" className={inputCls} value={form.postalCode}
                      onChange={(e) => setForm({ ...form, postalCode: e.target.value })} placeholder="M5V 2T6" />
                  </Field>
                  <Field label="Country">
                    <input aria-label="Canada" className={inputCls} value={form.country}
                      onChange={(e) => setForm({ ...form, country: e.target.value })} placeholder="Canada" />
                  </Field>
                </div>
              </div>

              {/* --- Additional addresses --- */}
              <div className="space-y-3 border-t border-white/10 pt-4">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Additional sites / addresses</p>
                  <button
                    onClick={() => setForm({ ...form, addresses: [...form.addresses, { label: "", line: "", city: "", region: "", postalCode: "", notes: "" }] })}
                    className="flex items-center gap-1 rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-semibold text-slate-300 hover:border-brand/50 hover:text-white"
                  >
                    <Plus className="h-3 w-3" /> Add address
                  </button>
                </div>
                {form.addresses.length === 0 && (
                  <p className="text-xs text-slate-600">No additional addresses. Use this for multiple job sites or billing locations.</p>
                )}
                {form.addresses.map((a: any, i: number) => (
                  <div key={i} className="space-y-2 rounded-xl border border-white/10 bg-white/[0.02] p-3">
                    <div className="flex items-center gap-2">
                      <input aria-label="Label (e.g. Warehouse, Billing)" className={`${inputCls} flex-1`} value={a.label}
                        onChange={(e) => updateArr(form, setForm, "addresses", i, { label: e.target.value })}
                        placeholder="Label (e.g. Warehouse, Billing)" />
                      <button onClick={() => setForm({ ...form, addresses: form.addresses.filter((_: any, j: number) => j !== i) })}
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-red-500/10 hover:text-red-400">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    <AddressAutocomplete
                      value={a.line}
                      placeholder="Street address"
                      onResolve={({ address }) =>
                        updateArr(form, setForm, "addresses", i, parseAddressFields(address))
                      }
                    />
                    <div className="grid grid-cols-3 gap-2">
                      <input aria-label="City" className={inputCls} value={a.city}
                        onChange={(e) => updateArr(form, setForm, "addresses", i, { city: e.target.value })} placeholder="City" />
                      <input aria-label="Prov." className={inputCls} value={a.region}
                        onChange={(e) => updateArr(form, setForm, "addresses", i, { region: e.target.value })} placeholder="Prov." />
                      <input aria-label="Postal" className={inputCls} value={a.postalCode}
                        onChange={(e) => updateArr(form, setForm, "addresses", i, { postalCode: e.target.value })} placeholder="Postal" />
                    </div>
                  </div>
                ))}
              </div>

              {/* --- Additional contacts --- */}
              <div className="space-y-3 border-t border-white/10 pt-4">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Additional contacts</p>
                  <button
                    onClick={() => setForm({ ...form, contacts: [...form.contacts, { name: "", role: "", phone: "", email: "" }] })}
                    className="flex items-center gap-1 rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-semibold text-slate-300 hover:border-brand/50 hover:text-white"
                  >
                    <Plus className="h-3 w-3" /> Add contact
                  </button>
                </div>
                {form.contacts.length === 0 && (
                  <p className="text-xs text-slate-600">No extra contacts. Add property managers, tenants, or billing contacts.</p>
                )}
                {form.contacts.map((ct: any, i: number) => (
                  <div key={i} className="space-y-2 rounded-xl border border-white/10 bg-white/[0.02] p-3">
                    <div className="flex items-center gap-2">
                      <input aria-label="Contact name" className={`${inputCls} flex-1`} value={ct.name}
                        onChange={(e) => updateArr(form, setForm, "contacts", i, { name: e.target.value })} placeholder="Contact name" />
                      <input aria-label="Role" className={`${inputCls} flex-1`} value={ct.role}
                        onChange={(e) => updateArr(form, setForm, "contacts", i, { role: e.target.value })} placeholder="Role" />
                      <button onClick={() => setForm({ ...form, contacts: form.contacts.filter((_: any, j: number) => j !== i) })}
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-red-500/10 hover:text-red-400">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <input aria-label="Phone" className={inputCls} value={ct.phone}
                        onChange={(e) => updateArr(form, setForm, "contacts", i, { phone: e.target.value })} placeholder="Phone" />
                      <input aria-label="Email" className={inputCls} value={ct.email}
                        onChange={(e) => updateArr(form, setForm, "contacts", i, { email: e.target.value })} placeholder="Email" />
                    </div>
                  </div>
                ))}
              </div>

              {/* --- Notes --- */}
              <div className="space-y-2 border-t border-white/10 pt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Notes</p>
                <textarea aria-label="Account notes, gate codes, preferences, history…" className={inputCls} rows={4} value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="Account notes, gate codes, preferences, history…" />
              </div>

              <div className="sticky bottom-0 -mx-5 flex justify-end border-t border-white/10 bg-ink/95 px-5 py-3 backdrop-blur">
                <BtnPrimary onClick={() => save.mutate()} disabled={save.isPending}>
                  {save.isPending ? "Saving…" : "Save client record"}
                </BtnPrimary>
              </div>

              <div className="border-t border-white/10 pt-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Custom fields</p>
                <CustomFieldsForm entity="client" entityType="client" entityId={user.id} />
              </div>
              {isClient && (
                <div className="border-t border-white/10 pt-4">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Tags</p>
                  <TagPicker scope="client" entityType="client" entityId={user.id} />
                </div>
              )}
            </>
          )}

          {tab === "jobs" && (
            bookings.isLoading ? (
              <p className="py-8 text-center text-sm text-slate-500">Loading job history…</p>
            ) : bookings.isError ? (
              <p className="py-8 text-center text-sm text-slate-500">Couldn't load job history. Please try again.</p>
            ) : jobs.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-500">No bookings for this client yet.</p>
            ) : (
              <div className="space-y-2">
                {jobs.map((b: any, idx: number) => {
                  const liCount = (() => {
                    try {
                      const a = typeof b?.lineItems === "string" ? JSON.parse(b.lineItems || "[]") : b?.lineItems;
                      return Array.isArray(a) ? a.length : 0;
                    } catch { return 0; }
                  })();
                  const dateLabel = (() => {
                    if (!b?.createdAt) return "—";
                    const d = new Date(b.createdAt);
                    return isNaN(d.getTime()) ? "—" : fmtDateShort(b.createdAt);
                  })();
                  const totalNum = Number(b?.total);
                  return (
                  <div
                    key={b?.id ?? idx}
                    {...activate(() => openJob(b))}
                    aria-label={`View ${b?.title || b?.service?.name || b?.serviceName || "job"} from ${dateLabel}`}
                    className="flex cursor-pointer items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5 transition hover:border-brand/30 hover:bg-white/[0.05]"
                  >
                    <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand/15 text-cyan-glow"><ClipboardList className="h-4 w-4" /></span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-white">{b?.title || b?.service?.name || b?.serviceName || "Service"}</p>
                      <p className="text-[11px] text-slate-500">
                        {dateLabel} · {b?.status ?? "—"}
                        {liCount > 0 && <span className="ml-1 text-cyan-glow">· {liCount} line item{liCount > 1 ? "s" : ""}</span>}
                      </p>
                    </div>
                    {Number.isFinite(totalNum) && <span className="text-sm font-bold text-emerald-live">${totalNum.toFixed(2)}</span>}
                  </div>
                  );
                })}
              </div>
            )
          )}

          {tab === "files" && <AttachmentManager entityType="client" entityId={user.id} />}
        </div>
      </DialogPanel>

      <WorkOrderModal
        open={viewJob !== null}
        editBooking={viewJob ?? undefined}
        onClose={() => setViewJob(null)}
      />
    </div>
  );
}
