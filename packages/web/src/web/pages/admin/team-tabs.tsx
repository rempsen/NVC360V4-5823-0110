import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useAuth } from "../../hooks/use-auth";
import { FullLoader } from "../../components/loader";
import {
  Modal,
  Field,
  inputCls,
  BtnPrimary,
  BtnGhost,
  ConfirmModal,
} from "../../components/modal";
import {
  Shield,
  UserPlus,
  Trash2,
  Mail,
  Phone,
  Pencil,
  Check,
  RotateCcw,
  Save,
  Crown,
  Users,
  Wrench,
  Truck,
  KeyRound,
} from "lucide-react";
import { useWorkerNoun } from "../../lib/use-brand";

// ---------------------------------------------------------------------------
// Shared role metadata (mirrors backend lib/permissions.ts)
// ---------------------------------------------------------------------------
const ROLE_META: Record<
  string,
  { label: string; tint: string; icon: any; desc: string }
> = {
  superadmin: {
    label: "Super Admin",
    tint: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    icon: Crown,
    desc: "Top tier — manages admins & has cross-company access",
  },
  admin: {
    label: "Admin",
    tint: "bg-rose-500/15 text-rose-300 border-rose-500/30",
    icon: Crown,
    desc: "Full control of every system and feature",
  },
  manager: {
    label: "Manager",
    tint: "bg-violet-500/15 text-violet-300 border-violet-500/30",
    icon: Users,
    desc: "Oversees techs & drivers; broad access, limited deletes",
  },
  dispatcher: {
    label: "Dispatcher",
    tint: "bg-cyan-500/15 text-cyan-glow border-cyan-500/30",
    icon: Shield,
    desc: "Work orders, scheduling, forms, catalog & parts",
  },
  project_manager: {
    label: "Project Manager",
    tint: "bg-amber-500/15 text-amber-warn border-amber-500/30",
    icon: Shield,
    desc: "Oversight on jobs, scheduling & clients",
  },
  rider: {
    label: "Field Staff",
    tint: "bg-emerald-500/15 text-emerald-live border-emerald-500/30",
    icon: Wrench,
    desc: "Technicians & drivers — mobile app",
  },
};

const ACTION_LABEL: Record<string, string> = {
  view: "View",
  create: "Create",
  edit: "Edit",
  delete: "Delete",
  export: "Export",
  manage: "Manage",
};

function useCatalog() {
  return useQuery({
    queryKey: ["team-catalog"],
    queryFn: async () => (await api.team.catalog.$get()).json(),
  });
}

// ===========================================================================
// INTERNAL TEAM TAB
// ===========================================================================
export function InternalTeamTab() {
  const qc = useQueryClient();
  const { noun } = useWorkerNoun();
  const [showAdd, setShowAdd] = useState(false);
  const [editEmp, setEditEmp] = useState<any>(null);
  const [delEmp, setDelEmp] = useState<any>(null);
  const [permEmp, setPermEmp] = useState<any>(null);
  const [err, setErr] = useState("");
  const [newPw, setNewPw] = useState("");
  const [pwMsg, setPwMsg] = useState("");
  const [inviteMsg, setInviteMsg] = useState("");
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    phone: "",
    role: "dispatcher",
    staffType: "technician",
  });

  const team = useQuery({
    queryKey: ["team"],
    queryFn: async () => (await api.team.$get()).json(),
  });

  const create = useMutation({
    mutationFn: async () => {
      const res = await api.team.$post({ json: form as any });
      const data = await res.json();
      if (!res.ok) throw new Error((data as any).message || "Failed");
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team"] });
      qc.invalidateQueries({ queryKey: ["riders"] });
      setShowAdd(false);
      setForm({ name: "", email: "", password: "", phone: "", role: "dispatcher", staffType: "technician" });
      setErr("");
    },
    onError: (e: any) => setErr(e.message),
  });

  const update = useMutation({
    mutationFn: async (payload: any) => {
      const res = await api.team[":id"].$patch({ param: { id: payload.id }, json: payload });
      const data = await res.json();
      if (!res.ok) throw new Error((data as any).message || "Failed");
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team"] });
      setEditEmp(null);
    },
    onError: (e: any) => setErr(e.message),
  });

  const resetPw = useMutation({
    mutationFn: async (payload: { id: string; password: string }) => {
      const res = await (api as any).admin.users[":id"]["reset-password"].$post({
        param: { id: payload.id },
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
    onError: (e: any) => setErr(e.message),
  });

  /**
   * An invite that lands in spam otherwise leaves the person stuck as "Invite
   * pending" with no way for the admin to nudge them.
   */
  const resendInvite = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.team[":id"]["resend-invite"].$post({ param: { id } });
      const data = await res.json();
      if (!res.ok) throw new Error((data as any).message || "Couldn't resend");
      return data as { email?: string };
    },
    onSuccess: (d) => {
      setInviteMsg(`Invite re-sent to ${d?.email ?? "them"}.`);
      setTimeout(() => setInviteMsg(""), 4000);
    },
    onError: (e: any) => setErr(e.message),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const res = await api.team[":id"].$delete({ param: { id } });
      const data = await res.json();
      if (!res.ok) throw new Error((data as any).message || "Failed");
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team"] });
      setDelEmp(null);
    },
    onError: (e: any) => { setErr(e.message); setDelEmp(null); },
  });

  if (team.isLoading) return <FullLoader label="Loading team…" />;
  const employees = (team.data?.employees ?? []).filter(
    (e: any) => e.role !== "rider",
  );

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-slate-400">
          {employees.length} internal {employees.length === 1 ? "employee" : "employees"} — admins, managers, dispatchers & project managers
        </p>
        <BtnPrimary onClick={() => { setErr(""); setShowAdd(true); }}>
          <UserPlus className="h-4 w-4" /> New Employee
        </BtnPrimary>
      </div>

      {inviteMsg && (
        <output className="mb-3 block rounded-lg bg-emerald-live/10 px-3 py-2 text-xs font-medium text-emerald-live">
          {inviteMsg}
        </output>
      )}

      {employees.length === 0 ? (
        <div className="nvc-card grid place-items-center py-16 text-center text-slate-500">
          No internal employees yet. Create one with “New Employee”.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {employees.map((e: any) => {
            const meta = ROLE_META[e.role] ?? ROLE_META.dispatcher;
            const Icon = meta.icon;
            return (
              <div key={e.id} className="nvc-card group relative p-4">
                <div className="absolute right-3 top-3 flex gap-1 opacity-0 transition group-hover:opacity-100">
                  <button onClick={() => { setErr(""); setNewPw(""); setPwMsg(""); setEditEmp({ ...e }); }} title="Edit" className="grid h-7 w-7 place-items-center rounded-lg text-slate-500 hover:bg-white/5 hover:text-cyan-glow">
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => setDelEmp(e)} title="Remove" className="grid h-7 w-7 place-items-center rounded-lg text-slate-500 hover:bg-red-500/10 hover:text-red-400">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex items-center gap-3">
                  <div className={`grid h-12 w-12 place-items-center rounded-xl border ${meta.tint}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-bold text-white">{e.name}</h3>
                    <div className="flex flex-wrap items-center gap-1">
                      <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${meta.tint}`}>
                        {meta.label}
                      </span>
                      {/* This person works for another company too. Their name,
                          email and password are owned there — only their role
                          here can be changed. */}
                      {e.isShared && (
                        <span
                          title="Also works for another company. Their login and contact details are managed there."
                          className="inline-block rounded-full border border-violet-400/30 bg-violet-400/10 px-2 py-0.5 text-[11px] font-semibold text-violet-300"
                        >
                          Shared
                        </span>
                      )}
                      {e.membershipStatus === "invited" && (
                        <button
                          type="button"
                          disabled={resendInvite.isPending}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            resendInvite.mutate(e.id);
                          }}
                          title="Invite sent — they haven't accepted yet, so they can't see your jobs. Click to send it again."
                          className="inline-flex items-center gap-1 rounded-full border border-amber-warn/30 bg-amber-warn/10 px-2 py-0.5 text-[11px] font-semibold text-amber-warn transition hover:bg-amber-warn/20 disabled:opacity-50"
                        >
                          Invite pending
                          <span className="text-amber-warn/70">· resend</span>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                <div className="mt-3 space-y-1 border-t border-white/5 pt-3 text-xs text-slate-400">
                  {e.email && <p className="flex items-center gap-1.5 truncate"><Mail className="h-3.5 w-3.5 shrink-0" /> {e.email}</p>}
                  {e.phone && <p className="flex items-center gap-1.5"><Phone className="h-3.5 w-3.5" /> {e.phone}</p>}
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-white/5 pt-3">
                  <span className="text-[11px] text-slate-500">
                    {e.hasOverride ? (
                      <span className="text-amber-warn">Custom permissions</span>
                    ) : (
                      `${e.permissions.length} permissions (role default)`
                    )}
                  </span>
                  <button onClick={() => setPermEmp(e)} className="text-[11px] font-semibold text-cyan-glow hover:underline">
                    Permissions →
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create modal */}
      {showAdd && (
        <Modal open onClose={() => setShowAdd(false)} title="New Internal Employee">
          <div className="space-y-3">
            <RolePicker value={form.role} onChange={(role) => setForm((f) => ({ ...f, role }))} />
            {form.role === "rider" && (
              <Field label="Field staff type">
                <div className="flex gap-2">
                  {[["technician", noun, Wrench], ["driver", "Driver", Truck]].map(([v, label, Ic]: any) => (
                    <button key={v} type="button" onClick={() => setForm((f) => ({ ...f, staffType: v }))}
                      className={`flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition ${form.staffType === v ? "border-brand bg-brand/15 text-cyan-glow" : "border-white/10 bg-ink-2 text-slate-400 hover:bg-white/5"}`}>
                      <Ic className="h-4 w-4" /> {label}
                    </button>
                  ))}
                </div>
              </Field>
            )}
            <Field label="Full name"><input aria-label="Jane Doe" className={inputCls} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Jane Doe" /></Field>
            <Field label="Email"><input aria-label="jane@company.com" className={inputCls} value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} placeholder="jane@company.com" /></Field>
            <Field label="Phone"><input aria-label="+1 555 000 0000" className={inputCls} value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="+1 555 000 0000" /></Field>
            <Field label="Temporary password"><input aria-label="At least 8 characters" className={inputCls} value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} placeholder="At least 8 characters" /></Field>
            {err && <p className="text-sm text-red-400">{err}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <BtnGhost onClick={() => setShowAdd(false)}>Cancel</BtnGhost>
              <BtnPrimary onClick={() => create.mutate()} disabled={create.isPending}>
                {create.isPending ? "Creating…" : "Create employee"}
              </BtnPrimary>
            </div>
          </div>
        </Modal>
      )}

      {/* Edit modal */}
      {editEmp && (
        <Modal open onClose={() => setEditEmp(null)} title="Edit Employee">
          <div className="space-y-3">
            <RolePicker value={editEmp.role} onChange={(role) => setEditEmp((e: any) => ({ ...e, role }))} />
            {editEmp.role === "rider" && (
              <Field label="Field staff type">
                <div className="flex gap-2">
                  {[["technician", noun, Wrench], ["driver", "Driver", Truck]].map(([v, label, Ic]: any) => (
                    <button key={v} type="button" onClick={() => setEditEmp((e: any) => ({ ...e, staffType: v }))}
                      className={`flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition ${editEmp.staffType === v ? "border-brand bg-brand/15 text-cyan-glow" : "border-white/10 bg-ink-2 text-slate-400 hover:bg-white/5"}`}>
                      <Ic className="h-4 w-4" /> {label}
                    </button>
                  ))}
                </div>
              </Field>
            )}
            <Field label="Full name"><input aria-label="Name" className={inputCls} value={editEmp.name ?? ""} onChange={(e) => setEditEmp((p: any) => ({ ...p, name: e.target.value }))} /></Field>
            <Field label="Phone"><input aria-label="Phone" className={inputCls} value={editEmp.phone ?? ""} onChange={(e) => setEditEmp((p: any) => ({ ...p, phone: e.target.value }))} /></Field>

            {/* Reset password */}
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
                  onChange={(e) => setNewPw(e.target.value)}
                  placeholder="New temporary password (min 8 chars)"
                />
                <BtnGhost
                  onClick={() => {
                    setErr("");
                    if (newPw.length < 8) { setErr("Password must be at least 8 characters."); return; }
                    resetPw.mutate({ id: editEmp.id, password: newPw });
                  }}
                  disabled={resetPw.isPending}
                >
                  {resetPw.isPending ? "Resetting…" : "Reset"}
                </BtnGhost>
              </div>
              {pwMsg && <p className="mt-2 text-xs text-emerald-400">{pwMsg}</p>}
              <p className="mt-1.5 text-[11px] text-white/40">Share this temporary password with them; they can change it after signing in.</p>
            </div>

            {err && <p className="text-sm text-red-400">{err}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <BtnGhost onClick={() => setEditEmp(null)}>Cancel</BtnGhost>
              <BtnPrimary onClick={() => update.mutate({ id: editEmp.id, name: editEmp.name, phone: editEmp.phone, role: editEmp.role, staffType: editEmp.staffType })} disabled={update.isPending}>
                {update.isPending ? "Saving…" : "Save changes"}
              </BtnPrimary>
            </div>
          </div>
        </Modal>
      )}

      {/* Per-person permission override */}
      {permEmp && (
        <PersonPermissionModal emp={permEmp} onClose={() => setPermEmp(null)} />
      )}

      {delEmp && (
        <ConfirmModal
          open
          title="Remove employee?"
          message={`This permanently deletes ${delEmp.name}'s account and access. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          pending={del.isPending}
          onClose={() => setDelEmp(null)}
          onConfirm={() => del.mutate(delEmp.id)}
        />
      )}
    </>
  );
}

function RolePicker({ value, onChange }: { value: string; onChange: (r: string) => void }) {
  const { role: myRole } = useAuth();
  // Only a superadmin may assign admin-tier roles.
  const roles =
    myRole === "superadmin"
      ? ["superadmin", "admin", "manager", "dispatcher", "project_manager", "rider"]
      : ["manager", "dispatcher", "project_manager", "rider"];
  return (
    <Field label="Role">
      <div className="grid grid-cols-1 gap-2">
        {roles.map((r) => {
          const meta = ROLE_META[r];
          const Icon = meta.icon;
          const active = value === r;
          return (
            <button key={r} type="button" onClick={() => onChange(r)}
              className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition ${active ? "border-brand bg-brand/10" : "border-white/10 bg-ink-2 hover:bg-white/5"}`}>
              <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border ${meta.tint}`}>
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className={`block text-sm font-semibold ${active ? "text-white" : "text-slate-300"}`}>{meta.label}</span>
                <span className="block text-[11px] text-slate-500">{meta.desc}</span>
              </span>
              {active && <Check className="ml-auto h-4 w-4 text-cyan-glow" />}
            </button>
          );
        })}
      </div>
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Per-person permission override modal
// ---------------------------------------------------------------------------
function PersonPermissionModal({ emp, onClose }: { emp: any; onClose: () => void }) {
  const qc = useQueryClient();
  const cat = useCatalog();
  const [sel, setSel] = useState<Set<string>>(new Set(emp.permissions ?? []));
  const [override, setOverride] = useState<boolean>(!!emp.hasOverride);

  const save = useMutation({
    mutationFn: async (clear: boolean) => {
      const res = await api.team[":id"].permissions.$put({
        param: { id: emp.id },
        json: clear ? { permissions: null } : { permissions: Array.from(sel) },
      } as any);
      const data = await res.json();
      if (!res.ok) throw new Error((data as any).message || "Failed");
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team"] });
      onClose();
    },
  });

  const isAdmin = emp.role === "admin" || emp.role === "superadmin";

  return (
    <Modal open onClose={onClose} title={`Permissions — ${emp.name}`} size="lg">
      {isAdmin ? (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200">
          <Crown className="mb-1 inline h-4 w-4" /> Admins always have full access to every feature. This cannot be restricted.
        </div>
      ) : (
        <div className="space-y-4">
          <label className="flex items-center gap-2 rounded-lg border border-white/10 bg-ink-2 p-3 text-sm">
            <input aria-label="Override" type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} className="h-4 w-4 accent-cyan-500" />
            <span className="text-slate-300">
              Use custom permissions for this person
              <span className="block text-[11px] text-slate-500">When off, this person inherits the <b>{ROLE_META[emp.role]?.label}</b> role defaults.</span>
            </span>
          </label>

          {override && (cat.isLoading ? <FullLoader label="Loading…" /> : (
            <PermissionMatrixSingle modules={(cat.data as any).modules} selected={sel} setSelected={setSel} />
          ))}

          <div className="flex justify-end gap-2 border-t border-white/5 pt-3">
            <BtnGhost onClick={onClose}>Cancel</BtnGhost>
            <BtnPrimary onClick={() => save.mutate(!override)} disabled={save.isPending}>
              <Save className="h-4 w-4" /> {save.isPending ? "Saving…" : override ? "Save custom permissions" : "Revert to role default"}
            </BtnPrimary>
          </div>
        </div>
      )}
    </Modal>
  );
}

// A simple module x action checkbox grid for a single permission set.
function PermissionMatrixSingle({
  modules,
  selected,
  setSelected,
}: {
  modules: any[];
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
}) {
  function toggle(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else {
      next.add(key);
      // selecting any action implies view
      const mod = key.split(":")[0];
      if (!key.endsWith(":view")) next.add(`${mod}:view`);
    }
    setSelected(next);
  }
  return (
    <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-white/10">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-ink-2 text-left text-[11px] uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-3 py-2">Module</th>
            <th className="px-3 py-2">Permissions</th>
          </tr>
        </thead>
        <tbody>
          {modules.map((m: any) => (
            <tr key={m.key} className="border-t border-white/5">
              <td className="px-3 py-2 font-medium text-slate-300">{m.label}</td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1.5">
                  {m.actions.map((a: string) => {
                    const key = `${m.key}:${a}`;
                    const on = selected.has(key);
                    return (
                      <button key={a} type="button" onClick={() => toggle(key)}
                        className={`rounded-md px-2 py-1 text-[11px] font-semibold transition ${on ? "bg-brand text-white" : "bg-ink text-slate-500 hover:bg-white/5"}`}>
                        {ACTION_LABEL[a] ?? a}
                      </button>
                    );
                  })}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ===========================================================================
// ROLES & PERMISSIONS TAB (role defaults editor)
// ===========================================================================
export function RolesPermissionsTab() {
  const qc = useQueryClient();
  const cat = useCatalog();
  const [activeRole, setActiveRole] = useState<string>("manager");
  const [draft, setDraft] = useState<Record<string, Set<string>>>({});

  const roles = useMemo(() => (cat.data as any)?.roles ?? [], [cat.data]);
  const modules = (cat.data as any)?.modules ?? [];

  const current = useMemo(() => {
    if (draft[activeRole]) return draft[activeRole];
    const r = roles.find((x: any) => x.key === activeRole);
    return new Set<string>(r?.perms ?? []);
  }, [activeRole, draft, roles]);

  const save = useMutation({
    mutationFn: async () => {
      const res = await api.team.roles[":role"].permissions.$put({
        param: { role: activeRole },
        json: { permissions: Array.from(current) },
      } as any);
      const data = await res.json();
      if (!res.ok) throw new Error((data as any).message || "Failed");
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team-catalog"] });
      qc.invalidateQueries({ queryKey: ["team"] });
      setDraft((d) => { const n = { ...d }; delete n[activeRole]; return n; });
    },
  });

  if (cat.isLoading) return <FullLoader label="Loading permissions…" />;

  const activeMeta = ROLE_META[activeRole];
  const isAdmin = activeRole === "admin" || activeRole === "superadmin";
  const dirty = !!draft[activeRole];

  function setCurrent(next: Set<string>) {
    setDraft((d) => ({ ...d, [activeRole]: next }));
  }
  function toggle(key: string) {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else {
      next.add(key);
      const mod = key.split(":")[0];
      if (!key.endsWith(":view")) next.add(`${mod}:view`);
    }
    setCurrent(next);
  }
  function toggleModuleAll(m: any, on: boolean) {
    const next = new Set(current);
    for (const a of m.actions) {
      const key = `${m.key}:${a}`;
      if (on) next.add(key);
      else next.delete(key);
    }
    setCurrent(next);
  }

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      {/* role rail */}
      <div className="flex shrink-0 gap-2 overflow-x-auto lg:w-56 lg:flex-col">
        {roles.map((r: any) => {
          const meta = ROLE_META[r.key];
          const Icon = meta.icon;
          const sel = activeRole === r.key;
          return (
            <button key={r.key} onClick={() => setActiveRole(r.key)}
              className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition ${sel ? "border-brand bg-brand/10" : "border-white/10 bg-ink-2 hover:bg-white/5"}`}>
              <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border ${meta.tint}`}><Icon className="h-4 w-4" /></span>
              <span className="min-w-0">
                <span className={`block whitespace-nowrap text-sm font-semibold ${sel ? "text-white" : "text-slate-300"}`}>{meta.label}</span>
                <span className="block text-[11px] text-slate-500">{(r.key === "admin" || r.key === "superadmin") ? "Full access" : `${r.perms.length} perms`}</span>
              </span>
            </button>
          );
        })}
      </div>

      {/* editor */}
      <div className="min-w-0 flex-1">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="flex items-center gap-2 font-bold text-white">{activeMeta.label} permissions</h3>
            <p className="text-xs text-slate-500">{activeMeta.desc}</p>
          </div>
          {!isAdmin && (
            <BtnPrimary onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
              <Save className="h-4 w-4" /> {save.isPending ? "Saving…" : dirty ? "Save changes" : "Saved"}
            </BtnPrimary>
          )}
        </div>

        {isAdmin ? (
          <div className="nvc-card flex items-center gap-3 border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200">
            <Crown className="h-5 w-5 shrink-0" /> Admins have unrestricted access to every module and action by design.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-white/10">
            <table className="w-full text-sm">
              <thead className="bg-ink-2 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Module</th>
                  <th className="px-3 py-2">Allowed actions</th>
                  <th className="px-3 py-2 text-right">All</th>
                </tr>
              </thead>
              <tbody>
                {modules.map((m: any) => {
                  const allOn = m.actions.every((a: string) => current.has(`${m.key}:${a}`));
                  return (
                    <tr key={m.key} className="border-t border-white/5">
                      <td className="px-3 py-2.5 font-medium text-slate-300">{m.label}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1.5">
                          {m.actions.map((a: string) => {
                            const key = `${m.key}:${a}`;
                            const on = current.has(key);
                            return (
                              <button key={a} type="button" onClick={() => toggle(key)}
                                className={`rounded-md px-2 py-1 text-[11px] font-semibold transition ${on ? "bg-brand text-white" : "bg-ink text-slate-500 hover:bg-white/5"}`}>
                                {ACTION_LABEL[a] ?? a}
                              </button>
                            );
                          })}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <input aria-label="All On" type="checkbox" checked={allOn} onChange={(e) => toggleModuleAll(m, e.target.checked)} className="h-4 w-4 accent-cyan-500" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!isAdmin && dirty && (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-warn">
            <RotateCcw className="h-3 w-3" /> Unsaved changes
          </p>
        )}
      </div>
    </div>
  );
}
