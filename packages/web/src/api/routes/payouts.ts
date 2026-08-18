import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq, and, gte, lte } from "drizzle-orm";
import { requireAdmin, tx } from "../middleware/auth";
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
  // Office-only: this list is every technician's pay. It was `requireAuth`, so
  // any signed-in tech could read what all of their coworkers earn.
  .get("/", requireAdmin, async (c) => {
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
    const byRider = new Map<string, { count: number; gross: number; bookingIds: string[] }>();
    for (const b of completed) {
      if (!b.riderId) continue;
      // Already paid out (this period was generated before, or an overlapping
      // period covered it). Skipping here — rather than trusting the period
      // window — is what makes a second run a no-op instead of double pay.
      if (b.payoutId) continue;
      const agg = byRider.get(b.riderId) || { count: 0, gross: 0, bookingIds: [] };
      agg.count += 1;
      // Pay on the PRE-TAX value of the work. `price`/`total` includes the GST/HST
      // the company collected for the government; paying a percentage of that
      // shipped 13% of every Ontario invoice out of the door as extra tech pay.
      // Older rows written before tax columns existed fall back to price.
      agg.gross += b.subtotal || Math.max(0, b.price - (b.taxAmount || 0));
      agg.bookingIds.push(b.id);
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
      // Stamp the jobs this payout covers so they are never paid again.
      for (const bid of agg.bookingIds) {
        await t.update(schema.bookings, { payoutId: p.id }, eq(schema.bookings.id, bid));
      }
      created.push(p);
    }
    await audit({ actorId: me?.id, actorName: me?.name, action: "create", entityType: "payout", summary: `Generated ${created.length} payouts` });
    return c.json({ created: created.length, payouts: created }, 201);
  })
  .post("/:id/pay", requireAdmin, async (c) => {
    const me = c.get("user") as SessionUser;
    const id = c.req.param("id");
    const t = tx(c);
    const existing = await t.selectOne(schema.payouts, eq(schema.payouts.id, id));
    // Without this a stale id wrote an audit line reading "Marked payout paid
    // ($undefined)" and still answered 200, so the office believed a tech had
    // been paid.
    if (!existing) return c.json({ message: "Payout not found" }, 404);
    // Compare-and-set on `pending`: a double-click (or two people in the payouts
    // screen at once) re-stamped paidAt and wrote a second "paid" audit entry on
    // a payout that had already gone out.
    const [p] = await t.update(
      schema.payouts,
      { status: "paid", paidAt: new Date() },
      and(eq(schema.payouts.id, id), eq(schema.payouts.status, "pending")),
    );
    if (!p) throw Err.conflict("This payout has already been paid.");
    await audit({ actorId: me?.id, actorName: me?.name, action: "payout", entityType: "payout", entityId: id, summary: `Marked payout paid (${p.net})` });
    return c.json({ payout: p }, 200);
  })
  .delete("/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const t = tx(c);
    const existing = await t.selectOne(schema.payouts, eq(schema.payouts.id, id));
    if (!existing) return c.json({ message: "Payout not found" }, 404);
    // A paid payout is a payment record. Deleting it destroys the only trace that
    // the tech was paid — and would hand the same jobs to the next payout run.
    if (existing.status === "paid")
      throw Err.conflict("This payout has already been paid and can't be deleted.");
    // Release the jobs it covered so the next run picks them up again.
    await t.update(schema.bookings, { payoutId: "" }, eq(schema.bookings.payoutId, id));
    await t.delete(schema.payouts, eq(schema.payouts.id, id));
    return c.json({ ok: true }, 200);
  });
