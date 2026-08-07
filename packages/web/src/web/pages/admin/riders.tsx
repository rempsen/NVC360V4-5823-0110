import { useEffect, useState } from "react";
import { DialogPanel } from "../../components/dialog-panel";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, apiHeaders } from "../../lib/api";
import { FullLoader } from "../../components/loader";
import { PageWrap } from "../../components/brand";
import { PageHead } from "./shell";
import { TECH_STATUS, activate, dismiss, fmtDateShort } from "../../lib/utils";
import { useWorkerNoun } from "../../lib/use-brand";
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
import { SkillPicker } from "../../components/skill-picker";
import { AttachmentManager } from "../../components/attachment-manager";
import { CustomFieldsForm } from "../../components/custom-fields";
import { TechShifts } from "../../components/tech-shifts";
import { WorkOrderModal } from "../../components/work-order-modal";
import { Star, Phone, Mail, Truck, Plus, Trash2, UserPlus, X, Camera, Wrench, Users, ShieldCheck, KeyRound, ClipboardList } from "lucide-react";
import { TechAvatar } from "../../components/tech-avatar";
import { InternalTeamTab, RolesPermissionsTab } from "./team-tabs";

const TEAM_TABS = [
  { key: "field", label: "Field Staff", icon: Wrench },
  { key: "internal", label: "Internal Team", icon: Users },
  { key: "roles", label: "Roles & Permissions", icon: ShieldCheck },
] as const;

export default function AdminTechs() {
  const [tab, setTab] = useState<"field" | "internal" | "roles">("field");
  return (
    <PageWrap>
      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-white/5 pb-px">
        {TEAM_TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 whitespace-nowrap rounded-t-lg px-4 py-2.5 text-sm font-semibold transition ${
                active
                  ? "border-b-2 border-brand text-white"
                  : "border-b-2 border-transparent text-slate-500 hover:text-slate-300"
              }`}
            >
              <t.icon className="h-4 w-4" /> {t.label}
            </button>
          );
        })}
      </div>
      {tab === "field" && <FieldStaffTab />}
      {tab === "internal" && <InternalTeamTab />}
      {tab === "roles" && <RolesPermissionsTab />}
    </PageWrap>
  );
}

const SKILLS = ["General", "HVAC", "Electrical", "Plumbing", "Appliance", "Carpentry", "Landscaping"];
const STATUS_FILTERS = ["all", "available", "enroute", "onsite", "busy", "offline"];

function FieldStaffTab() {
  const qc = useQueryClient();
  const { noun: workerNoun } = useWorkerNoun();
  const [showAdd, setShowAdd] = useState(false);
  const [delId, setDelId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortBy, setSortBy] = useState<"name" | "rating" | "jobs">("name");
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    phone: "",
    skillClass: "General",
    vehicle: "Van",
    licensePlate: "",
    licenseNumber: "",
    address: "",
    notes: "",
    skills: [] as string[],
    payRatePerHour: 0,
  });
  const [err, setErr] = useState("");

  const riders = useQuery({
    queryKey: ["riders"],
    queryFn: async () => (await api.riders.$get()).json(),
    refetchInterval: 8000,
  });

  const create = useMutation({
    mutationFn: async () => {
      const res = await api.riders.$post({ json: form });
      const data = await res.json();
      if (!res.ok) throw new Error((data as any).message || "Failed");
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["riders"] });
      qc.invalidateQueries({ queryKey: ["fleet"] });
      setShowAdd(false);
      setForm({ name: "", email: "", password: "", phone: "", skillClass: "General", vehicle: "Van", licensePlate: "", licenseNumber: "", address: "", notes: "", skills: [], payRatePerHour: 0 });
      setErr("");
    },
    onError: (e: any) => setErr(e.message),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.riders[":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error("Failed to delete");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["riders"] });
      qc.invalidateQueries({ queryKey: ["fleet"] });
      setDelId(null);
    },
  });

  if (riders.isLoading) return <FullLoader label="Loading technicians…" />;
  let list = riders.data?.riders ?? [];
  if (statusFilter !== "all") list = list.filter((r: any) => r.status === statusFilter);
  list = [...list].sort((a: any, b: any) => {
    if (sortBy === "rating") return (b.rating ?? 0) - (a.rating ?? 0);
    if (sortBy === "jobs") return (b.completedJobs ?? 0) - (a.completedJobs ?? 0);
    return (a.name ?? "").localeCompare(b.name ?? "");
  });

  const delTarget = (riders.data?.riders ?? []).find((r: any) => r.id === delId);

  return (
    <>
      <PageHead
        title="Field Staff"
        subtitle={`${(riders.data?.riders ?? []).length} ${workerNoun.toLowerCase()}s & field staff on your team`}
        actions={
          <BtnPrimary onClick={() => setShowAdd(true)}>
            <UserPlus className="h-4 w-4" /> Add {workerNoun}
          </BtnPrimary>
        }
      />

      {/* filter + sort */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold capitalize transition ${
                statusFilter === s
                  ? "bg-brand text-white"
                  : "bg-ink-2 text-slate-400 hover:bg-white/5"
              }`}
            >
              {s === "all" ? "All" : TECH_STATUS[s]?.label ?? s}
            </button>
          ))}
        </div>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as any)}
          className="rounded-lg border border-white/10 bg-ink-2 px-3 py-1.5 text-xs font-semibold text-slate-300 focus:border-brand focus:outline-none"
        >
          <option value="name">Sort: Name</option>
          <option value="rating">Sort: Rating</option>
          <option value="jobs">Sort: Jobs done</option>
        </select>
      </div>

      {list.length === 0 ? (
        <div className="nvc-card grid place-items-center py-16 text-center text-slate-500">
          No technicians match this filter.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((r: any) => {
            const meta = TECH_STATUS[r.status] ?? { label: r.status, color: "#64748b" };
            return (
              <div key={r.id} {...activate(() => setDetailId(r.id))} aria-label={`View ${r.name}`} className="nvc-card group relative cursor-pointer p-4 transition hover:border-brand/30">
                <button
                  onClick={(e) => { e.stopPropagation(); setDelId(r.id); }}
                  title="Remove technician"
                  className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-lg text-slate-600 opacity-0 transition hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
                <div className="flex items-center gap-3">
                  <TechAvatar
                    name={r.name}
                    photoUrl={r.photoUrl}
                    color={r.color}
                    className="h-12 w-12"
                    textClassName="text-lg"
                  />
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-bold text-white">{r.name ?? "Unnamed"}</h3>
                    <div className="flex items-center gap-1 text-xs text-amber-warn">
                      <Star className="h-3.5 w-3.5 fill-amber-warn" />
                      {r.rating?.toFixed(1) ?? "—"}
                      <span className="text-slate-500">· {r.completedJobs ?? 0} jobs</span>
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <span
                    className="rounded-full px-2.5 py-1 text-xs font-semibold"
                    style={{ color: meta.color, background: `${meta.color}22` }}
                  >
                    {meta.label}
                  </span>
                  {r.skillClass && (
                    <span className="rounded-md bg-brand/10 px-2 py-0.5 text-xs font-medium text-cyan-glow">
                      {r.skillClass}
                    </span>
                  )}
                </div>
                <div className="mt-3 space-y-1 border-t border-white/5 pt-3 text-xs text-slate-400">
                  {r.email && (
                    <p className="flex items-center gap-1.5">
                      <Mail className="h-3.5 w-3.5" /> {r.email}
                    </p>
                  )}
                  {r.phone && (
                    <p className="flex items-center gap-1.5">
                      <Phone className="h-3.5 w-3.5" /> {r.phone}
                    </p>
                  )}
                  {r.vehicle && (
                    <p className="flex items-center gap-1.5">
                      <Truck className="h-3.5 w-3.5" /> {r.vehicle}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* add modal */}
      <Modal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        title={`Add ${workerNoun}`}
        subtitle={`Creates a ${workerNoun.toLowerCase()} login + field profile`}
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
            <input aria-label="Marcus Lee" className={inputCls} value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Marcus Lee" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Email">
              <input aria-label="marcus@nvc360.app" className={inputCls} type="email" value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="marcus@nvc360.app" />
            </Field>
            <Field label="Temp password" hint="Tech can change later">
              <input aria-label="min 8 chars" className={inputCls} value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="min 8 chars" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Phone">
              <input aria-label="+1 416 555 1234" className={inputCls} value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+1 416 555 1234" />
            </Field>
            <Field label="Skill class">
              <select className={inputCls} value={form.skillClass}
                onChange={(e) => setForm({ ...form, skillClass: e.target.value })}>
                {SKILLS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Pay rate per hour" hint="Used to compute tech pay from on-site time">
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">$</span>
              <input aria-label="45"
                className={`${inputCls} pl-7`}
                type="number"
                min={0}
                step="0.5"
                value={form.payRatePerHour}
                onChange={(e) => setForm({ ...form, payRatePerHour: Number(e.target.value) || 0 })}
                placeholder="45"
              />
            </div>
          </Field>
          <Field label="Skills" hint="Pick from the library or type a new skill and press Enter">
            <SkillPicker value={form.skills} onChange={(skills) => setForm({ ...form, skills })} />
          </Field>
          <Field label="Vehicle">
            <input aria-label="Ford Transit" className={inputCls} value={form.vehicle}
              onChange={(e) => setForm({ ...form, vehicle: e.target.value })} placeholder="Ford Transit" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="License plate">
              <input aria-label="ABC 123" className={inputCls} value={form.licensePlate}
                onChange={(e) => setForm({ ...form, licensePlate: e.target.value })} placeholder="ABC 123" />
            </Field>
            <Field label="License #">
              <input aria-label="DL-00000" className={inputCls} value={form.licenseNumber}
                onChange={(e) => setForm({ ...form, licenseNumber: e.target.value })} placeholder="DL-00000" />
            </Field>
          </div>
          <Field label="Home address">
            <AddressAutocomplete value={form.address} onResolve={(v) => setForm({ ...form, address: v.address })} />
          </Field>
          <Field label="Notes">
            <textarea aria-label="Internal notes…" className={inputCls} rows={2} value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Internal notes…" />
          </Field>
        </div>
      </Modal>

      <TechDrawer riderId={detailId} onClose={() => setDetailId(null)} />

      <ConfirmModal
        open={!!delId}
        onClose={() => setDelId(null)}
        onConfirm={() => delId && del.mutate(delId)}
        title="Remove technician"
        message={`Remove ${(delTarget as any)?.name ?? "this technician"}? Their account is deleted and any active jobs are returned to the unassigned queue.`}
        pending={del.isPending}
      />
    </>
  );
}

function TechDrawer({ riderId, onClose }: { riderId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"profile" | "jobs" | "shifts" | "files">("profile");
  const [form, setForm] = useState<any>(null);
  const [newPw, setNewPw] = useState("");
  const [pwMsg, setPwMsg] = useState("");
  const [pwErr, setPwErr] = useState("");
  const [, navigate] = useLocation();

  const detail = useQuery({
    queryKey: ["riders"],
    enabled: !!riderId,
    queryFn: async () => (await api.riders.$get()).json(),
  });

  const rider = ((detail.data as any)?.riders ?? []).find((r: any) => r.id === riderId) || null;

  const bookingsQ = useQuery({
    queryKey: ["admin-bookings"],
    enabled: tab === "jobs" && !!riderId,
    queryFn: async () => (await api.bookings.$get()).json(),
  });
  const techJobs = (() => {
    const d: any = bookingsQ.data;
    const all = Array.isArray(d) ? d : Array.isArray(d?.bookings) ? d.bookings : [];
    return all
      .filter((b: any) => b && b.riderId === riderId)
      .sort((a: any, b: any) => Number(b.createdAt) - Number(a.createdAt));
  })();
  const [editJob, setEditJob] = useState<any>(null);
  // Completed jobs are historical now — open the read-only report instead
  // of the editable work order.
  const openJob = (b: any) => {
    if (b.status === "completed") navigate(`/admin/jobs/${b.id}/report`);
    else setEditJob(b);
  };

  useEffect(() => {
    if (rider) {
      setForm({
        phone: rider.phone ?? "",
        vehicle: rider.vehicle ?? "",
        skillClass: rider.skillClass ?? "General",
        licensePlate: rider.licensePlate ?? "",
        licenseNumber: rider.licenseNumber ?? "",
        address: rider.address ?? "",
        notes: rider.notes ?? "",
        payRatePerHour: rider.payRatePerHour ?? 0,
        skills: (rider.skills ?? "").split(",").map((s: string) => s.trim()).filter(Boolean),
      });
    }
    // Repopulate the edit form whenever a different rider record loads. We key
    // on the rider's identity + the server-data version so we don't clobber
    // in-progress edits on unrelated re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rider?.id, detail.dataUpdatedAt]);

  const save = useMutation({
    mutationFn: async () => {
      const res = await api.riders[":id"].$patch({ param: { id: riderId! }, json: form });
      const data = await res.json();
      if (!res.ok) throw new Error((data as any).message || "Save failed");
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["riders"] });
    },
  });

  const resetPw = useMutation({
    mutationFn: async (payload: { userId: string; password: string }) => {
      const res = await (api as any).admin.users[":id"]["reset-password"].$post({
        param: { id: payload.userId },
        json: { password: payload.password },
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data as any).message || "Failed");
      return data;
    },
    onSuccess: () => {
      setPwMsg("Password reset.");
      setNewPw("");
      setTimeout(() => setPwMsg(""), 3000);
    },
    onError: (e: any) => setPwErr(e.message),
  });

  useEffect(() => { setTab("profile"); setNewPw(""); setPwMsg(""); setPwErr(""); }, [riderId]);

  if (!riderId) return null;

  return (
    <div className="fixed inset-0 z-[1000] flex justify-end">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" {...dismiss(onClose)} />
      <DialogPanel onClose={onClose} label="Technician details" className="relative h-full w-full max-w-xl overflow-y-auto border-l border-white/10 bg-ink shadow-2xl">
        {!rider ? (
          <div className="grid h-full place-items-center text-slate-500">Loading…</div>
        ) : (
          <>
            <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-white/10 bg-ink/95 px-5 py-4 backdrop-blur">
              <PhotoUploader rider={rider} />
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-lg font-bold text-white">{rider.name}</h2>
                <p className="flex items-center gap-1 text-xs text-amber-warn">
                  <Star className="h-3.5 w-3.5 fill-amber-warn" /> {rider.rating?.toFixed(1) ?? "—"}
                  <span className="text-slate-500">· {rider.completedJobs ?? 0} jobs</span>
                </p>
              </div>
              <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex gap-1 border-b border-white/10 px-5 pt-3">
              {(["profile", "jobs", "shifts", "files"] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)}
                  className={`rounded-t-lg px-3 py-2 text-sm font-semibold capitalize transition ${tab === t ? "border-b-2 border-brand text-white" : "text-slate-400 hover:text-white"}`}>
                  {t}
                </button>
              ))}
            </div>

            <div className="space-y-5 p-5">
              {tab === "profile" && form && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Phone"><input aria-label="Phone" className={inputCls} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
                    <Field label="Vehicle"><input aria-label="Vehicle" className={inputCls} value={form.vehicle} onChange={(e) => setForm({ ...form, vehicle: e.target.value })} /></Field>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="License plate"><input aria-label="License Plate" className={inputCls} value={form.licensePlate} onChange={(e) => setForm({ ...form, licensePlate: e.target.value })} /></Field>
                    <Field label="License #"><input aria-label="License Number" className={inputCls} value={form.licenseNumber} onChange={(e) => setForm({ ...form, licenseNumber: e.target.value })} /></Field>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Skill class">
                      <select className={inputCls} value={form.skillClass} onChange={(e) => setForm({ ...form, skillClass: e.target.value })}>
                        {SKILLS.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </Field>
                    <Field label="Pay rate / hr">
                      <div className="relative">
                        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">$</span>
                        <input aria-label="Pay Rate Per Hour" className={`${inputCls} pl-7`} type="number" min={0} step="0.5" value={form.payRatePerHour ?? 0} onChange={(e) => setForm({ ...form, payRatePerHour: Number(e.target.value) || 0 })} />
                      </div>
                    </Field>
                  </div>
                  <Field label="Skills" hint="Pick from the library or type a new skill and press Enter">
                    <SkillPicker value={form.skills ?? []} onChange={(skills) => setForm({ ...form, skills })} />
                  </Field>
                  <Field label="Home address">
                    <AddressAutocomplete value={form.address} onResolve={(v) => setForm({ ...form, address: v.address })} />
                  </Field>
                  <Field label="Notes">
                    <textarea aria-label="Notes" className={inputCls} rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                  </Field>
                  <div className="flex justify-end">
                    <BtnPrimary disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save profile"}</BtnPrimary>
                  </div>

                  <div className="rounded-lg border border-white/10 bg-ink-2/60 p-3">
                    <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-white/70">
                      <KeyRound className="h-3.5 w-3.5" /> Reset password
                    </p>
                    <div className="flex gap-2">
                      <input
                        aria-label="New password"
                        type="text"
                        className={inputCls}
                        value={newPw}
                        onChange={(e) => { setNewPw(e.target.value); setPwErr(""); }}
                        placeholder="New temporary password (min 8 chars)"
                      />
                      <BtnGhost
                        onClick={() => {
                          setPwErr("");
                          if (newPw.length < 8) { setPwErr("Password must be at least 8 characters."); return; }
                          resetPw.mutate({ userId: rider.userId, password: newPw });
                        }}
                        disabled={resetPw.isPending}
                      >
                        {resetPw.isPending ? "Resetting…" : "Reset"}
                      </BtnGhost>
                    </div>
                    {pwErr && <p className="mt-2 text-xs text-red-400">{pwErr}</p>}
                    {pwMsg && <p className="mt-2 text-xs text-emerald-400">{pwMsg}</p>}
                    <p className="mt-1.5 text-[11px] text-white/40">Share this temporary password with them; they can change it after signing in.</p>
                  </div>

                  <div className="border-t border-white/10 pt-4">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Tags</p>
                    <TagPicker scope="tech" entityType="tech" entityId={riderId} />
                  </div>
                  <div className="border-t border-white/10 pt-4">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Custom fields</p>
                    <CustomFieldsForm entity="tech" entityType="tech" entityId={riderId} />
                  </div>
                </>
              )}

              {tab === "jobs" && (
                bookingsQ.isLoading ? (
                  <p className="py-8 text-center text-sm text-slate-500">Loading job history…</p>
                ) : techJobs.length === 0 ? (
                  <p className="py-8 text-center text-sm text-slate-500">No jobs assigned to this technician yet.</p>
                ) : (
                  <div className="space-y-2">
                    {techJobs.map((b: any) => (
                      <div
                        key={b.id}
                        {...activate(() => openJob(b))}
                        aria-label={`${b.status === "completed" ? "View report for" : "Edit"} ${b.title || b.service?.name || "job"}`}
                        className="flex cursor-pointer items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5 transition hover:border-brand/30 hover:bg-white/[0.05]"
                      >
                        <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand/15 text-cyan-glow"><ClipboardList className="h-4 w-4" /></span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-white">{b.title || b.service?.name || "Service"}</p>
                          <p className="text-[11px] text-slate-500">
                            {b.createdAt ? fmtDateShort(b.createdAt) : "—"} · {b.status}
                          </p>
                        </div>
                        {Number.isFinite(Number(b.total)) && <span className="text-sm font-bold text-emerald-live">${Number(b.total).toFixed(2)}</span>}
                      </div>
                    ))}
                  </div>
                )
              )}

              {tab === "shifts" && <TechShifts riderId={riderId} />}

              {tab === "files" && <AttachmentManager entityType="tech" entityId={riderId} />}
            </div>
          </>
        )}
      </DialogPanel>

      <WorkOrderModal
        open={editJob !== null}
        editBooking={editJob ?? undefined}
        onClose={() => setEditJob(null)}
      />
    </div>
  );
}

function PhotoUploader({ rider }: { rider: any }) {
  const qc = useQueryClient();
  const [err, setErr] = useState("");

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["riders"] });
    qc.invalidateQueries({ queryKey: ["rider", rider.id] });
  };

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/riders/${rider.id}/photo`, {
        method: "POST",
        headers: apiHeaders(),
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Upload failed");
      return data;
    },
    onSuccess: () => { setErr(""); refresh(); },
    onError: (e: any) => setErr(e.message),
  });

  const remove = useMutation({
    mutationFn: async () => {
      await api.riders[":id"].photo.$delete({ param: { id: rider.id } });
    },
    onSuccess: () => { setErr(""); refresh(); },
  });

  return (
    <div className="relative">
      <label
        className="group relative block cursor-pointer"
        title={rider.photoUrl ? "Change photo" : "Add photo"}
      >
        <TechAvatar
          name={rider.name}
          photoUrl={rider.photoUrl}
          color={rider.color}
          className="h-11 w-11"
          textClassName="text-base"
        />
        <span className="absolute inset-0 grid place-items-center rounded-full bg-black/55 opacity-0 transition group-hover:opacity-100">
          {upload.isPending ? (
            <span className="text-[9px] font-semibold text-white">…</span>
          ) : (
            <Camera className="h-4 w-4 text-white" />
          )}
        </span>
        <input aria-label="File upload"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload.mutate(f);
            e.target.value = "";
          }}
        />
      </label>
      {rider.photoUrl && (
        <button
          onClick={() => remove.mutate()}
          title="Remove photo"
          className="absolute -right-1 -top-1 grid h-4 w-4 place-items-center rounded-full bg-red-500 text-white hover:bg-red-600"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
      {err && <p className="absolute left-0 top-12 whitespace-nowrap text-[10px] text-red-400">{err}</p>}
    </div>
  );
}
