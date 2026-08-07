import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { auth } from "../auth";
import { eq } from "drizzle-orm";
import {
  requirePermission,
  invalidateRoleCache,
  loadRoleDefaults,
  tenantId,
  tx,
} from "../middleware/auth";
import { z } from "zod";
import { parseBody, shortText, optText, email as emailField, phone as phoneField, money, id as idField, longText } from "../lib/validate";
import {
  PERMISSION_CATALOG,
  ALL_PERMISSIONS,
  INTERNAL_ROLES,
  ROLE_LABELS,
  DEFAULT_ROLE_PERMS,
  resolvePerms,
  isAdminRole,
  isSuperadmin,
  canBeSuperadmin,
  SUPERADMIN_DOMAINS,
} from "../lib/permissions";

type SessionUser = { id: string; role?: string };

const INTERNAL = [
  "superadmin",
  "admin",
  "manager",
  "dispatcher",
  "project_manager",
  "rider",
];
const FIELD_STAFF_ROLE = "rider";

/* -------------------------------------------------------------------------- */
/*  Request schemas                                                            */
/*                                                                             */
/*  These routes mint and mutate LOGIN accounts, and they took the body raw.    */
/*  A live probe against :4200 proved all of the following were accepted with   */
/*  a 200/201:                                                                 */
/*    - POST /api/team with a 20,000-character name                            */
/*    - POST /api/team with payRatePerHour: -999 (written straight to the       */
/*      rider profile, where it feeds payout gross pay) and skills as a plain   */
/*      string instead of an array (silently discarded)                        */
/*    - PATCH /api/team/:id with email: "totally not an email", which is a      */
/*      LOCKOUT: the row no longer matches better-auth's account table, so      */
/*      that person can't sign in or reset their password                       */
/*    - PATCH /api/team/:id with managerId: "does-not-exist-id" (dangling       */
/*      reference, and nothing stopped a manager id from another tenant)        */
/*  and PATCH to an email already in use returned a raw 500 from the unique     */
/*  index instead of a 409.                                                     */
/* -------------------------------------------------------------------------- */
const roleField = z.enum(INTERNAL as [string, ...string[]], { message: "Invalid role" });
const staffTypeField = z.enum(["driver", "technician"], {
  message: "Staff type must be driver or technician",
});

const TeamCreate = z.object({
  name: shortText("Name", 120),
  email: emailField(),
  // better-auth enforces its own minimum; this is the outer sanity bound.
  password: z.string({ message: "Password is required" }).min(8, "Password must be at least 8 characters").max(200, "Password is too long"),
  phone: phoneField.optional(),
  role: roleField,
  staffType: staffTypeField.optional(),
  managerId: idField("Manager").nullish(),
  // rider-profile fields, only read when role === "rider"
  vehicle: optText(120),
  skillClass: optText(60),
  color: optText(32),
  licensePlate: optText(32),
  skills: z.array(shortText("Skill", 60)).max(50, "Too many skills").optional(),
  address: optText(300),
  notes: longText(2_000).optional(),
  payRatePerHour: money("Pay rate").optional(),
});

const TeamPatch = z
  .object({
    name: shortText("Name", 120).optional(),
    email: emailField().optional(),
    phone: phoneField.optional(),
    role: roleField.optional(),
    staffType: staffTypeField.optional(),
    // "" and null both mean "clear the manager"
    managerId: z.union([idField("Manager"), z.literal(""), z.null()]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

const PermissionsBody = z.object({
  permissions: z.union([z.array(z.string().max(120)).max(500), z.null()]).optional(),
});

function sanitizePerms(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const valid = new Set([...ALL_PERMISSIONS, "*"]);
  return Array.from(
    new Set(input.map(String).filter((k) => valid.has(k))),
  );
}

export const teamRoutes = new Hono()
  // ---- catalog + role defaults (drives the UI matrix) -------------------
  .get("/catalog", requirePermission("techs:view"), async (c) => {
    const roleDefaults = await loadRoleDefaults();
    return c.json({
      modules: PERMISSION_CATALOG,
      roles: INTERNAL_ROLES.map((r) => ({
        key: r,
        label: ROLE_LABELS[r],
        perms: isAdminRole(r) ? ["*"] : roleDefaults[r] ?? DEFAULT_ROLE_PERMS[r] ?? [],
        locked: isAdminRole(r), // admin & superadmin always full
      })),
    });
  })

  // ---- list all internal employees --------------------------------------
  .get("/", requirePermission("techs:view"), async (c) => {
    const cid = tenantId(c);
    const rows = (await db.select().from(schema.user)).filter((u) => u.companyId === cid);
    const internal = rows.filter((u) => INTERNAL.includes(u.role ?? ""));
    const riderRows = await tx(c).select(schema.riders);
    const riderByUser = new Map(riderRows.map((r) => [r.userId, r]));
    const roleDefaults = await loadRoleDefaults();
    return c.json({
      employees: internal.map((u) => {
        const rd = riderByUser.get(u.id);
        return {
          id: u.id,
          name: u.name,
          email: u.email,
          phone: u.phone ?? "",
          role: u.role ?? "",
          roleLabel: ROLE_LABELS[u.role ?? ""] ?? u.role,
          staffType: u.staffType ?? (u.role === "rider" ? "technician" : null),
          managerId: u.managerId ?? null,
          hasOverride: !!u.permissions,
          permissions: Array.from(resolvePerms(u, roleDefaults)),
          riderId: rd?.id ?? null,
          createdAt: u.createdAt,
        };
      }),
    });
  })

  // ---- create an internal employee of any role --------------------------
  .post("/", requirePermission("techs:create"), async (c) => {
    const b = await parseBody(c, TeamCreate);
    const me = c.get("user") as SessionUser;
    const { name, email, password, phone, role, staffType, managerId } = b;
    // Only a superadmin can mint admin-tier employees.
    if (isAdminRole(role) && !isSuperadmin(me.role))
      return c.json(
        { message: "Only a superadmin can create admin-level accounts" },
        403,
      );
    // The superadmin role is cross-tenant — restrict it to the operator domain.
    if (role === "superadmin" && !canBeSuperadmin(email))
      return c.json(
        { message: `Superadmin is reserved for ${SUPERADMIN_DOMAINS.join(", ")} accounts` },
        403,
      );

    const [exists] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, email));
    if (exists) return c.json({ message: "Email already in use" }, 409);

    // Validate the manager BEFORE minting the account. A manager from another
    // company would leak this employee into that company's org chart, and
    // checking after signUpEmail() left an orphaned login behind on rejection.
    if (managerId) {
      const [mgr] = await db.select().from(schema.user).where(eq(schema.user.id, managerId));
      if (!mgr || mgr.companyId !== tenantId(c))
        return c.json({ message: "Manager not found" }, 400);
    }

    try {
      await auth.api.signUpEmail({
        body: { name, email, password, role, phone: phone ?? "" } as any,
      });
    } catch (e: any) {
      return c.json({ message: e?.message ?? "Sign-up failed" }, 400);
    }
    const [u] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, email));
    if (!u) return c.json({ message: "Failed to create user" }, 500);

    // stamp the new employee with the creating admin's company
    const set: Record<string, any> = { role, phone: phone ?? "", companyId: tenantId(c) };
    if (role === FIELD_STAFF_ROLE)
      set.staffType = staffType === "driver" ? "driver" : "technician";
    if (managerId) set.managerId = managerId;
    await db.update(schema.user).set(set).where(eq(schema.user.id, u.id));

    // field staff also get a rider profile (so they show on map/scheduler)
    if (role === FIELD_STAFF_ROLE) {
      await tx(c).insert(schema.riders, {
        userId: u.id,
        phone: phone ?? "",
        vehicle: staffType === "driver" ? "Van" : "Van",
        skillClass: b.skillClass ?? "General",
        skills: b.skills?.join(",") ?? "",
        address: b.address ?? "",
        notes: b.notes ?? "",
        payRatePerHour: b.payRatePerHour ?? 0,
      });
    }
    return c.json({ user: { id: u.id, name, email, role } }, 201);
  })

  // ---- update an employee (role / type / manager / basics) --------------
  .patch("/:id", requirePermission("techs:edit"), async (c) => {
    const id = c.req.param("id");
    const b = await parseBody(c, TeamPatch);
    const me = c.get("user") as SessionUser;
    const [target] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, id));
    if (!target) return c.json({ message: "Not found" }, 404);
    if (target.companyId !== tenantId(c)) return c.json({ message: "Not found" }, 404);

    // Touching an admin-tier account requires superadmin.
    if (isAdminRole(target.role) && !isSuperadmin(me.role))
      return c.json({ message: "Only a superadmin can modify admin-level accounts" }, 403);

    const updates: Record<string, any> = {};
    for (const k of ["name", "email", "phone"] as const) {
      if (b[k] !== undefined) updates[k] = b[k];
    }
    // A duplicate email hit the unique index and surfaced as a bare 500.
    if (updates.email && updates.email !== target.email) {
      const [clash] = await db
        .select()
        .from(schema.user)
        .where(eq(schema.user.email, updates.email as string));
      if (clash && clash.id !== id) return c.json({ message: "Email already in use" }, 409);
    }
    if (b.role !== undefined) {
      // Promoting/demoting INTO an admin tier requires superadmin.
      if (isAdminRole(b.role) && !isSuperadmin(me.role))
        return c.json({ message: "Only a superadmin can assign admin-level roles" }, 403);
      // The superadmin role is cross-tenant — restrict it to the operator domain.
      // Check the effective email (a new one if also being changed in this PATCH).
      const effectiveEmail = (updates.email as string | undefined) ?? target.email;
      if (b.role === "superadmin" && !canBeSuperadmin(effectiveEmail))
        return c.json(
          { message: `Superadmin is reserved for ${SUPERADMIN_DOMAINS.join(", ")} accounts` },
          403,
        );
      updates.role = b.role;
    }
    if (b.staffType !== undefined) updates.staffType = b.staffType;
    if (b.managerId !== undefined) {
      if (b.managerId) {
        if (b.managerId === id) return c.json({ message: "Someone can't be their own manager" }, 400);
        const [mgr] = await db.select().from(schema.user).where(eq(schema.user.id, b.managerId));
        if (!mgr || mgr.companyId !== tenantId(c))
          return c.json({ message: "Manager not found" }, 400);
      }
      updates.managerId = b.managerId || null;
    }
    if (Object.keys(updates).length)
      await db.update(schema.user).set(updates).where(eq(schema.user.id, id));
    return c.json({ ok: true });
  })

  // ---- delete an employee ------------------------------------------------
  .delete("/:id", requirePermission("techs:delete"), async (c) => {
    const id = c.req.param("id");
    const me = c.get("user") as SessionUser;
    if (me.id === id)
      return c.json({ message: "You cannot delete your own account" }, 400);
    const [target] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, id));
    if (!target) return c.json({ message: "Not found" }, 404);
    // tenant guard: can only manage users in your own company
    if (target.companyId !== tenantId(c))
      return c.json({ message: "Not found" }, 404);
    // Deleting an admin-tier account requires superadmin.
    if (isAdminRole(target.role) && !isSuperadmin(me.role))
      return c.json({ message: "Only a superadmin can delete admin-level accounts" }, 403);
    if (isAdminRole(target.role)) {
      // don't allow deleting the last admin-tier user in this company
      const admins = (await db.select().from(schema.user)).filter(
        (u) => isAdminRole(u.role) && u.companyId === tenantId(c),
      );
      if (admins.length <= 1)
        return c.json({ message: "Cannot delete the last admin" }, 400);
    }
    await tx(c).delete(schema.riders, eq(schema.riders.userId, id));
    await db.delete(schema.user).where(eq(schema.user.id, id));
    return c.json({ ok: true });
  })

  // ---- per-person permission override -----------------------------------
  .put("/:id/permissions", requirePermission("permissions:manage"), async (c) => {
    const id = c.req.param("id");
    const b = await parseBody(c, PermissionsBody);
    const [target] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, id));
    if (!target) return c.json({ message: "Not found" }, 404);
    if (target.companyId !== tenantId(c)) return c.json({ message: "Not found" }, 404);
    // null/undefined => clear override (revert to role defaults)
    if (b.permissions == null) {
      await db
        .update(schema.user)
        .set({ permissions: null })
        .where(eq(schema.user.id, id));
      return c.json({ ok: true, cleared: true });
    }
    const perms = sanitizePerms(b.permissions);
    await db
      .update(schema.user)
      .set({ permissions: JSON.stringify(perms) })
      .where(eq(schema.user.id, id));
    return c.json({ ok: true, permissions: perms });
  })

  // ---- update ROLE default permissions ----------------------------------
  .put("/roles/:role/permissions", requirePermission("permissions:manage"), async (c) => {
    const role = c.req.param("role");
    if (!INTERNAL_ROLES.includes(role as any) || isAdminRole(role))
      return c.json({ message: "Cannot edit this role" }, 400);
    const b = await parseBody(c, PermissionsBody);
    const perms = sanitizePerms(b.permissions);
    const now = new Date();
    const [existing] = await db
      .select()
      .from(schema.rolePermissions)
      .where(eq(schema.rolePermissions.role, role));
    if (existing) {
      await db
        .update(schema.rolePermissions)
        .set({ perms: JSON.stringify(perms), updatedAt: now })
        .where(eq(schema.rolePermissions.role, role));
    } else {
      await db
        .insert(schema.rolePermissions)
        .values({ role, perms: JSON.stringify(perms), updatedAt: now });
    }
    invalidateRoleCache();
    return c.json({ ok: true, role, permissions: perms });
  });

/** Seed role_permissions with industry defaults if empty. */
export async function seedRolePermissions() {
  try {
    const rows = await db.select().from(schema.rolePermissions);
    if (rows.length > 0) return;
    const now = new Date();
    const vals = INTERNAL_ROLES.filter((r) => !isAdminRole(r)).map((r) => ({
      role: r,
      perms: JSON.stringify(DEFAULT_ROLE_PERMS[r] ?? []),
      updatedAt: now,
    }));
    if (vals.length) await db.insert(schema.rolePermissions).values(vals);
  } catch (e) {
    console.error("seedRolePermissions failed", e);
  }
}
