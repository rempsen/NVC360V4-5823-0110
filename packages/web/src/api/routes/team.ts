import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { auth } from "../auth";
import { and, eq } from "drizzle-orm";
import {
  requirePermission,
  invalidateRoleCache,
  loadRoleDefaults,
  tenantId,
  tx,
} from "../middleware/auth";
import { attachMembership, isMember, findUserByEmail, detachMembership } from "../lib/memberships";
import { sendJoinCompanyInvite } from "../lib/join-invite";
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
    // The roster is defined by MEMBERSHIPS, not by user.companyId. A technician
    // who works for two companies appears on both rosters, with whatever role
    // they hold at each. Reading user.companyId here would only ever show them
    // on their default company's list.
    const members = await db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.companyId, cid));
    const byUserId = new Map(members.map((m) => [m.userId, m]));
    const allUsers = await db.select().from(schema.user);
    const rows = allUsers.filter((u) => byUserId.has(u.id));
    const internal = rows.filter((u) =>
      INTERNAL.includes(byUserId.get(u.id)?.role ?? u.role ?? ""),
    );
    const riderRows = await tx(c).select(schema.riders);
    const riderByUser = new Map(riderRows.map((r) => [r.userId, r]));
    const roleDefaults = await loadRoleDefaults();
    return c.json({
      employees: internal.map((u) => {
        const rd = riderByUser.get(u.id);
        const m = byUserId.get(u.id);
        // Role/permissions come from the membership — this is what makes the
        // same person a technician here and a manager somewhere else.
        const role = m?.role ?? u.role ?? "";
        const perms = m?.permissions ?? u.permissions;
        return {
          id: u.id,
          name: u.name,
          email: u.email,
          phone: u.phone ?? "",
          role,
          roleLabel: ROLE_LABELS[role] ?? role,
          staffType: m?.staffType ?? u.staffType ?? (role === "rider" ? "technician" : null),
          managerId: m?.managerId ?? null,
          hasOverride: !!perms,
          permissions: Array.from(resolvePerms({ role, permissions: perms }, roleDefaults)),
          riderId: rd?.id ?? null,
          // Shown in the UI so an admin knows this person also works elsewhere.
          membershipStatus: m?.status ?? "active",
          isShared: u.companyId !== cid,
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

    const company = tenantId(c);
    const existing = await findUserByEmail(email);

    // Validate the manager BEFORE minting the account. A manager from another
    // company would leak this employee into that company's org chart, and
    // checking after signUpEmail() left an orphaned login behind on rejection.
    if (managerId) {
      const [mgr] = await db.select().from(schema.user).where(eq(schema.user.id, managerId));
      if (!mgr || !(await isMember(managerId, company)))
        return c.json({ message: "Manager not found" }, 400);
    }

    // ---- Case 1: this person already has a login ---------------------------
    // A contract technician who already works for another company. We do NOT
    // create a second account and we do NOT set a password — that would hand
    // this company control of the person's existing login. Instead they get an
    // "invited" membership and must accept.
    if (existing) {
      if (await isMember(existing.id, company))
        return c.json({ message: "That person is already on your team" }, 409);

      const { membership } = await attachMembership({
        userId: existing.id,
        companyId: company,
        role,
        staffType: role === FIELD_STAFF_ROLE ? (staffType === "driver" ? "driver" : "technician") : null,
        managerId: managerId ?? null,
        status: "invited",
        invitedBy: me.id,
      });

      // Field staff still need a rider profile at THIS company so they appear
      // on this company's map and scheduler. It's separate per company.
      if (role === FIELD_STAFF_ROLE) {
        const [existingRider] = await db
          .select()
          .from(schema.riders)
          .where(and(eq(schema.riders.userId, existing.id), eq(schema.riders.companyId, company)));
        if (!existingRider) {
          await tx(c).insert(schema.riders, {
            userId: existing.id,
            phone: phone ?? existing.phone ?? "",
            vehicle: "Van",
            skillClass: b.skillClass ?? "General",
            skills: b.skills?.join(",") ?? "",
            address: b.address ?? "",
            notes: b.notes ?? "",
            payRatePerHour: b.payRatePerHour ?? 0,
          });
        }
      }

      await sendJoinCompanyInvite({
        email: existing.email,
        name: existing.name,
        companyId: company,
        membershipId: membership!.id,
      }).catch((e) => console.error("join-company invite failed", e));

      return c.json(
        {
          user: { id: existing.id, name: existing.name, email, role },
          existingAccount: true,
          status: "invited",
          message:
            "That email already has an NVC360 login. We've invited them to join your company — they'll keep their existing password.",
        },
        201,
      );
    }

    // ---- Case 2: brand new person ------------------------------------------
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
    const set: Record<string, any> = { role, phone: phone ?? "", companyId: company };
    if (role === FIELD_STAFF_ROLE)
      set.staffType = staffType === "driver" ? "driver" : "technician";
    if (managerId) set.managerId = managerId;
    await db.update(schema.user).set(set).where(eq(schema.user.id, u.id));

    // The membership is what actually grants them their role at this company.
    await attachMembership({
      userId: u.id,
      companyId: company,
      role,
      staffType: role === FIELD_STAFF_ROLE ? (staffType === "driver" ? "driver" : "technician") : null,
      managerId: managerId ?? null,
      status: "active",
      invitedBy: me.id,
    });

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
    const cid = tenantId(c);
    const [membership] = await db
      .select()
      .from(schema.memberships)
      .where(
        and(eq(schema.memberships.userId, id), eq(schema.memberships.companyId, cid)),
      );
    if (!membership) return c.json({ message: "Not found" }, 404);
    // Their role AT THIS COMPANY governs what this admin may change.
    const targetRole = membership.role ?? target.role;

    // Touching an admin-tier account requires superadmin.
    if (isAdminRole(targetRole) && !isSuperadmin(me.role))
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
        if (!mgr || !(await isMember(b.managerId, cid)))
          return c.json({ message: "Manager not found" }, 400);
      }
      updates.managerId = b.managerId || null;
    }

    // Split the update: role/staffType/manager are PER COMPANY and belong on
    // the membership. Name/email/phone are the shared identity.
    const membershipUpdates: Record<string, any> = {};
    if (updates.role !== undefined) membershipUpdates.role = updates.role;
    if (updates.staffType !== undefined) membershipUpdates.staffType = updates.staffType;
    if (updates.managerId !== undefined) membershipUpdates.managerId = updates.managerId;
    if (Object.keys(membershipUpdates).length) {
      membershipUpdates.updatedAt = new Date();
      await db
        .update(schema.memberships)
        .set(membershipUpdates)
        .where(eq(schema.memberships.id, membership.id));
    }

    const identityUpdates: Record<string, any> = {};
    for (const k of ["name", "email", "phone"] as const) {
      if (updates[k] !== undefined) identityUpdates[k] = updates[k];
    }
    if (Object.keys(identityUpdates).length) {
      // Name/email/phone are shared across every company this person works for.
      // Letting a company they merely contract for rename them (or change the
      // email they sign in with) would reach into another tenant's data, so a
      // shared person's identity is only editable by their home company.
      const others = await db
        .select()
        .from(schema.memberships)
        .where(eq(schema.memberships.userId, id));
      if (others.length > 1 && target.companyId !== cid) {
        return c.json(
          {
            message:
              "This person also works for another company, so their name and email can only be changed by their home company. You can still change their role here.",
          },
          403,
        );
      }
      await db.update(schema.user).set(identityUpdates).where(eq(schema.user.id, id));
    }

    // Keep the legacy columns on the user row in step for their HOME company so
    // anything still reading user.role directly stays correct.
    if (target.companyId === cid && Object.keys(membershipUpdates).length) {
      const legacy = { ...membershipUpdates };
      delete legacy.updatedAt;
      await db.update(schema.user).set(legacy).where(eq(schema.user.id, id));
    }
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
    const cid = tenantId(c);
    // tenant guard: can only manage people who are on YOUR roster
    const [membership] = await db
      .select()
      .from(schema.memberships)
      .where(
        and(eq(schema.memberships.userId, id), eq(schema.memberships.companyId, cid)),
      );
    if (!membership) return c.json({ message: "Not found" }, 404);

    const targetRole = membership.role ?? target.role;
    // Deleting an admin-tier account requires superadmin.
    if (isAdminRole(targetRole) && !isSuperadmin(me.role))
      return c.json({ message: "Only a superadmin can delete admin-level accounts" }, 403);
    if (isAdminRole(targetRole)) {
      // don't allow removing the last admin-tier member of this company
      const admins = (
        await db
          .select()
          .from(schema.memberships)
          .where(eq(schema.memberships.companyId, cid))
      ).filter((m) => isAdminRole(m.role) && m.status === "active");
      if (admins.length <= 1)
        return c.json({ message: "Cannot delete the last admin" }, 400);
    }

    // How many companies does this person work for? This decides whether we're
    // removing a relationship or deleting a human.
    const all = await db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, id));

    // Their rider profile is per-company, so it always goes.
    await tx(c).delete(schema.riders, eq(schema.riders.userId, id));

    if (all.length > 1) {
      // They also work for someone else. Deleting the user row here would
      // destroy their login and wipe them from the OTHER company's roster —
      // a catastrophic, silent cross-tenant side effect. Only sever the
      // relationship with this company.
      await detachMembership(id, cid);
      return c.json({
        ok: true,
        removedFromCompany: true,
        deletedAccount: false,
        message:
          "Removed from your company. Their NVC360 login stays active because they also work for another company.",
      });
    }

    // This was their only company — safe to delete the account outright.
    // The membership row cascades with the user.
    await db.delete(schema.user).where(eq(schema.user.id, id));
    return c.json({ ok: true, removedFromCompany: true, deletedAccount: true });
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
