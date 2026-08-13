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
import { tdb } from "../database/tenant";
import * as schema from "../database/schema";
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { requireAuth, loadMemberships } from "../middleware/auth";
import { isSuperadmin } from "../lib/permissions";
import { detachMembership } from "../lib/memberships";

type SessionUser = { id: string; role?: string; companyId?: string };

/**
 * Per-company unread/pending counts for ONE company, for one rider identity.
 *
 * Split out of the route so the shape is testable and so the two counts can
 * never drift apart between the badge and the picker — both read this.
 *
 * "Needs my attention" for a technician is exactly two things:
 *   1. Dispatch said something I haven't read (direct thread, and any thread on
 *      a job that is still mine — a message on a finished job is history, not a
 *      task).
 *   2. A work order is sitting on `offered`, waiting for accept/decline.
 *
 * Messages the tech sent themselves are never counted (senderRole filter), and
 * a job the office already pulled back or completed is never counted, otherwise
 * the badge would show a number the tech cannot clear by doing anything.
 */
async function countsForCompany(
  companyId: string,
  userId: string,
): Promise<{ unreadMessages: number; pendingOffers: number }> {
  const t = tdb(companyId);

  // The rider row is per (user, company) — a tech on two rosters has two. No
  // rider row means they hold a non-field role here (e.g. office staff at one
  // company, tech at another), so there is nothing for the driver app to badge.
  const rider = await t.selectOne(schema.riders, eq(schema.riders.userId, userId));
  if (!rider) return { unreadMessages: 0, pendingOffers: 0 };

  const offered = await t.select(
    schema.bookings,
    and(
      eq(schema.bookings.riderId, rider.id),
      eq(schema.bookings.assignStatus, "offered"),
      notInArray(schema.bookings.status, ["completed", "cancelled"]),
      isNull(schema.bookings.deletedAt),
    ),
  );

  // Direct dispatcher thread — the one the Messages tab opens on.
  const direct = await t.select(
    schema.messages,
    and(
      eq(schema.messages.riderId, rider.id),
      isNull(schema.messages.bookingId),
      eq(schema.messages.read, false),
    ),
  );

  // NOTE — job-thread messages are deliberately NOT counted here.
  //
  // `messages.read` is a single shared flag, and the only thing that clears it
  // on a job thread is POST /:bookingId/mark-read, which marks CLIENT messages
  // read on behalf of the OFFICE (it feeds the dispatcher inbox count). The
  // driver app has no ack of its own for a job thread, so counting those
  // messages here would put a red number on the app that the technician has no
  // way to clear by doing anything — and letting the tech clear it would
  // silently blank the dispatcher's inbox instead.
  //
  // Doing this properly needs a per-audience read flag (`read_by_tech`) so the
  // office and the field can ack independently. Until then the badge counts
  // only what the tech can actually action: the dispatcher's direct thread and
  // work orders awaiting accept/decline.
  return {
    unreadMessages: direct.filter((m) => m.senderRole === "dispatch").length,
    pendingOffers: offered.length,
  };
}

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
   * "What needs my attention, at every company I work for?"
   *
   * Deliberately COMPANY-AGNOSTIC: it ignores X-Company-Id and reports every
   * roster the caller is on. That is the whole point — a tech working Acme's
   * shift has no way to discover that Bolt just sent them a work order, because
   * every other endpoint in the app is tenant-scoped to the company they picked.
   * This is the one endpoint allowed to look across them, and it does so only
   * for the caller's OWN memberships (never a userId parameter), so it cannot be
   * used to read across tenants.
   *
   * Backs three things in the driver app:
   *   - the red count on the app icon / tab bar (`total`)
   *   - the per-tab counts for the company currently being worked (`active`)
   *   - the red dot on each company in the picker/switcher (`companies[]`)
   */
  .get("/notifications", requireAuth, async (c) => {
    const me = c.get("user") as unknown as SessionUser;
    const active = (c.get("companyId") as string) ?? "";

    const memberships = await loadMemberships(me.id);
    // Superadmins are platform operators, not field techs — they have no rider
    // identity to badge, and fanning out across every tenant on the platform
    // would be an expensive query for a screen they never see.
    if (memberships.length === 0 || isSuperadmin(me.role)) {
      return c.json({
        total: 0,
        unreadMessages: 0,
        pendingOffers: 0,
        active: { companyId: active, unreadMessages: 0, pendingOffers: 0, total: 0 },
        companies: [],
      });
    }

    const rows = await db
      .select()
      .from(schema.companies)
      .where(
        inArray(
          schema.companies.id,
          memberships.map((m) => m.companyId),
        ),
      );
    const byId = new Map(rows.map((r) => [r.id, r]));

    // A suspended company must not raise a badge — the tech cannot act on it.
    const usable = memberships.filter((m) => byId.get(m.companyId)?.status !== "suspended");

    const companies = await Promise.all(
      usable.map(async (m) => {
        // One company's failure (a half-migrated tenant, a bad row) must not
        // blank out the whole badge — report zero for that company and keep the
        // others accurate.
        const counts = await countsForCompany(m.companyId, me.id).catch(() => ({
          unreadMessages: 0,
          pendingOffers: 0,
        }));
        return {
          companyId: m.companyId,
          company: byId.get(m.companyId)?.name ?? m.companyId,
          staffType: m.staffType,
          unreadMessages: counts.unreadMessages,
          pendingOffers: counts.pendingOffers,
          total: counts.unreadMessages + counts.pendingOffers,
        };
      }),
    );

    const activeEntry = companies.find((x) => x.companyId === active);
    return c.json({
      total: companies.reduce((s, x) => s + x.total, 0),
      unreadMessages: companies.reduce((s, x) => s + x.unreadMessages, 0),
      pendingOffers: companies.reduce((s, x) => s + x.pendingOffers, 0),
      active: {
        companyId: active,
        unreadMessages: activeEntry?.unreadMessages ?? 0,
        pendingOffers: activeEntry?.pendingOffers ?? 0,
        total: activeEntry?.total ?? 0,
      },
      companies: companies.sort((a, b) => a.company.localeCompare(b.company)),
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
