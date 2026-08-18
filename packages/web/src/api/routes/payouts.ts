import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq, and, gte, lte, isNull } from "drizzle-orm";
import { requireAdmin, tx } from "../middleware/auth";
import { audit } from "../lib/audit";
import { Err } from "../lib/errors";
import { jsonBody, isoDate } from "../lib/validate";
import { z } from "zod";
import type { AppEnv } from "../env";
import { computeTechPay } from "../../shared/tech-pay";
import { parseLineItems, round2 } from "../../shared/catalog";

const PayoutGenerate = z.object({
  periodStart: isoDate("Period start"),
  periodEnd: isoDate("Period end"),
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
      let jobs: unknown[] = [];
      try { const a = JSON.parse(p.breakdown || "[]"); if (Array.isArray(a)) jobs = a; } catch { /* legacy row */ }
      return { ...p, riderName: name, jobs };
    }));
    return c.json({ payouts: enriched }, 200);
  })
  /**
   * Generate payouts for a period from the REAL pay each job earned:
   * on-site hours x the tech's hourly rate + per-unit line pay. This is the same
   * `computeTechPay` the driver app and the job screen use, so the payout total
   * always reconciles with what the tech was shown.
   *
   * It used to be a flat percentage of the customer's invoice, which had nothing
   * to do with the hours the tech actually worked — a 20-minute warranty call on
   * a $4,000 invoice paid $3,200, and an all-day job on a cheap job paid almost
   * nothing. There is no platform fee any more: gross == net == real pay.
   */
  .post("/generate", requireAdmin, jsonBody(PayoutGenerate), async (c) => {
    const me = c.get("user") as SessionUser;
    // `new Date(periodStart)` on unchecked input silently produced an Invalid
    // Date that drizzle wrote to the row, so periods validate here.
    const { periodStart: start, periodEnd: end } = c.req.valid("json");
    if (end < start) throw Err.badRequest("Period end must be after period start");
    const t = tx(c);
    // Pay is earned when the work is DONE, not when the customer settles their
    // invoice — a tech should not wait on a slow-paying client to get paid.
    const completed = await t.select(
      schema.bookings,
      and(
        eq(schema.bookings.status, "completed"),
        isNull(schema.bookings.deletedAt),
        gte(schema.bookings.scheduledAt, start),
        lte(schema.bookings.scheduledAt, end),
      ),
    );

    type JobPay = {
      bookingId: string;
      title: string;
      onSiteMinutes: number;
      hours: number;
      payRatePerHour: number;
      hourlyPay: number;
      unitPay: number;
      techPay: number;
      unrated: boolean;
    };
    type Agg = {
      count: number;
      hourlyPay: number;
      unitPay: number;
      onSiteMinutes: number;
      total: number;
      unratedJobs: number;
      bookingIds: string[];
      jobs: JobPay[];
    };
    const byRider = new Map<string, Agg>();
    // One rate lookup per tech per run, not per job.
    const rateCache = new Map<string, number>();

    for (const b of completed) {
      if (!b.riderId) continue;
      // Already paid out (this period was generated before, or an overlapping
      // period covered it). Skipping here — rather than trusting the period
      // window — is what makes a second run a no-op instead of double pay.
      if (b.payoutId) continue;

      let rate = rateCache.get(b.riderId);
      if (rate === undefined) {
        const r = await t.selectOne(schema.riders, eq(schema.riders.id, b.riderId));
        // No rider row in this tenant = the job is not ours to pay.
        if (!r) { rateCache.set(b.riderId, -1); continue; }
        rate = r.payRatePerHour || 0;
        rateCache.set(b.riderId, rate);
      }
      if (rate < 0) continue;

      const pay = computeTechPay({
        onSiteMinutes: b.onSiteMinutes || 0,
        payRatePerHour: rate,
        lineItems: parseLineItems(b.lineItems),
      });

      const agg = byRider.get(b.riderId) || {
        count: 0, hourlyPay: 0, unitPay: 0, onSiteMinutes: 0,
        total: 0, unratedJobs: 0, bookingIds: [], jobs: [],
      };
      agg.count += 1;
      agg.hourlyPay += pay.hourlyPay;
      agg.unitPay += pay.unitPay;
      agg.onSiteMinutes += b.onSiteMinutes || 0;
      agg.total += pay.techPay;
      if (pay.unrated) agg.unratedJobs += 1;
      agg.bookingIds.push(b.id);
      agg.jobs.push({
        bookingId: b.id,
        title: b.title ?? "",
        onSiteMinutes: b.onSiteMinutes || 0,
        hours: pay.hours,
        payRatePerHour: pay.payRatePerHour,
        hourlyPay: pay.hourlyPay,
        unitPay: pay.unitPay,
        techPay: pay.techPay,
        unrated: pay.unrated,
      });
      byRider.set(b.riderId, agg);
    }

    const created = [];
    for (const [riderId, agg] of byRider) {
      const total = round2(agg.total);
      const [p] = await t.insert(schema.payouts, {
        riderId, periodStart: start, periodEnd: end,
        jobsCount: agg.count,
        gross: total,
        // No platform fee in the real-pay model; kept at 0 for legacy columns.
        feePct: 0, fee: 0,
        net: total,
        hourlyPay: round2(agg.hourlyPay),
        unitPay: round2(agg.unitPay),
        onSiteMinutes: Math.round(agg.onSiteMinutes * 10) / 10,
        unratedJobs: agg.unratedJobs,
        breakdown: JSON.stringify(agg.jobs),
        status: "pending",
      });
      // Stamp the jobs this payout covers so they are never paid again, and
      // write the per-job pay back onto the booking so the job screen, the
      // Earnings screen and this payout all show the same number.
      for (const j of agg.jobs) {
        await t.update(
          schema.bookings,
          { payoutId: p.id, techPay: j.techPay, techPayBreakdown: JSON.stringify(j) },
          eq(schema.bookings.id, j.bookingId),
        );
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
