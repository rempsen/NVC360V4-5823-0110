import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq, and, gte, lte } from "drizzle-orm";
import { requireAuth, requireAdmin, tx } from "../middleware/auth";
import { audit } from "../lib/audit";
import { Err } from "../lib/errors";
import { jsonBody, isoDate, percent } from "../lib/validate";
import { z } from "zod";
import type { AppEnv } from "../env";

const PayoutGenerate = z.object({
  periodStart: isoDate("Period start"),
  periodEnd: isoDate("Period end"),
  feePct: percent("Platform fee").default(20),
});

type SessionUser = { id: string; name?: string };

export const payoutsRoutes = new Hono<AppEnv>()
  .get("/", requireAuth, async (c) => {
    const t = tx(c);
    const rows = await t.select(schema.payouts);
    rows.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    const enriched = await Promise.all(rows.map(async (p) => {
      const r = await t.selectOne(schema.riders, eq(schema.riders.id, p.riderId));
      let name = "";
      if (r) {
        const [u] = await db.select().from(schema.user).where(eq(schema.user.id, r.userId));
        name = u?.name ?? "";
      }
      return { ...p, riderName: name };
    }));
    return c.json({ payouts: enriched }, 200);
  })
  // generate payouts for a period from completed+paid bookings
  .post("/generate", requireAdmin, jsonBody(PayoutGenerate), async (c) => {
    const me = c.get("user") as SessionUser;
    // feePct was unvalidated: a negative percentage makes `fee` negative and
    // `net = gross - fee` larger than gross, i.e. the platform pays the tech
    // MORE than the customer paid. And `new Date(periodStart)` on unchecked
    // input silently produced an Invalid Date that drizzle wrote to the row.
    const { periodStart: start, periodEnd: end, feePct } = c.req.valid("json");
    if (end < start) throw Err.badRequest("Period end must be after period start");
    const t = tx(c);
    const completed = await t.select(
      schema.bookings,
      and(
        eq(schema.bookings.status, "completed"),
        eq(schema.bookings.paymentStatus, "paid"),
        gte(schema.bookings.scheduledAt, start),
        lte(schema.bookings.scheduledAt, end),
      ),
    );
    // group by rider
    const byRider = new Map<string, { count: number; gross: number }>();
    for (const b of completed) {
      if (!b.riderId) continue;
      const agg = byRider.get(b.riderId) || { count: 0, gross: 0 };
      agg.count += 1;
      agg.gross += b.price;
      byRider.set(b.riderId, agg);
    }
    const created = [];
    for (const [riderId, agg] of byRider) {
      const fee = +(agg.gross * (feePct / 100)).toFixed(2);
      const net = +(agg.gross - fee).toFixed(2);
      const [p] = await t.insert(schema.payouts, {
        riderId, periodStart: start, periodEnd: end,
        jobsCount: agg.count, gross: +agg.gross.toFixed(2),
        feePct, fee, net, status: "pending",
      });
      created.push(p);
    }
    await audit({ actorId: me?.id, actorName: me?.name, action: "create", entityType: "payout", summary: `Generated ${created.length} payouts` });
    return c.json({ created: created.length, payouts: created }, 201);
  })
  .post("/:id/pay", requireAdmin, async (c) => {
    const me = c.get("user") as SessionUser;
    const id = c.req.param("id");
    const [p] = await tx(c).update(
      schema.payouts,
      { status: "paid", paidAt: new Date() },
      eq(schema.payouts.id, id),
    );
    await audit({ actorId: me?.id, actorName: me?.name, action: "payout", entityType: "payout", entityId: id, summary: `Marked payout paid ($${p?.net})` });
    return c.json({ payout: p }, 200);
  })
  .delete("/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    await tx(c).delete(schema.payouts, eq(schema.payouts.id, id));
    return c.json({ ok: true }, 200);
  });
