import { createMiddleware } from "hono/factory";
import { auth } from "../auth";
import { db } from "../database";
import * as schema from "../database/schema";
import { and, eq } from "drizzle-orm";
import {
  DEFAULT_ROLE_PERMS,
  resolvePerms,
  permAllows,
  isAdminRole,
  isSuperadmin,
} from "../lib/permissions";
import { tdb } from "../database/tenant";

/** Load all role defaults from DB (falling back to seed). Cached briefly. */
let _roleCache: { at: number; map: Record<string, string[]> } | null = null;
export async function loadRoleDefaults(): Promise<Record<string, string[]>> {
  if (_roleCache && Date.now() - _roleCache.at < 10_000) return _roleCache.map;
  const map: Record<string, string[]> = { ...DEFAULT_ROLE_PERMS };
  try {
    const rows = await db.select().from(schema.rolePermissions);
    for (const r of rows) {
      try {
        const arr = JSON.parse(r.perms);
        if (Array.isArray(arr)) map[r.role] = arr.map(String);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* table may not exist yet */
  }
  _roleCache = { at: Date.now(), map };
  return map;
}
export function invalidateRoleCache() {
  _roleCache = null;
}

/**
 * Guard a route by a specific permission key (e.g. "catalog:edit").
 * Admin always passes. Resolves per-person override or role defaults.
 */
export function requirePermission(required: string) {
  return createMiddleware(async (c, next) => {
    const user = c.get("user") as
      | { role?: string; permissions?: string | null }
      | null;
    if (!user) return c.json({ message: "Unauthorized" }, 401);
    const defaults = await loadRoleDefaults();
    const perms = resolvePerms(user, defaults);
    if (!permAllows(perms, required))
      return c.json({ message: "Forbidden" }, 403);
    return next();
  });
}

/**
 * Allow-list of valid tenant ids (the `companies` registry). Cached briefly so
 * the cross-tenant header check is cheap. A superadmin may only switch INTO a
 * company that actually exists — bogus / probing X-Company-Id values are
 * ignored (we fall back to the user's home company).
 */
let _companyCache: { at: number; ids: Set<string> } | null = null;
export async function loadCompanyIds(): Promise<Set<string>> {
  if (_companyCache && Date.now() - _companyCache.at < 10_000)
    return _companyCache.ids;
  const ids = new Set<string>(["default"]);
  try {
    const rows = await db.select().from(schema.companies);
    for (const r of rows) ids.add(r.id);
  } catch {
    /* table may not exist yet */
  }
  _companyCache = { at: Date.now(), ids };
  return ids;
}
export function invalidateCompanyCache() {
  _companyCache = null;
}

/**
 * Every ACTIVE company this person belongs to, newest-role-first is irrelevant —
 * ordered by company id so the picker is stable. One row per company they can
 * act as. An `invited` membership they haven't accepted, or a `disabled` one,
 * is deliberately excluded: it must not grant access.
 */
export async function loadMemberships(userId: string): Promise<
  {
    companyId: string;
    role: string;
    permissions: string | null;
    staffType: string | null;
    managerId: string | null;
  }[]
> {
  try {
    const rows = await db
      .select()
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.userId, userId),
          eq(schema.memberships.status, "active"),
        ),
      );
    return rows
      .map((r) => ({
        companyId: r.companyId,
        role: r.role,
        permissions: r.permissions,
        staffType: r.staffType,
        managerId: r.managerId,
      }))
      .sort((a, b) => a.companyId.localeCompare(b.companyId));
  } catch {
    // Table may not exist yet (pre-migration boot). Fail soft to the legacy
    // single-company path rather than locking everyone out.
    return [];
  }
}

export const authMiddleware = createMiddleware(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const u = session?.user ?? null;
  c.set("session", session?.session ?? null);

  if (!u) {
    c.set("user", null);
    c.set("companyId", "default");
    c.set("memberships", []);
    return next();
  }

  // ---- Multi-company resolution -------------------------------------------
  // A person can work for several companies (a contract technician on both
  // Acme's and Bolt's roster). `user.companyId` is their DEFAULT company; the
  // full set lives in `memberships`, one row per company with the role they
  // hold THERE.
  const userId = (u as { id: string }).id;
  const homeCompany = (u as { companyId?: string }).companyId ?? "default";
  const memberships = await loadMemberships(userId);
  c.set("memberships", memberships);

  // Which company is this request acting as? Priority:
  //   1. X-Company-Id header (the company switcher, and superadmin cross-tenant)
  //   2. the user's default company
  //   3. their first membership (covers a user whose default was removed)
  const requested = (
    c.req.header("X-Company-Id") || c.req.header("x-company-id") || ""
  ).trim();
  const baseRole = (u as { role?: string }).role;

  let companyId = homeCompany;
  if (requested) {
    // A superadmin may act on ANY existing tenant. Everyone else may only
    // switch into a company they are ACTUALLY A MEMBER OF — this is the check
    // that stops a technician at Acme from reading Bolt's jobs by editing a
    // header. Unauthorised values are ignored, never honoured.
    if (isSuperadmin(baseRole)) {
      const allowed = await loadCompanyIds();
      if (allowed.has(requested)) companyId = requested;
    } else if (memberships.some((m) => m.companyId === requested)) {
      companyId = requested;
    }
  }

  // If their default company isn't one they actually belong to (membership
  // revoked, or a stale user.companyId), fall back to a real one rather than
  // leaving them acting as a company they were removed from.
  if (
    memberships.length > 0 &&
    !memberships.some((m) => m.companyId === companyId) &&
    !isSuperadmin(baseRole)
  ) {
    companyId = memberships[0]!.companyId;
  }

  // ---- Per-company role overlay -------------------------------------------
  // The single highest-leverage line in this change. Dozens of handlers read
  // `user.role`, `user.permissions`, `user.staffType`. By overlaying the
  // ACTING company's membership onto the session user here, every one of those
  // checks becomes per-company for free — the same person can be a technician
  // at one company and a manager at another, and each request sees the right
  // one. Superadmin is a platform-level role and is never downgraded by a
  // membership.
  const active = memberships.find((m) => m.companyId === companyId);
  if (active && !isSuperadmin(baseRole)) {
    c.set("user", {
      ...(u as Record<string, unknown>),
      role: active.role,
      permissions: active.permissions,
      staffType: active.staffType,
      managerId: active.managerId,
      companyId,
    } as unknown as typeof u);
  } else {
    c.set("user", u);
  }

  c.set("companyId", companyId);
  return next();
});

/**
 * The company (tenant) id for the current request. Throws if a tenant-scoped
 * handler is somehow reached without one — fail closed, never leak across
 * tenants.
 */
export function tenantId(c: { get: (k: "companyId") => string | undefined }): string {
  const id = c.get("companyId");
  if (!id) throw new Error("tenant_unresolved");
  return id;
}

/**
 * Tenant-scoped DB facade bound to the current request's company. This is the
 * preferred data-access path inside route handlers: every read/write is
 * auto-constrained to the acting tenant (see database/tenant.ts).
 */
export function tx(c: { get: (k: "companyId") => string | undefined }) {
  return tdb(tenantId(c));
}

export const requireAuth = createMiddleware(async (c, next) => {
  if (!c.get("user")) return c.json({ message: "Unauthorized" }, 401);
  return next();
});

export const requireAdmin = createMiddleware(async (c, next) => {
  const user = c.get("user");
  if (!user) return c.json({ message: "Unauthorized" }, 401);
  if (!isAdminRole((user as { role?: string }).role))
    return c.json({ message: "Forbidden" }, 403);
  return next();
});

/** Top-tier guard: only `superadmin` passes. Used for admin-management routes. */
export const requireSuperadmin = createMiddleware(async (c, next) => {
  const user = c.get("user");
  if (!user) return c.json({ message: "Unauthorized" }, 401);
  if (!isSuperadmin((user as { role?: string }).role))
    return c.json({ message: "Forbidden" }, 403);
  return next();
});

// ---------------------------------------------------------------------------
// API-key auth (for external agents / MCP / scripts)
// ---------------------------------------------------------------------------

/** Hash a raw API key with SHA-256 (hex). */
export async function hashApiKey(raw: string): Promise<string> {
  const data = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Generate a fresh API key. Returns { raw, prefix, hashed }. */
export async function generateApiKey(): Promise<{
  raw: string;
  prefix: string;
  hashed: string;
}> {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const body = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const raw = `nvc_${body}`;
  const prefix = raw.slice(0, 12); // "nvc_" + 8 hex chars
  const hashed = await hashApiKey(raw);
  return { raw, prefix, hashed };
}

/**
 * Generate a browser-safe publishable key (nvcpub_). Used by hosted intake
 * forms; it can ONLY drive the public form-submit endpoint, never the REST API.
 */
export async function generatePublicKey(): Promise<{
  raw: string;
  prefix: string;
  hashed: string;
}> {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const body = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const raw = `nvcpub_${body}`;
  const prefix = raw.slice(0, 15); // "nvcpub_" + 8 hex chars
  const hashed = await hashApiKey(raw);
  return { raw, prefix, hashed };
}

/**
 * Resolve a PUBLIC (nvcpub_) key from a raw token string. Returns the owning
 * company + allowed origins, or null. Touches lastUsedAt fire-and-forget.
 * Only matches public keys — secret keys are rejected here.
 */
export async function resolvePublicKey(rawToken: string | undefined | null): Promise<
  | { id: string; companyId: string; allowedOrigins: string[] }
  | null
> {
  if (!rawToken || !rawToken.startsWith("nvcpub_")) return null;
  const hashed = await hashApiKey(rawToken);
  const [row] = await db
    .select()
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.hashedKey, hashed))
    .limit(1);
  if (!row || row.keyType !== "public") return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
  db.update(schema.apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.apiKeys.id, row.id))
    .catch(() => {});
  return {
    id: row.id,
    companyId: row.companyId || "default",
    allowedOrigins: (row.allowedOrigins || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export type ApiKeyContext = {
  id: string;
  label: string;
  scopes: string[];
  companyId: string;
};

/** Extract the bearer token from the Authorization header. */
function bearer(c: { req: { header: (k: string) => string | undefined } }) {
  const h = c.req.header("Authorization") || c.req.header("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/**
 * Resolve an API key from the request. Returns the key context (with scopes)
 * or null. Updates lastUsedAt fire-and-forget. Only matches `nvc_` tokens so
 * Better-Auth session tokens pass through untouched.
 */
export async function resolveApiKey(c: {
  req: { header: (k: string) => string | undefined };
}): Promise<ApiKeyContext | null> {
  const token = bearer(c) || undefined;
  // Only match SECRET keys here. Public (nvcpub_) keys must never drive the REST
  // API — note nvcpub_ also starts with "nvc_" so we explicitly exclude it.
  if (!token || !token.startsWith("nvc_") || token.startsWith("nvcpub_")) return null;
  const hashed = await hashApiKey(token);
  const [row] = await db
    .select()
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.hashedKey, hashed))
    .limit(1);
  if (!row || row.keyType === "public") return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
  // touch lastUsedAt (fire and forget)
  db.update(schema.apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.apiKeys.id, row.id))
    .catch(() => {});
  return {
    id: row.id,
    label: row.label,
    companyId: row.companyId || "default",
    scopes: (row.scopes || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** True if the granted scope list satisfies the required scope. "*" = all. */
export function scopeAllows(granted: string[], required: string): boolean {
  if (granted.includes("*")) return true;
  if (granted.includes(required)) return true;
  // wildcard families e.g. "workorders:*" satisfies "workorders:read"
  const [domain] = required.split(":");
  if (granted.includes(`${domain}:*`)) return true;
  // write implies read for the same domain
  if (required.endsWith(":read") && granted.includes(`${domain}:write`))
    return true;
  return false;
}

/**
 * Dual auth: accept EITHER a logged-in admin session OR a valid API key.
 * Sets c.var.apiKey when an API key was used. Use scopeGuard() per route to
 * enforce specific scopes on the API-key path.
 */
export const requireSessionOrApiKey = createMiddleware(async (c, next) => {
  const user = c.get("user") as { role?: string } | null;
  if (user && isAdminRole(user.role)) return next();
  const key = await resolveApiKey(c);
  if (key) {
    c.set("apiKey", key);
    return next();
  }
  return c.json({ message: "Unauthorized" }, 401);
});
