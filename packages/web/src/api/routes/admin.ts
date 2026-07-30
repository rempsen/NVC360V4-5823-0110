import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq } from "drizzle-orm";
import { requireAdmin, tenantId, tx } from "../middleware/auth";
import { auth } from "../auth";
import { isAdminRole, isSuperadmin, canBeSuperadmin, SUPERADMIN_DOMAINS } from "../lib/permissions";

type SessionUser = { id: string; role?: string };

function safeParse<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string" || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

export const adminRoutes = new Hono()
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
    const users = (await db.select().from(schema.user)).filter((u) => u.companyId === cid);
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
    const users = (await db.select().from(schema.user)).filter((u) => u.companyId === cid);
    return c.json(
      {
        users: users.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role ?? "customer",
          phone: u.phone,
          altPhone: u.altPhone ?? "",
          company: u.company ?? "",
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
  .post("/users", requireAdmin, async (c) => {
    const body = await c.req.json();
    const me = c.get("user") as SessionUser;
    const { name, email, password, phone, role } = body;
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
    if (!name || !email || !password)
      return c.json({ message: "Name, email and password are required" }, 400);

    const [exists] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, email));
    if (exists) return c.json({ message: "Email already in use" }, 409);

    try {
      await auth.api.signUpEmail({
        body: { name, email, password, role: r, phone: phone ?? "" } as any,
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
      .set({ role: r, phone: phone ?? "", companyId: tenantId(c) })
      .where(eq(schema.user.id, u.id));
    return c.json(
      { user: { id: u.id, name, email, phone: phone ?? "", role: r } },
      201,
    );
  })
  // update a user account (admin) — full CRM-style client record
  .patch("/users/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const b = await c.req.json();
    const me = c.get("user") as SessionUser;
    const [target] = await db.select().from(schema.user).where(eq(schema.user.id, id));
    if (!target || target.companyId !== tenantId(c)) return c.json({ message: "Not found" }, 404);
    // Editing an admin-tier account requires superadmin.
    if (isAdminRole(target.role) && !isSuperadmin(me.role))
      return c.json({ message: "Only a superadmin can modify admin-level accounts" }, 403);
    const updates: Record<string, any> = {};
    // simple text fields
    for (const k of [
      "name",
      "email",
      "phone",
      "altPhone",
      "company",
      "address",
      "city",
      "region",
      "postalCode",
      "country",
      "notes",
    ]) {
      if (b[k] !== undefined) updates[k] = b[k];
    }
    // JSON array fields (multiple addresses / contacts)
    if (b.addresses !== undefined)
      updates.addresses = JSON.stringify(Array.isArray(b.addresses) ? b.addresses : []);
    if (b.contacts !== undefined)
      updates.contacts = JSON.stringify(Array.isArray(b.contacts) ? b.contacts : []);
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
  .post("/users/:id/reset-password", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const me = c.get("user") as SessionUser;
    const { password } = (await c.req.json()) as { password?: string };
    if (!password || password.length < 8)
      return c.json({ message: "Password must be at least 8 characters" }, 400);
    const [target] = await db.select().from(schema.user).where(eq(schema.user.id, id));
    if (!target || target.companyId !== tenantId(c)) return c.json({ message: "Not found" }, 404);
    if (isAdminRole(target.role) && !isSuperadmin(me.role))
      return c.json({ message: "Only a superadmin can reset admin-level passwords" }, 403);
    const ctx = await auth.$context;
    const hash = await ctx.password.hash(password);
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
  .post("/me/change-password", requireAdmin, async (c) => {
    const me = c.get("user") as SessionUser;
    const { currentPassword, newPassword } = (await c.req.json()) as {
      currentPassword?: string;
      newPassword?: string;
    };
    if (!newPassword || newPassword.length < 8)
      return c.json({ message: "New password must be at least 8 characters" }, 400);
    const ctx = await auth.$context;
    const [cred] = await db
      .select()
      .from(schema.account)
      .where(eq(schema.account.userId, me.id));
    if (!cred?.password) return c.json({ message: "No password set on this account" }, 400);
    const valid = await ctx.password.verify({
      password: currentPassword ?? "",
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
    if (!target || target.companyId !== tenantId(c)) return c.json({ message: "Not found" }, 404);
    // Deleting an admin-tier account requires superadmin.
    if (isAdminRole(target.role) && !isSuperadmin(me.role))
      return c.json({ message: "Only a superadmin can delete admin-level accounts" }, 403);
    // clean up rider profile if any
    await tx(c).delete(schema.riders, eq(schema.riders.userId, id));
    await db.delete(schema.user).where(eq(schema.user.id, id));
    return c.json({ ok: true }, 200);
  });
