/**
 * Roles & granular permissions.
 *
 * A permission key = `<module>:<action>`. Actions: view | create | edit | delete
 * (plus a few specials like reports:export, settings:manage).
 *
 * Resolution order for a user:
 *   - role === "admin"            -> ALL permissions (wildcard "*")
 *   - user.permissions (JSON arr) -> explicit per-person override (full replace)
 *   - else                        -> role defaults from role_permissions table
 *                                    (falling back to DEFAULT_ROLE_PERMS seed)
 */

export type Action = "view" | "create" | "edit" | "delete" | "export" | "manage";

export interface ModuleDef {
  key: string;
  label: string;
  /** Which actions are meaningful for this module. */
  actions: Action[];
  group: "operations" | "catalog" | "people" | "insights" | "system";
}

/** Full catalog of modules + the actions each supports. Drives the UI matrix. */
export const PERMISSION_CATALOG: ModuleDef[] = [
  { key: "dashboard",     label: "Dashboard",          actions: ["view"],                              group: "operations" },
  { key: "work_orders",   label: "Work Orders",        actions: ["view", "create", "edit", "delete"],  group: "operations" },
  { key: "scheduler",     label: "Scheduler",          actions: ["view", "create", "edit", "delete"],  group: "operations" },
  { key: "fleet_map",     label: "Fleet Map",          actions: ["view"],                              group: "operations" },
  { key: "catalog",       label: "Catalog",            actions: ["view", "create", "edit", "delete"],  group: "catalog" },
  { key: "parts",         label: "Parts",              actions: ["view", "create", "edit", "delete"],  group: "catalog" },
  { key: "forms",         label: "Form Builder",       actions: ["view", "create", "edit", "delete"],  group: "catalog" },
  { key: "clients",       label: "Clients",            actions: ["view", "create", "edit", "delete"],  group: "people" },
  { key: "techs",         label: "Technicians & Team", actions: ["view", "create", "edit", "delete"],  group: "people" },
  { key: "reviews",       label: "Reviews",            actions: ["view", "edit", "delete"],            group: "people" },
  { key: "zones",         label: "Service Zones",      actions: ["view", "create", "edit", "delete"],  group: "operations" },
  { key: "payouts",       label: "Payouts",            actions: ["view", "edit"],                      group: "insights" },
  { key: "reports",       label: "Reports",            actions: ["view", "export"],                    group: "insights" },
  { key: "notifications", label: "Notifications",      actions: ["view", "edit"],                      group: "system" },
  { key: "automation",    label: "Automation & AI",    actions: ["view", "edit"],                      group: "system" },
  { key: "integrations",  label: "Integrations",       actions: ["view", "edit"],                      group: "system" },
  { key: "api_access",    label: "API & MCP",          actions: ["view", "manage"],                    group: "system" },
  { key: "tags",          label: "Tags & Fields",      actions: ["view", "edit"],                      group: "catalog" },
  { key: "audit",         label: "Audit Log",          actions: ["view"],                              group: "system" },
  { key: "settings",      label: "Settings",           actions: ["view", "manage"],                    group: "system" },
  { key: "permissions",   label: "Roles & Permissions",actions: ["view", "manage"],                    group: "system" },
];

/** Every concrete permission key the system knows about. */
export const ALL_PERMISSIONS: string[] = PERMISSION_CATALOG.flatMap((m) =>
  m.actions.map((a) => `${m.key}:${a}`),
);

export const INTERNAL_ROLES = [
  "superadmin",
  "admin",
  "manager",
  "dispatcher",
  "project_manager",
  "rider",
] as const;
export type InternalRole = (typeof INTERNAL_ROLES)[number];

/**
 * True for any role that carries full (wildcard) admin powers.
 * `superadmin` is a strict superset of `admin`.
 */
export function isAdminRole(role?: string | null): boolean {
  return role === "admin" || role === "superadmin";
}

/** True only for the top-tier role (manage admins + cross-tenant). */
export function isSuperadmin(role?: string | null): boolean {
  return role === "superadmin";
}

/**
 * The superadmin role grants cross-tenant access to every company, so it must
 * never attach to a tenant/customer email. We hard-restrict it to the operator
 * domain. Configurable via SUPERADMIN_EMAIL_DOMAINS (comma-separated); defaults
 * to nvc360.com.
 */
export const SUPERADMIN_DOMAINS = (process.env.SUPERADMIN_EMAIL_DOMAINS ?? "nvc360.com")
  .split(",")
  .map((d: string) => d.trim().toLowerCase())
  .filter(Boolean);

/** True if this email is allowed to hold the superadmin role. */
export function canBeSuperadmin(email?: string | null): boolean {
  const domain = (email ?? "").split("@")[1]?.toLowerCase();
  return !!domain && SUPERADMIN_DOMAINS.includes(domain);
}

export const ROLE_LABELS: Record<string, string> = {
  superadmin: "Super Admin",
  admin: "Admin",
  manager: "Manager",
  dispatcher: "Dispatcher",
  project_manager: "Project Manager",
  rider: "Field Staff",
  customer: "Client",
};

/** helper: give view on all + the listed extra keys. */
function withViewAll(extra: string[]): string[] {
  const views = PERMISSION_CATALOG.filter((m) => m.actions.includes("view")).map(
    (m) => `${m.key}:view`,
  );
  return Array.from(new Set([...views, ...extra]));
}

/**
 * Industry-best-practice seed defaults (confirmed with stakeholder).
 * admin handled separately as wildcard.
 */
export const DEFAULT_ROLE_PERMS: Record<string, string[]> = {
  superadmin: ["*"],
  admin: ["*"],

  // Manager: sees everything (view-all), can create/edit operational + people +
  // catalog modules, but NO deletes on financial/system, payouts view+nothing destructive.
  manager: withViewAll([
    "work_orders:create", "work_orders:edit",
    "scheduler:create", "scheduler:edit",
    "techs:create", "techs:edit",
    "clients:create", "clients:edit",
    "catalog:edit",
    "parts:edit",
    "forms:edit",
    "reviews:edit",
    "reports:export",
    "tags:edit",
    // payouts: view only (already in view-all)
  ]),

  // Dispatcher: work orders, forms, catalogs, parts — full incl delete on those.
  dispatcher: withViewAll([
    "work_orders:create", "work_orders:edit", "work_orders:delete",
    "scheduler:create", "scheduler:edit",
    "catalog:create", "catalog:edit", "catalog:delete",
    "parts:create", "parts:edit", "parts:delete",
    "forms:create", "forms:edit", "forms:delete",
    "clients:create", "clients:edit",
    "reports:export",
    "tags:edit",
    // techs: view only
  ]),

  // Project Manager: oversight — create/edit on jobs/scheduler/clients, view rest.
  project_manager: withViewAll([
    "work_orders:create", "work_orders:edit",
    "scheduler:create", "scheduler:edit",
    "clients:create", "clients:edit",
    "reports:export",
    // techs/catalog/reviews: view only
  ]),

  // Field staff (technician/driver): mobile app only. No web-admin permissions.
  rider: [],
};

/** Resolve the effective permission set for a user object. */
export function resolvePerms(
  user: { role?: string | null; permissions?: string | null } | null | undefined,
  roleDefaults: Record<string, string[]>,
): Set<string> {
  if (!user) return new Set();
  if (isAdminRole(user.role)) return new Set(["*"]);
  // explicit per-person override
  if (user.permissions) {
    try {
      const arr = JSON.parse(user.permissions);
      if (Array.isArray(arr)) return new Set(arr.map(String));
    } catch {
      /* ignore malformed */
    }
  }
  const role = user.role ?? "customer";
  return new Set(roleDefaults[role] ?? DEFAULT_ROLE_PERMS[role] ?? []);
}

/** Does the permission set satisfy the required key? "*" = all. */
export function permAllows(perms: Set<string>, required: string): boolean {
  if (perms.has("*")) return true;
  if (perms.has(required)) return true;
  // module-wildcard e.g. "catalog:*"
  const [mod] = required.split(":");
  if (perms.has(`${mod}:*`)) return true;
  // edit implies view; create/delete imply view too
  if (required.endsWith(":view")) {
    for (const a of ["create", "edit", "delete", "manage"]) {
      if (perms.has(`${mod}:${a}`)) return true;
    }
  }
  return false;
}
