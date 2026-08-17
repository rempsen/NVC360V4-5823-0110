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
import type { AppEnv } from "../env";

type SessionUser = { id: string; role?: string; companyId?: string };

/**
 * Per-company unread/pending counts for ONE company, for one rider identity.
 *
 * Split out of the route so the shape is testable and so the two counts can
 * never drift apart between the badge and the picker — both read this.
 *
 * "Needs my attention" for a technician is exactly two things:
 *   1. Someone said something I haven't read — the dispatcher's direct thread,
 *      plus any thread on a job that is still mine and still live (a message on
 *      a finished job is history, not a task). Job threads are counted with
 *      `readByTech`, the field's own read flag, so this can never fight with
 *      the dispatcher inbox's `read`.
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

  // ── Job-thread messages, counted via the FIELD's own read flag ────────────
  //
  // `messages.read` means "the OFFICE has read this" and drives the dispatcher
  // inbox, so it cannot answer "has the tech seen this". `readByTech` is the
  // field side's independent ack, cleared by POST /:bookingId/mark-read-tech
  // when the tech opens the job. That is what makes this count safe to show:
  // the tech can clear it, and clearing it does not touch the office's inbox.
  //
  // Scoped to jobs that are still the tech's OWN and still live. A message on a
  // completed, cancelled or reassigned job is history, not a task — counting it
  // would leave a number the tech can no longer reach a screen to clear.
  const myLiveJobs = await t.select(
    schema.bookings,
    and(
      eq(schema.bookings.riderId, rider.id),
      notInArray(schema.bookings.status, ["completed", "cancelled"]),
      isNull(schema.bookings.deletedAt),
    ),
  );

  let jobUnread = 0;
  if (myLiveJobs.length > 0) {
    const jobMsgs = await t.select(
      schema.messages,
      and(
        inArray(
          schema.messages.bookingId,
          myLiveJobs.map((b) => b.id),
        ),
        eq(schema.messages.readByTech, false),
      ),
    );
    // Inbound only — the tech's own sends are theirs. Both dispatch AND client
    // messages count: on a job thread the customer is talking to the tech.
    jobUnread = jobMsgs.filter((m) => m.senderRole !== "tech").length;
  }

  return {
    unreadMessages: direct.filter((m) => m.senderRole === "dispatch").length + jobUnread,
    pendingOffers: offered.length,
  };
}

export const meRoutes = new Hono<AppEnv>()
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
   * "What have I earned, everywhere I work?"
   *
   * Company-agnostic on purpose, like `/me/notifications`. Every OTHER endpoint
   * in the app is tenant-scoped to the company in `X-Company-Id`, which meant a
   * contract tech on two rosters saw only the current shift's completed jobs on
   * the Earnings screen — and with no company shown anywhere on the screen, the
   * jobs that WERE listed looked like they belonged to whichever company the
   * Profile screen happened to be showing. A driver's own work history is theirs
   * regardless of who dispatched it, so this returns all of it, with each job,
   * payout and rating attributed to the company it came from.
   *
   * Safety: exactly the same shape of guarantee as `/me/notifications` — it
   * fans out over the CALLER'S OWN memberships only, never takes a userId or a
   * company from the request, and ignores `X-Company-Id` entirely. So it cannot
   * be used to read across tenants; it can only read the caller's own rows in
   * the tenants they already belong to. Rider rows are per (user, company), so
   * each company's bookings are matched to that company's OWN rider id.
   *
   * Ratings and payouts are set/issued by each employer separately, so there is
   * no meaningful blended number: both are returned per company and the app
   * shows them that way.
   */
  .get("/earnings", requireAuth, async (c) => {
    const me = c.get("user") as unknown as SessionUser;

    /** Ceiling on the returned history. A long-tenured tech across several
     *  rosters could otherwise pull thousands of rows onto a phone. Newest
     *  first, so the cap trims the oldest history, and `truncated` lets the
     *  client say so rather than silently under-reporting. */
    const MAX_JOBS = 500;

    const memberships = await loadMemberships(me.id);
    // Superadmins are platform operators with no rider identity to pay.
    if (memberships.length === 0 || isSuperadmin(me.role)) {
      return c.json({
        companies: [],
        jobs: [],
        payouts: [],
        totals: { gross: 0, weekGross: 0, weekJobs: 0, jobsCount: 0, paidNet: 0 },
        truncated: false,
      });
    }

    const coRows = await db
      .select()
      .from(schema.companies)
      .where(
        inArray(
          schema.companies.id,
          memberships.map((m) => m.companyId),
        ),
      );
    const byId = new Map(coRows.map((r) => [r.id, r]));
    // A suspended tenant's history is not something the tech can act on, and
    // its rows may be mid-teardown — same exclusion as the badge endpoint.
    const usable = memberships.filter((m) => byId.get(m.companyId)?.status !== "suspended");

    type JobRow = {
      id: string;
      companyId: string;
      company: string;
      title: string;
      service: string;
      customerName: string;
      scheduledAt: number | null;
      finishedAt: number | null;
      price: number;
    };
    type PayoutRow = {
      id: string;
      companyId: string;
      company: string;
      periodStart: number | null;
      periodEnd: number | null;
      jobsCount: number;
      gross: number;
      net: number;
      status: string;
    };

    const perCompany = await Promise.all(
      usable.map(async (m) => {
        const companyName = byId.get(m.companyId)?.name ?? m.companyId;
        const empty = {
          companyId: m.companyId,
          company: companyName,
          rating: null as number | null,
          jobsCount: 0,
          gross: 0,
          jobs: [] as JobRow[],
          payouts: [] as PayoutRow[],
        };
        try {
          const t = tdb(m.companyId);
          // Per (user, company) rider row. No rider row = they hold a
          // non-field role here (office staff at one company, tech at
          // another), so there is nothing to pay them for.
          const rider = await t.selectOne(schema.riders, eq(schema.riders.userId, me.id));
          if (!rider) return empty;

          const completed = await t.select(
            schema.bookings,
            and(
              eq(schema.bookings.riderId, rider.id),
              eq(schema.bookings.status, "completed"),
              isNull(schema.bookings.deletedAt),
            ),
          );
          const svcIds = [...new Set(completed.map((b) => b.serviceId).filter((v): v is string => !!v))];
          const svcMap = new Map<string, string>();
          if (svcIds.length) {
            const svcs = await t
              .select(schema.services, inArray(schema.services.id, svcIds))
              .catch(() => []);
            svcs.forEach((s) => svcMap.set(s.id, s.name));
          }
          // `bookings` has no customer name column — it lives on the GLOBAL
          // `user` table. One batched query by explicit id list (same pattern
          // as bookings.ts enrichMany), never a per-row lookup.
          const custIds = [...new Set(completed.map((b) => b.customerId).filter((v): v is string => !!v))];
          const custMap = new Map<string, string>();
          if (custIds.length) {
            const us = await db
              .select()
              .from(schema.user)
              .where(inArray(schema.user.id, custIds))
              .catch(() => []);
            us.forEach((u) => custMap.set(u.id, u.name ?? ""));
          }

          const jobs: JobRow[] = completed.map((b) => ({
            id: b.id,
            companyId: m.companyId,
            company: companyName,
            title: b.title ?? "",
            service: (b.serviceId ? svcMap.get(b.serviceId) : "") ?? "",
            customerName: (b.customerId ? custMap.get(b.customerId) : "") ?? "",
            scheduledAt: b.scheduledAt ? Number(b.scheduledAt) : null,
            finishedAt: b.finishedAt ? Number(b.finishedAt) : null,
            price: Number(b.price ?? 0),
          }));

          const payoutRows = await t
            .select(schema.payouts, eq(schema.payouts.riderId, rider.id))
            .catch(() => []);
          const payouts: PayoutRow[] = payoutRows.map((p) => ({
            id: p.id,
            companyId: m.companyId,
            company: companyName,
            periodStart: p.periodStart ? Number(p.periodStart) : null,
            periodEnd: p.periodEnd ? Number(p.periodEnd) : null,
            jobsCount: Number(p.jobsCount ?? 0),
            gross: Number(p.gross ?? 0),
            net: Number(p.net ?? 0),
            status: p.status,
          }));

          return {
            companyId: m.companyId,
            company: companyName,
            // Each employer rates independently — never blend these.
            rating: rider.rating == null ? null : Number(rider.rating),
            jobsCount: jobs.length,
            gross: jobs.reduce((s, j) => s + j.price, 0),
            jobs,
            payouts,
          };
        } catch (err) {
          // One broken tenant must not blank out the whole screen — report it
          // as empty and keep the other companies accurate.
          console.error(`[me/earnings] company ${m.companyId} failed`, err);
          return empty;
        }
      }),
    );

    const allJobs = perCompany.flatMap((x) => x.jobs);
    allJobs.sort(
      (a, b) => (b.finishedAt ?? b.scheduledAt ?? 0) - (a.finishedAt ?? a.scheduledAt ?? 0),
    );
    const truncated = allJobs.length > MAX_JOBS;
    const jobs = truncated ? allJobs.slice(0, MAX_JOBS) : allJobs;

    const allPayouts = perCompany.flatMap((x) => x.payouts);
    allPayouts.sort((a, b) => (b.periodEnd ?? 0) - (a.periodEnd ?? 0));

    // Totals are computed over the FULL history, not the capped page, so the
    // headline numbers stay correct even when the list is trimmed.
    const weekAgo = Date.now() - 7 * 86_400_000;
    const inWeek = allJobs.filter((j) => (j.finishedAt ?? j.scheduledAt ?? 0) >= weekAgo);

    return c.json({
      companies: perCompany
        .map(({ companyId, company, rating, jobsCount, gross }) => ({
          companyId,
          company,
          rating,
          jobsCount,
          gross: +gross.toFixed(2),
        }))
        .sort((a, b) => a.company.localeCompare(b.company)),
      jobs,
      payouts: allPayouts,
      totals: {
        gross: +allJobs.reduce((s, j) => s + j.price, 0).toFixed(2),
        weekGross: +inWeek.reduce((s, j) => s + j.price, 0).toFixed(2),
        weekJobs: inWeek.length,
        jobsCount: allJobs.length,
        paidNet: +allPayouts
          .filter((p) => p.status === "paid")
          .reduce((s, p) => s + p.net, 0)
          .toFixed(2),
      },
      truncated,
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
