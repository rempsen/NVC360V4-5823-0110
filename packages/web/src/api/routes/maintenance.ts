import type { AppEnv } from "../env";
/**
 * Maintenance plans (recurring service agreements) — admin CRUD.
 *
 * The scheduling side effects live in services/maintenance.ts; these routes
 * just own the rows and call syncPlanReminder() after every write so the queued
 * reminder always matches the plan's current state.
 */
import { Hono } from "hono";
import * as schema from "../database/schema";
import { eq } from "drizzle-orm";
import { requireAuth, tx } from "../middleware/auth";
import {
  syncPlanReminder,
  cancelPlanReminders,
} from "../../services/maintenance";

function dateOrNull(v: unknown): Date | null {
  if (!v) return null;
  const d = new Date(v as string);
  return isNaN(d.getTime()) ? null : d;
}

export const maintenanceRoutes = new Hono<AppEnv>()
  .get("/", requireAuth, async (c) => {
    const rows = await tx(c).select(schema.maintenancePlans);
    rows.sort(
      (a, b) => Number(a.nextDueAt ?? 0) - Number(b.nextDueAt ?? 0),
    );
    return c.json({ plans: rows }, 200);
  })

  .post("/", requireAuth, async (c) => {
    const b = await c.req.json();
    const interval = Math.max(1, Number(b.intervalDays) || 180);
    // Default the first due date one full interval out, so creating a plan
    // right after a visit doesn't immediately remind anyone.
    const next =
      dateOrNull(b.nextDueAt) ?? new Date(Date.now() + interval * 86_400_000);

    const [plan] = await tx(c).insert(schema.maintenancePlans, {
      name: b.name ?? "",
      customerId: b.customerId || null,
      propertyId: b.propertyId || null,
      serviceId: b.serviceId || null,
      address: b.address ?? "",
      intervalDays: interval,
      remindDaysBefore: Math.max(0, Number(b.remindDaysBefore) || 7),
      nextDueAt: next,
      lastServiceAt: dateOrNull(b.lastServiceAt),
      notes: b.notes ?? "",
      active: b.active ?? true,
    });
    if (plan) await syncPlanReminder(plan.id);
    return c.json({ plan }, 201);
  })

  .patch("/:id", requireAuth, async (c) => {
    const id = c.req.param("id");
    const b = await c.req.json();
    const set: Record<string, unknown> = {};
    for (const k of ["name", "address", "notes", "active", "customerId", "propertyId", "serviceId"])
      if (b[k] !== undefined) set[k] = b[k];
    if (b.intervalDays !== undefined)
      set.intervalDays = Math.max(1, Number(b.intervalDays) || 180);
    if (b.remindDaysBefore !== undefined)
      set.remindDaysBefore = Math.max(0, Number(b.remindDaysBefore) || 0);
    if (b.nextDueAt !== undefined) set.nextDueAt = dateOrNull(b.nextDueAt);
    if (b.lastServiceAt !== undefined)
      set.lastServiceAt = dateOrNull(b.lastServiceAt);

    const [plan] = await tx(c).update(
      schema.maintenancePlans,
      set,
      eq(schema.maintenancePlans.id, id),
    );
    await syncPlanReminder(id);
    return c.json({ plan }, 200);
  })

  .delete("/:id", requireAuth, async (c) => {
    const id = c.req.param("id");
    await cancelPlanReminders(id);
    await tx(c).delete(
      schema.maintenancePlans,
      eq(schema.maintenancePlans.id, id),
    );
    return c.json({ ok: true }, 200);
  })

  /**
   * Mark a plan serviced — rolls the due date forward one interval from today
   * and re-queues the reminder. Used when a plan visit actually happens.
   */
  .post("/:id/serviced", requireAuth, async (c) => {
    const id = c.req.param("id");
    const t = tx(c);
    const plan = await t.selectOne(
      schema.maintenancePlans,
      eq(schema.maintenancePlans.id, id),
    );
    if (!plan) return c.json({ message: "Not found" }, 404);
    const [updated] = await t.update(
      schema.maintenancePlans,
      {
        lastServiceAt: new Date(),
        nextDueAt: new Date(
          Date.now() + Math.max(1, plan.intervalDays) * 86_400_000,
        ),
      },
      eq(schema.maintenancePlans.id, id),
    );
    await syncPlanReminder(id);
    return c.json({ plan: updated }, 200);
  });
