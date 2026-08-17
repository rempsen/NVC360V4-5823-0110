import { usersForCompany, attachMembership, isMember, findUserByEmail, detachMembership } from "../lib/memberships";
import { sendJoinCompanyInvite } from "../lib/join-invite";
import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq } from "drizzle-orm";
import { requireAdmin, tenantId, tx } from "../middleware/auth";
import { auth } from "../auth";
import { isAdminRole, isSuperadmin, canBeSuperadmin, SUPERADMIN_DOMAINS } from "../lib/permissions";
import { z } from "zod";
import { jsonBody, shortText, longText, email as emailField, phone as phoneField } from "../lib/validate";
import type { AppEnv } from "../env";

type SessionUser = { id: string; role?: string };

function safeParse<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string" || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}


/* -------------------------------------------------------------------------- */
/*  Request bodies                                                            */
/*                                                                            */
/*  These four routes read raw `c.req.json()`. The create route leaned on      */
/*  better-auth to validate the email and password, but everything else was    */
/*  written straight through. Reproduced live before this pass:                */
/*                                                                            */
/*   - POST /users with a 20,000-character name -> 201.                        */
/*   - POST /users { phone: {} } -> 201, an object written into a text column. */
/*   - PATCH /users/:id { email: "garbage-not-an-email" } -> 200. That is the  */
/*     account's LOGIN identity: the person can no longer sign in, and the     */
/*     email validation better-auth applies on create was bypassed entirely.   */
/*   - PATCH /users/:id { email: "<an existing user's email>" } -> bare 500 on */
/*     the unique index. Now a 409.                                            */
/*   - PATCH /users/:id { name: 123 } -> 200 with the name stored as "123.0".  */
/*   - PATCH /users/:id { notes: 500,000 chars } and { addresses: 5,000        */
/*     entries } -> 200. One request could bloat a single user row unbounded.  */
/*   - POST /users/:id/reset-password { password: "P".repeat(100_000) } ->     */
/*     200: we then ran the password hasher over 100 KB, which is a cheap way  */
/*     to burn server CPU. { password: 12345678 } (a number) -> bare 500.      */
/*                                                                            */
/*  Note: `role` and `companyId` were already safe on PATCH — the field        */
/*  whitelist never copied them — and that was confirmed live (a PATCH of      */
/*  role: "superadmin" left the role untouched). The schema keeps it that way  */
/*  by stripping unknown keys instead of rejecting them.                       */
/* -------------------------------------------------------------------------- */

const password = z
  .string({ message: "Password is required" })
  .min(8, "Password must be at least 8 characters")
  .max(200, "Password is too long");

/** 'one_time' = a single job, 'repeat' = an ongoing account. */
const CustomerType = z.enum(["one_time", "repeat"], { error: "Unknown account type" });

const UserCreate = z.object({
  // `name` is optional now: the add form collects first + last and the handler
  // composes the display name from them. Older callers that still send a
  // single `name` keep working.
  name: shortText("Name", 200).optional(),
  firstName: shortText("First name", 100).optional(),
  lastName: shortText("Last name", 100).optional(),
  email: emailField(),
  password,
  phone: phoneField.optional(),
  role: z.enum(["customer", "admin", "superadmin"], { error: "Unknown role" }).optional(),
  company: longText(200).optional(),
  website: longText(500).optional(),
  address: longText(500).optional(),
  city: longText(120).optional(),
  region: longText(120).optional(),
  postalCode: longText(40).optional(),
  country: longText(120).optional(),
  customerType: CustomerType.optional(),
});

/** One CRM address / contact entry. Bounded so a row can't be inflated. */
const AddressEntry = z
  .object({
    label: longText(120).optional(),
    line1: longText(500).optional(),
    line2: longText(500).optional(),
    city: longText(120).optional(),
    region: longText(120).optional(),
    postalCode: longText(40).optional(),
    country: longText(120).optional(),
    notes: longText(2_000).optional(),
  })
  .loose();
const ContactEntry = z
  .object({
    name: longText(200).optional(),
    email: longText(320).optional(),
    phone: longText(40).optional(),
    role: longText(120).optional(),
    notes: longText(2_000).optional(),
  })
  .loose();

const UserPatch = z
  .object({
    name: shortText("Name", 200),
    firstName: longText(100),
    lastName: longText(100),
    website: longText(500),
    customerType: CustomerType,
    // A change here changes what the person types to sign in — it has to be a
    // real address, and it has to still be unique (checked in the handler).
    email: emailField(),
    phone: phoneField,
    altPhone: phoneField,
    company: longText(200),
    address: longText(500),
    city: longText(120),
    region: longText(120),
    postalCode: longText(40),
    country: longText(120),
    notes: longText(10_000),
    addresses: z.array(AddressEntry).max(50, "Too many addresses"),
    contacts: z.array(ContactEntry).max(50, "Too many contacts"),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { error: "Nothing to update" });

const ResetPassword = z.object({ password });
const ChangePassword = z.object({
  currentPassword: z.string({ message: "Current password is required" }).min(1, "Current password is required").max(200),
  newPassword: password,
});

export const adminRoutes = new Hono<AppEnv>()
  .get("/stats", requireAdmin, async (c) => {
    const t = tx(c);
    const cid = tenantId(c);

    // Optional date-range filter. `from`/`to` are epoch-ms bounds (inclusive
    // from, exclusive to). `basis` chooses which booking date to filter on:
    //   "scheduled" -> scheduledAt   |   "created" -> createdAt
    const fromRaw = c.req.query("from");
    const toRaw = c.req.query("to");
    const basis = c.req.query("basis") === "created" ? "created" : "scheduled";
    const from = fromRaw ? Number(fromRaw) : null;
    const to = toRaw ? Number(toRaw) : null;
    const hasRange = from != null || to != null;
    const ms = (d: unknown) => (d == null ? null : new Date(d as any).getTime());
    const inRange = (d: unknown) => {
      const v = ms(d);
      if (v == null) return false;
      if (from != null && v < from) return false;
      if (to != null && v >= to) return false;
      return true;
    };

    const allBookings = await t.select(schema.bookings);
    const users = await usersForCompany(cid);
    const riders = await t.select(schema.riders);

    // Apply the range to bookings (on the chosen basis) and to revenue
    // (paid invoices, by paidAt). When no range is set, everything counts.
    const bookings = hasRange
      ? allBookings.filter((b) =>
          inRange(basis === "created" ? b.createdAt : b.scheduledAt),
        )
      : allBookings;
    // "Revenue" is computed the same way here as in the Revenue report
    // (reports.ts): sum of non-cancelled booking totals in range. Previously
    // this summed only *paid invoices*, which almost always read $0 in
    // practice (STRIPE_WEBHOOK_SECRET isn't set, so invoices rarely flip to
    // "paid") while the Revenue report — using booking totals directly —
    // showed the real number. Keeping both pages on the same definition
    // avoids showing two different "Revenue" figures for the same tenant.
    const revenue = bookings
      .filter((b) => b.status !== "cancelled")
      .reduce((s, b) => s + Number(b.total || b.price || 0), 0);
    const active = bookings.filter((b) =>
      ["assigned", "enroute", "arrived", "in_progress"].includes(b.status),
    ).length;
    const completed = bookings.filter((b) => b.status === "completed").length;

    // catalog (products/materials/assemblies) economics across all work orders
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    const catalogRevenue = bookings.reduce((s, b) => s + (b.lineItemsPrice ?? 0), 0);
    const catalogCost = bookings.reduce((s, b) => s + (b.lineItemsCost ?? 0), 0);
    const catalogMargin = round2(catalogRevenue - catalogCost);
    const catalogMarginPct =
      catalogRevenue > 0 ? round2((catalogMargin / catalogRevenue) * 100) : 0;

    return c.json(
      {
        totalBookings: bookings.length,
        activeBookings: active,
        completedBookings: completed,
        revenue: +revenue.toFixed(2),
        // When a range is active, "Clients" / "Technicians" count NEW records
        // added in that window (by createdAt). Otherwise it's the full roster.
        customers: users.filter(
          (u) =>
            (u.role ?? "customer") === "customer" &&
            (!hasRange || inRange(u.createdAt)),
        ).length,
        riders: hasRange
          ? riders.filter((r) => inRange(r.createdAt)).length
          : riders.length,
        catalogRevenue: round2(catalogRevenue),
        catalogCost: round2(catalogCost),
        catalogMargin,
        catalogMarginPct,
      },
      200,
    );
  })
  .get("/users", requireAdmin, async (c) => {
    const cid = tenantId(c);
    const users = await usersForCompany(cid);
    return c.json(
      {
        users: users.map((u) => ({
          id: u.id,
          name: u.name,
          firstName: u.firstName ?? "",
          lastName: u.lastName ?? "",
          email: u.email,
          role: u.role ?? "customer",
          phone: u.phone,
          altPhone: u.altPhone ?? "",
          company: u.company ?? "",
          website: u.website ?? "",
          customerType: u.customerType ?? "",
          address: u.address ?? "",
          city: u.city ?? "",
          region: u.region ?? "",
          postalCode: u.postalCode ?? "",
          country: u.country ?? "",
          notes: u.notes ?? "",
          addresses: safeParse(u.addresses, []),
          contacts: safeParse(u.contacts, []),
          createdAt: u.createdAt,
        })),
      },
      200,
    );
  })
  // create a user account (admin) — clients or dispatchers
  .post("/users", requireAdmin, jsonBody(UserCreate), async (c) => {
    const me = c.get("user") as SessionUser;
    const body = c.req.valid("json");
    const { email, password: pw, phone, role } = body;
    // Display name is composed from first + last when the caller sends the
    // structured pair; a caller that still sends a single `name` wins.
    const composed = [body.firstName, body.lastName].filter(Boolean).join(" ").trim();
    const name = (body.name || composed).trim();
    if (!name) return c.json({ message: "Name is required" }, 400);
    // Admin-tier accounts (admin/superadmin) may only be minted by a superadmin.
    if (isAdminRole(role) && !isSuperadmin(me.role))
      return c.json(
        { message: "Only a superadmin can create admin-level accounts" },
        403,
      );
    const r = role === "superadmin" ? "superadmin" : role === "admin" ? "admin" : "customer";
    // Superadmin is cross-tenant — restrict it to the operator domain.
    if (r === "superadmin" && !canBeSuperadmin(email))
      return c.json(
        { message: `Superadmin is reserved for ${SUPERADMIN_DOMAINS.join(", ")} accounts` },
        403,
      );
    const cid = tenantId(c);
    const existing = await findUserByEmail(email);

    // The same client can be served by more than one company (and the same
    // person can be a client here and a technician elsewhere). Reuse their
    // login instead of rejecting the email — but never set a password for an
    // account that already exists.
    if (existing) {
      if (await isMember(existing.id, cid))
        return c.json({ message: "That person is already in your account" }, 409);
      const { membership } = await attachMembership({
        userId: existing.id,
        companyId: cid,
        role: r,
        status: "invited",
        invitedBy: me.id,
      });
      await sendJoinCompanyInvite({
        email: existing.email,
        name: existing.name,
        companyId: cid,
        membershipId: membership!.id,
      }).catch((e) => console.error("join-company invite failed", e));
      return c.json(
        {
          user: {
            id: existing.id,
            name: existing.name,
            email,
            phone: existing.phone ?? "",
            role: r,
          },
          existingAccount: true,
          status: "invited",
          message:
            "That email already has an NVC360 login. We've invited them to join your company — they'll keep their existing password.",
        },
        201,
      );
    }

    try {
      await auth.api.signUpEmail({
        body: { name, email, password: pw, role: r, phone: phone ?? "" } as any,
      });
    } catch (e: any) {
      return c.json({ message: e?.message ?? "Sign-up failed" }, 400);
    }
    const [u] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, email));
    if (!u) return c.json({ message: "Failed to create user" }, 500);
    await db
      .update(schema.user)
      .set({
        role: r,
        phone: phone ?? "",
        companyId: cid,
        name,
        firstName: body.firstName ?? null,
        lastName: body.lastName ?? null,
        company: body.company ?? null,
        website: body.website ?? null,
        address: body.address ?? null,
        city: body.city ?? null,
        region: body.region ?? null,
        postalCode: body.postalCode ?? null,
        country: body.country ?? null,
        // Only clients carry a buying pattern; a dispatcher never does.
        customerType: r === "customer" ? body.customerType ?? "one_time" : null,
      })
      .where(eq(schema.user.id, u.id));
    await attachMembership({
      userId: u.id,
      companyId: cid,
      role: r,
      status: "active",
      invitedBy: me.id,
    });
    return c.json(
      { user: { id: u.id, name, email, phone: phone ?? "", role: r } },
      201,
    );
  })
  // update a user account (admin) — full CRM-style client record
  .patch("/users/:id", requireAdmin, jsonBody(UserPatch), async (c) => {
    const id = c.req.param("id");
    const b = c.req.valid("json");
    const me = c.get("user") as SessionUser;
    const [target] = await db.select().from(schema.user).where(eq(schema.user.id, id));
    // Membership, not user.companyId: a client shared with another company is
    // still legitimately ours to edit.
    if (!target || !(await isMember(id, tenantId(c))))
      return c.json({ message: "Not found" }, 404);
    // Editing an admin-tier account requires superadmin.
    if (isAdminRole(target.role) && !isSuperadmin(me.role))
      return c.json({ message: "Only a superadmin can modify admin-level accounts" }, 403);

    // Taking an email that already belongs to somebody else used to hit the
    // unique index and surface as a bare 500.
    if (b.email && b.email !== target.email) {
      const [clash] = await db.select().from(schema.user).where(eq(schema.user.email, b.email));
      if (clash && clash.id !== id) return c.json({ message: "Email already in use" }, 409);
    }

    const { addresses, contacts, ...rest } = b;
    const updates: Record<string, any> = { ...rest };
    // Keep the display name in sync when the structured name is edited, so the
    // job cards / emails / exports that read `name` don't drift.
    if ((b.firstName !== undefined || b.lastName !== undefined) && b.name === undefined) {
      const first = b.firstName ?? target.firstName ?? "";
      const last = b.lastName ?? target.lastName ?? "";
      const composed = [first, last].filter(Boolean).join(" ").trim();
      if (composed) updates.name = composed;
    }
    // JSON array fields (multiple addresses / contacts)
    if (addresses !== undefined) updates.addresses = JSON.stringify(addresses);
    if (contacts !== undefined) updates.contacts = JSON.stringify(contacts);
    if (Object.keys(updates).length > 0) {
      await db.update(schema.user).set(updates).where(eq(schema.user.id, id));
    }
    const [u] = await db.select().from(schema.user).where(eq(schema.user.id, id));
    return c.json({
      user: u && {
        ...u,
        addresses: safeParse(u.addresses, []),
        contacts: safeParse(u.contacts, []),
      },
    });
  })
  // delete a user account (admin) — guards self-delete
  // Reset a staff member's password (admin action). Sets a new credential
  // password via better-auth's own hasher so the stored format always matches
  // what the sign-in flow expects. Admin-tier targets require superadmin.
  .post("/users/:id/reset-password", requireAdmin, jsonBody(ResetPassword), async (c) => {
    const id = c.req.param("id");
    const me = c.get("user") as SessionUser;
    const { password: newPw } = c.req.valid("json");
    const [target] = await db.select().from(schema.user).where(eq(schema.user.id, id));
    if (!target || !(await isMember(id, tenantId(c))))
      return c.json({ message: "Not found" }, 404);
    // A person who works for several companies has ONE password. Letting this
    // company reset it would hand them control of that person's account at
    // every other company — the exact takeover the invite flow exists to
    // prevent. They must use "forgot password" themselves instead.
    const memberOf = await db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, id));
    if (memberOf.length > 1)
      return c.json(
        {
          message:
            "This person also works for another company, so their password can't be reset from here. Ask them to use \"Forgot password\" on the sign-in page.",
        },
        403,
      );
    if (isAdminRole(target.role) && !isSuperadmin(me.role))
      return c.json({ message: "Only a superadmin can reset admin-level passwords" }, 403);
    const ctx = await auth.$context;
    const hash = await ctx.password.hash(newPw);
    const [cred] = await db
      .select()
      .from(schema.account)
      .where(eq(schema.account.userId, id));
    if (cred) {
      await db
        .update(schema.account)
        .set({ password: hash, updatedAt: new Date() })
        .where(eq(schema.account.userId, id));
    } else {
      // no credential row yet (e.g. invited but never set a password) — create one
      await db.insert(schema.account).values({
        id: crypto.randomUUID(),
        accountId: id,
        providerId: "credential",
        userId: id,
        password: hash,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    return c.json({ ok: true });
  })
  // Self-service: change my own password. Requires the current password to
  // verify identity before swapping in the new one.
  .post("/me/change-password", requireAdmin, jsonBody(ChangePassword), async (c) => {
    const me = c.get("user") as SessionUser;
    const { currentPassword, newPassword } = c.req.valid("json");
    const ctx = await auth.$context;
    const [cred] = await db
      .select()
      .from(schema.account)
      .where(eq(schema.account.userId, me.id));
    if (!cred?.password) return c.json({ message: "No password set on this account" }, 400);
    const valid = await ctx.password.verify({
      password: currentPassword,
      hash: cred.password,
    });
    if (!valid) return c.json({ message: "Current password is incorrect" }, 400);
    const hash = await ctx.password.hash(newPassword);
    await db
      .update(schema.account)
      .set({ password: hash, updatedAt: new Date() })
      .where(eq(schema.account.userId, me.id));
    return c.json({ ok: true });
  })
  .delete("/users/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const me = c.get("user") as SessionUser;
    if (me.id === id)
      return c.json({ message: "You cannot delete your own account" }, 400);
    const [target] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, id));
    const cid = tenantId(c);
    if (!target || !(await isMember(id, cid)))
      return c.json({ message: "Not found" }, 404);
    // Deleting an admin-tier account requires superadmin.
    if (isAdminRole(target.role) && !isSuperadmin(me.role))
      return c.json({ message: "Only a superadmin can delete admin-level accounts" }, 403);
    // clean up rider profile if any
    await tx(c).delete(schema.riders, eq(schema.riders.userId, id));

    // If they also work for another company, deleting the user row would wipe
    // them from that company's records too. Only end OUR relationship.
    const memberOf = await db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, id));
    if (memberOf.length > 1) {
      await detachMembership(id, cid);
      return c.json(
        {
          ok: true,
          deletedAccount: false,
          message:
            "Removed from your company. Their NVC360 login stays active because they also work for another company.",
        },
        200,
      );
    }

    await db.delete(schema.user).where(eq(schema.user.id, id));
    return c.json({ ok: true, deletedAccount: true }, 200);
  });
