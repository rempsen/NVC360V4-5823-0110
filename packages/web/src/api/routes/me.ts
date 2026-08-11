/**
 * "Who am I and which companies can I act as?"
 *
 * A person can work for several companies (a contract technician on both Acme's
 * and Bolt's roster). These routes back the company switcher in the admin shell
 * and the company picker in the driver app.
 *
 * Switching is deliberately NOT stored server-side as mutable session state —
 * the client sends `X-Company-Id` on every request and the auth middleware
 * validates membership on every request. That means a revoked membership takes
 * effect immediately, instead of a stale session continuing to work.
 */
import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { and, eq, inArray } from "drizzle-orm";
import { requireAuth, loadMemberships } from "../middleware/auth";
import { isSuperadmin } from "../lib/permissions";
import { detachMembership } from "../lib/memberships";

type SessionUser = { id: string; role?: string; companyId?: string };

export const meRoutes = new Hono()
  /**
   * Every company this person can act as, with the role they hold at each and
   * a display name for the picker.
   */
  .get("/companies", requireAuth, async (c) => {
    const me = c.get("user") as unknown as SessionUser;
    const active = (c.get("companyId") as string) ?? "default";

    // A superadmin is a platform-level operator: they can act as ANY tenant,
    // not just the ones they're a member of.
    if (isSuperadmin(me.role)) {
      const all = await db.select().from(schema.companies);
      return c.json({
        activeCompanyId: active,
        superadmin: true,
        companies: all
          .map((co) => ({
            id: co.id,
            name: co.name,
            role: "superadmin",
            status: co.status,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
    }

    const memberships = await loadMemberships(me.id);
    if (memberships.length === 0) {
      return c.json({ activeCompanyId: active, superadmin: false, companies: [] });
    }

    const ids = memberships.map((m) => m.companyId);
    const rows = await db
      .select()
      .from(schema.companies)
      .where(inArray(schema.companies.id, ids));
    const nameById = new Map(rows.map((r) => [r.id, r.name]));

    return c.json({
      activeCompanyId: active,
      superadmin: false,
      companies: memberships
        // A suspended company shouldn't appear as somewhere you can work.
        .filter((m) => {
          const co = rows.find((r) => r.id === m.companyId);
          return !co || co.status !== "suspended";
        })
        .map((m) => ({
          id: m.companyId,
          name: nameById.get(m.companyId) ?? m.companyId,
          role: m.role,
          staffType: m.staffType,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  })

  /**
   * Set the person's DEFAULT company — the one they land on next time they sign
   * in. Per-request switching happens via the X-Company-Id header; this just
   * makes the choice sticky.
   */
  .post("/company", requireAuth, async (c) => {
    const me = c.get("user") as unknown as SessionUser;
    const body = (await c.req.json().catch(() => ({}))) as { companyId?: unknown };
    const companyId = typeof body.companyId === "string" ? body.companyId.trim() : "";
    if (!companyId) return c.json({ message: "companyId is required" }, 400);

    // Fail closed: you may only default to a company you actually belong to.
    // Without this check any signed-in user could park themselves in another
    // tenant. Superadmins may default to any real company.
    if (isSuperadmin(me.role)) {
      const [co] = await db
        .select()
        .from(schema.companies)
        .where(eq(schema.companies.id, companyId));
      if (!co) return c.json({ message: "Company not found" }, 404);
    } else {
      const [m] = await db
        .select()
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.userId, me.id),
            eq(schema.memberships.companyId, companyId),
            eq(schema.memberships.status, "active"),
          ),
        );
      if (!m) return c.json({ message: "You are not a member of that company" }, 403);
    }

    await db
      .update(schema.user)
      .set({ companyId })
      .where(eq(schema.user.id, me.id));

    return c.json({ ok: true, activeCompanyId: companyId });
  })

  /**
   * Look up a pending "join this company" invite. Public-ish: it only reveals
   * the company name and the invited email, and only for a genuinely pending
   * membership.
   */
  .get("/join-company/:membershipId", async (c) => {
    const [m] = await db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.id, c.req.param("membershipId")));
    if (!m || m.status !== "invited")
      return c.json({ message: "This invite is no longer valid" }, 404);
    const [u] = await db.select().from(schema.user).where(eq(schema.user.id, m.userId));
    const [co] = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, m.companyId));
    return c.json({
      invite: {
        email: u?.email ?? "",
        company: co?.name ?? m.companyId,
        companyId: m.companyId,
        role: m.role,
      },
    });
  })

  /**
   * Accept it. Must be signed in AS the invited person — that is the whole
   * security model here: no password is ever set by the inviting company, the
   * person proves who they are with the login they already had.
   */
  .post("/join-company/:membershipId", requireAuth, async (c) => {
    const me = c.get("user") as unknown as SessionUser;
    const [m] = await db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.id, c.req.param("membershipId")));
    if (!m || m.status !== "invited")
      return c.json({ message: "This invite is no longer valid" }, 404);
    if (m.userId !== me.id)
      return c.json({ message: "This invite belongs to a different account" }, 403);

    await db
      .update(schema.memberships)
      .set({ status: "active", acceptedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.memberships.id, m.id));

    return c.json({ ok: true, companyId: m.companyId });
  })

  /**
   * Decline a pending invite.
   *
   * Separate from `/leave-company` on purpose: that route refuses when it would
   * leave you with no company ("You can't leave your only company"), which is
   * right for an ACTIVE membership but wrong for an invite — a brand new tech
   * whose only membership is the pending invite must still be able to say no.
   * Declining never touches an active membership, so it can't strand anyone.
   */
  .post("/join-company/:membershipId/decline", requireAuth, async (c) => {
    const me = c.get("user") as unknown as SessionUser;
    const [m] = await db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.id, c.req.param("membershipId")));
    // 404 (not 403) for someone else's invite: never confirm to one person that
    // an invite exists for another account.
    if (!m || m.status !== "invited" || m.userId !== me.id)
      return c.json({ message: "This invite is no longer valid" }, 404);

    await detachMembership(me.id, m.companyId);
    return c.json({ ok: true });
  })

  /**
   * Pending invites for the signed-in person — "someone has added you to their
   * roster, do you accept?".
   *
   * Why this exists: `/companies` deliberately returns only ACTIVE memberships
   * (it feeds the company switcher, and you must not be able to act as a
   * company you haven't accepted). That left an invited tech with no way to
   * discover the invite anywhere except the email, so the driver app couldn't
   * show it at all. This is the read side of accepting in-app.
   *
   * Scoped to the caller's own userId — never accepts a userId parameter, so
   * one person can't enumerate another's invites.
   */
  .get("/invites", requireAuth, async (c) => {
    const me = c.get("user") as unknown as SessionUser;
    const pending = await db
      .select()
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.userId, me.id),
          eq(schema.memberships.status, "invited"),
        ),
      );
    if (pending.length === 0) return c.json({ invites: [] });

    const rows = await db
      .select()
      .from(schema.companies)
      .where(inArray(schema.companies.id, pending.map((m) => m.companyId)));
    const byId = new Map(rows.map((r) => [r.id, r]));

    return c.json({
      invites: pending
        // A suspended company must not be offered as somewhere to go to work.
        .filter((m) => byId.get(m.companyId)?.status !== "suspended")
        .map((m) => ({
          membershipId: m.id,
          companyId: m.companyId,
          company: byId.get(m.companyId)?.name ?? m.companyId,
          role: m.role,
          staffType: m.staffType,
          invitedAt: m.createdAt,
        })),
    });
  })

  /** Decline / leave a company you were invited to. */
  .post("/leave-company", requireAuth, async (c) => {
    const me = c.get("user") as unknown as SessionUser;
    const body = (await c.req.json().catch(() => ({}))) as { companyId?: unknown };
    const companyId = typeof body.companyId === "string" ? body.companyId.trim() : "";
    if (!companyId) return c.json({ message: "companyId is required" }, 400);

    const mine = await db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, me.id));
    if (mine.length <= 1)
      return c.json({ message: "You can't leave your only company" }, 400);

    await detachMembership(me.id, companyId);
    return c.json({ ok: true });
  });
