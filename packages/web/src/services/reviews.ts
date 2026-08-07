/**
 * Review requests + reputation routing.
 *
 * Two halves:
 *
 * 1. THE ASK — when a job completes we queue a `review_request` task for
 *    N minutes later (per-tenant, default 2h). When it fires we text the
 *    customer their permanent job record link, which is where the star widget
 *    lives. If they already reviewed, or the job was cancelled, we skip.
 *
 * 2. THE ROUTING — the classic reputation gate. 4-5 stars get shown the
 *    company's public Google review link ("would you share that publicly?").
 *    3 stars or below are NOT routed anywhere public; they raise a private
 *    alert to the office so the company can fix it first. Nothing is hidden
 *    from the company — every rating is still stored and visible in admin.
 */
import { db } from "../api/database";
import * as schema from "../api/database/schema";
import { and, eq } from "drizzle-orm";
import { registerTaskHandler, scheduleTask, cancelTasks } from "./scheduler";
import { sendSms, trackingUrl } from "./sms";

const KIND = "review_request";

async function settingsFor(companyId: string) {
  const [cs] = await db
    .select()
    .from(schema.companySettings)
    .where(eq(schema.companySettings.companyId, companyId));
  return cs ?? null;
}

/**
 * Queue the post-completion review ask. Best-effort: never throws, never
 * blocks the completion itself.
 */
export async function scheduleReviewRequest(bookingId: string): Promise<void> {
  try {
    const [b] = await db
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId));
    if (!b) return;

    const cs = await settingsFor(b.companyId);
    if (cs && cs.reviewRequestEnabled === false) return;
    const delay = Math.max(0, Number(cs?.reviewRequestDelayMins ?? 120));

    // one ask per job — clear any older pending one first
    await cancelTasks({ bookingId, kind: KIND });
    await scheduleTask({
      companyId: b.companyId,
      kind: KIND,
      bookingId,
      runAt: Date.now() + delay * 60_000,
    });
  } catch (e) {
    console.error("[reviews] schedule failed", bookingId, e);
  }
}

/**
 * Where a given rating should be sent next.
 * Returns the public review URL only for 4-5 stars AND only if the tenant
 * configured one.
 */
export async function reviewRouting(
  companyId: string,
  rating: number,
): Promise<{ publicUrl: string | null; escalate: boolean }> {
  const cs = await settingsFor(companyId);
  const url = (cs?.googleReviewUrl || "").trim();
  if (rating >= 4 && url) return { publicUrl: url, escalate: false };
  return { publicUrl: null, escalate: rating <= 3 };
}

/** Private alert to the office when someone leaves 3 stars or fewer. */
export async function alertLowRating(opts: {
  companyId: string;
  bookingId: string;
  rating: number;
  comment: string;
  jobTitle: string;
}): Promise<void> {
  try {
    const admins = await db
      .select()
      .from(schema.user)
      .where(
        and(
          eq(schema.user.companyId, opts.companyId),
          eq(schema.user.role, "admin"),
        ),
      );
    for (const a of admins) {
      await db.insert(schema.notifications).values({
        companyId: opts.companyId,
        userId: a.id,
        bookingId: opts.bookingId,
        type: "low_rating",
        title: `${opts.rating}-star review needs attention`,
        body: `${opts.jobTitle}: ${opts.comment || "no comment left"}`,
      });
    }
  } catch (e) {
    console.error("[reviews] low-rating alert failed", e);
  }
}

// ── Scheduler handler ────────────────────────────────────────────────────────
registerTaskHandler(KIND, async (task) => {
  if (!task.bookingId) return;

  const [b] = await db
    .select()
    .from(schema.bookings)
    .where(eq(schema.bookings.id, task.bookingId));
  if (!b || b.status !== "completed" || b.deletedAt) return;

  // already reviewed — don't nag
  const [existing] = await db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.bookingId, b.id));
  if (existing) return;

  const cs = await settingsFor(b.companyId);
  if (cs && cs.reviewRequestEnabled === false) return;

  const to = b.customerPhone || "";
  if (!to) return;

  const company = cs?.name || "NVC360";
  const body =
    `${company}: thanks again for choosing us! How did we do? ` +
    `Rate your visit in 10 seconds: ${trackingUrl(b.publicToken)}`;

  const res = await sendSms(to, body);
  if (!res.ok && !res.skipped) throw new Error(res.error || "sms failed");
});
