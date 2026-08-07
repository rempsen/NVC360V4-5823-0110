/**
 * Maintenance plans — recurring service agreements.
 *
 * A plan is "this address needs this service every N days". This module owns
 * the whole lifecycle:
 *
 *   activate/save plan  -> queue the next reminder task
 *   reminder fires      -> text the customer, notify the office, roll the due
 *                          date forward by intervalDays, queue the next one
 *   deactivate/delete   -> cancel the pending task so it goes quiet at once
 *
 * Reminders are best-effort notifications, not bookings: nothing is scheduled
 * on anyone's calendar automatically. The customer replies or taps through to
 * the intake form, and the office books it like any other job.
 */
import { db } from "../api/database";
import * as schema from "../api/database/schema";
import { and, eq } from "drizzle-orm";
import { registerTaskHandler, scheduleTask } from "./scheduler";
import { sendSms } from "./sms";
import { propertyUrl } from "./properties";

const KIND = "maintenance_reminder";

/** When the reminder for a given plan should go out. */
export function reminderRunAt(plan: {
  nextDueAt: Date | number | null;
  remindDaysBefore: number;
}): Date | null {
  if (!plan.nextDueAt) return null;
  const due = Number(plan.nextDueAt);
  const at = due - Math.max(0, plan.remindDaysBefore) * 86_400_000;
  // never queue in the past — a plan created late reminds right away
  return new Date(Math.max(at, Date.now() + 60_000));
}

/** Cancel any pending reminder for a plan (plan paused, deleted, rescheduled). */
export async function cancelPlanReminders(planId: string): Promise<void> {
  try {
    const pending = await db
      .select()
      .from(schema.scheduledTasks)
      .where(
        and(
          eq(schema.scheduledTasks.kind, KIND),
          eq(schema.scheduledTasks.status, "pending"),
        ),
      );
    for (const t of pending) {
      let pid = "";
      try {
        pid = String(JSON.parse(t.payload || "{}").planId ?? "");
      } catch {
        /* ignore */
      }
      if (pid !== planId) continue;
      await db
        .update(schema.scheduledTasks)
        .set({ status: "cancelled", completedAt: new Date() })
        .where(eq(schema.scheduledTasks.id, t.id));
    }
  } catch (e) {
    console.error("[maintenance] cancel failed", planId, e);
  }
}

/**
 * Sync the queued reminder to match the plan's current state.
 * Idempotent — safe to call on every create/update.
 */
export async function syncPlanReminder(planId: string): Promise<void> {
  try {
    const [plan] = await db
      .select()
      .from(schema.maintenancePlans)
      .where(eq(schema.maintenancePlans.id, planId));
    if (!plan) return;

    await cancelPlanReminders(planId);
    if (!plan.active || !plan.nextDueAt) return;

    const runAt = reminderRunAt(plan);
    if (!runAt) return;
    await scheduleTask({
      companyId: plan.companyId,
      kind: KIND,
      propertyId: plan.propertyId,
      runAt,
      payload: { planId },
    });
  } catch (e) {
    console.error("[maintenance] sync failed", planId, e);
  }
}

// ── Scheduler handler ────────────────────────────────────────────────────────
registerTaskHandler(KIND, async (task) => {
  const planId = String((task.payload as any)?.planId ?? "");
  if (!planId) return;

  const [plan] = await db
    .select()
    .from(schema.maintenancePlans)
    .where(eq(schema.maintenancePlans.id, planId));
  if (!plan || !plan.active) return;

  const [cs] = await db
    .select()
    .from(schema.companySettings)
    .where(eq(schema.companySettings.companyId, plan.companyId));
  const company = cs?.name || "NVC360";

  // Customer text — with the property hub link so they can see the history
  // behind the recommendation instead of taking our word for it.
  let hubUrl = "";
  if (plan.propertyId) {
    const [prop] = await db
      .select()
      .from(schema.properties)
      .where(eq(schema.properties.id, plan.propertyId));
    if (prop) hubUrl = propertyUrl(prop.publicToken);
  }

  let phone = "";
  if (plan.customerId) {
    const [cust] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, plan.customerId));
    phone = cust?.phone || "";
  }

  const due = plan.nextDueAt
    ? new Date(Number(plan.nextDueAt)).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    : "soon";
  const what = plan.name || "your scheduled service";

  if (phone) {
    const body =
      `${company}: ${what} is due ${due}` +
      (plan.address ? ` at ${plan.address}` : "") +
      `. Reply to book a time.` +
      (hubUrl ? ` Service history: ${hubUrl}` : "");
    const res = await sendSms(phone, body);
    if (!res.ok && !res.skipped) throw new Error(res.error || "sms failed");
  }

  // Office copy so nothing depends on the customer replying.
  const admins = await db
    .select()
    .from(schema.user)
    .where(
      and(
        eq(schema.user.companyId, plan.companyId),
        eq(schema.user.role, "admin"),
      ),
    );
  for (const a of admins) {
    await db.insert(schema.notifications).values({
      companyId: plan.companyId,
      userId: a.id,
      type: "maintenance_due",
      title: `${what} due ${due}`,
      body: plan.address || "Recurring maintenance plan is due.",
    });
  }

  // Roll forward and queue the next cycle.
  const nextDue = new Date(
    Number(plan.nextDueAt ?? Date.now()) +
      Math.max(1, plan.intervalDays) * 86_400_000,
  );
  await db
    .update(schema.maintenancePlans)
    .set({
      nextDueAt: nextDue,
      remindersSent: (plan.remindersSent ?? 0) + 1,
    })
    .where(eq(schema.maintenancePlans.id, planId));

  await syncPlanReminder(planId);
});
