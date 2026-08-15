/**
 * Dispatcher's running-late board.
 *
 * Detection is automatic (services/delay-watch.ts sweeps every minute). These
 * routes exist because a human usually knows something the data doesn't — "he's
 * two minutes out", "I already phoned her" — so a flagged job can be sent early,
 * or muted, before the automatic notice goes out on its own.
 */
import { Hono } from "hono";
import { requireAdmin, tenantId } from "../middleware/auth";
import { parseBody } from "../lib/validate";
import { audit } from "../lib/audit";
import { z } from "zod";
import { db } from "../database";
import * as schema from "../database/schema";
import { and, eq } from "drizzle-orm";
import {
  listDelays,
  pendingDelayCount,
  sendDelayNotice,
  muteDelay,
  delayPolicyFor,
  decideFor,
} from "../../services/delay-watch";

type SessionUser = { id: string; name?: string };

const MuteBody = z.object({ muted: z.boolean().default(true) });

export const delaysRoutes = new Hono()
  .get("/", requireAdmin, async (c) => {
    const co = tenantId(c);
    const [delays, pendingCount, policy] = await Promise.all([
      listDelays(co),
      pendingDelayCount(co),
      delayPolicyFor(co),
    ]);
    return c.json({ delays, pendingCount, policy }, 200);
  })
  .get("/count", requireAdmin, async (c) => {
    return c.json({ pendingCount: await pendingDelayCount(tenantId(c)) }, 200);
  })
  .post("/:bookingId/notify", requireAdmin, async (c) => {
    const co = tenantId(c);
    const u = c.get("user") as SessionUser;
    const bookingId = c.req.param("bookingId");
    const [b] = await db
      .select()
      .from(schema.bookings)
      .where(and(eq(schema.bookings.id, bookingId), eq(schema.bookings.companyId, co)));
    if (!b) return c.json({ message: "Work order not found" }, 404);

    // Re-run the evaluator rather than trusting a number from the browser: a
    // stale tab must not be able to text a customer "we're 40 minutes late"
    // about a job the tech already arrived at.
    const policy = await delayPolicyFor(co);
    const d = decideFor(b, { ...policy, enabled: true });
    if (!d.late)
      return c.json(
        { message: "This job isn't running late any more — nothing was sent." },
        409,
      );

    const r = await sendDelayNotice({
      companyId: co,
      bookingId,
      slipMins: d.slipMins,
      actor: u.id,
    });
    await audit({
      actorId: u.id,
      actorName: u.name,
      companyId: co,
      action: "update",
      entityType: "booking",
      entityId: bookingId,
      summary: `Sent a running-late notice (~${r.notifiedMins} min) for work order ${bookingId.slice(0, 6).toUpperCase()}`,
      meta: { slipMins: r.notifiedMins, reason: d.reason },
    });
    return c.json({ ok: true, notifiedMins: r.notifiedMins }, 200);
  })
  .post("/:bookingId/mute", requireAdmin, async (c) => {
    const co = tenantId(c);
    const u = c.get("user") as SessionUser;
    const bookingId = c.req.param("bookingId");
    const { muted } = await parseBody(c, MuteBody);
    const [b] = await db
      .select()
      .from(schema.bookings)
      .where(and(eq(schema.bookings.id, bookingId), eq(schema.bookings.companyId, co)));
    if (!b) return c.json({ message: "Work order not found" }, 404);

    await muteDelay(co, bookingId, muted);
    await audit({
      actorId: u.id,
      actorName: u.name,
      companyId: co,
      action: "update",
      entityType: "booking",
      entityId: bookingId,
      summary: `${muted ? "Muted" : "Un-muted"} the automatic running-late notice for work order ${bookingId.slice(0, 6).toUpperCase()}`,
      meta: { muted },
    });
    return c.json({ ok: true, muted }, 200);
  });
