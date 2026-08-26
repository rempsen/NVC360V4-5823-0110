/**
 * Deferred task scheduler.
 *
 * Before this existed the entire notification system was reactive — everything
 * fired the instant a lifecycle event happened, and nothing could ever happen
 * "later". This is the tick that makes review requests, maintenance reminders,
 * warranty nudges, and time-based automation triggers possible.
 *
 * Concurrency: like services/retention.ts, this may run in more than one
 * process during a rolling deploy. Tasks are therefore *claimed* with a
 * conditional UPDATE (`... WHERE id = ? AND status = 'pending'`) and we only
 * execute a task if that update actually changed the row. Two instances racing
 * the same task means one wins the claim and the other sees zero rows changed
 * and skips it — no double-sends.
 */
import { db } from "../api/database";
import * as schema from "../api/database/schema";
import { and, eq, lte, asc } from "drizzle-orm";

export type TaskHandler = (task: {
  id: string;
  companyId: string;
  kind: string;
  bookingId: string | null;
  propertyId: string | null;
  payload: Record<string, unknown>;
}) => Promise<void>;

const handlers = new Map<string, TaskHandler>();

/**
 * Register a handler for a task kind. Called at module load by whatever feature
 * owns that kind (review requests, maintenance reminders, etc.) so the
 * scheduler itself stays free of feature logic.
 */
export function registerTaskHandler(kind: string, fn: TaskHandler) {
  if (handlers.has(kind)) {
    console.warn(`[scheduler] handler for "${kind}" replaced`);
  }
  handlers.set(kind, fn);
}

/** Queue work for later. Returns the task id, or null if it couldn't be queued. */
export async function scheduleTask(opts: {
  companyId: string;
  kind: string;
  runAt: Date | number;
  bookingId?: string | null;
  propertyId?: string | null;
  payload?: Record<string, unknown>;
}): Promise<string | null> {
  try {
    const [row] = await db
      .insert(schema.scheduledTasks)
      .values({
        companyId: opts.companyId,
        kind: opts.kind,
        runAt: new Date(opts.runAt),
        bookingId: opts.bookingId ?? null,
        propertyId: opts.propertyId ?? null,
        payload: JSON.stringify(opts.payload ?? {}),
      })
      .returning();
    return row?.id ?? null;
  } catch (e) {
    console.error("[scheduler] schedule failed", opts.kind, e);
    return null;
  }
}

/**
 * Cancel pending tasks — used when the thing they were about goes away
 * (job cancelled, maintenance plan deactivated). Only touches pending rows, so
 * already-executed work is never rewritten.
 */
export async function cancelTasks(opts: {
  bookingId?: string;
  kind?: string;
}): Promise<number> {
  try {
    const conds = [eq(schema.scheduledTasks.status, "pending")];
    if (opts.bookingId) conds.push(eq(schema.scheduledTasks.bookingId, opts.bookingId));
    if (opts.kind) conds.push(eq(schema.scheduledTasks.kind, opts.kind));
    const res = await db
      .update(schema.scheduledTasks)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(and(...conds));
    return (res as any)?.rowCount ?? 0;
  } catch (e) {
    console.error("[scheduler] cancel failed", e);
    return 0;
  }
}

const MAX_ATTEMPTS = 3;
const BATCH = 25;

/** Claim a single task. Returns true only if THIS process won the claim. */
async function claim(id: string): Promise<boolean> {
  const res = await db
    .update(schema.scheduledTasks)
    .set({ status: "running" })
    .where(
      and(eq(schema.scheduledTasks.id, id), eq(schema.scheduledTasks.status, "pending")),
    );
  // pg returns rowCount; if another instance claimed it first this is 0
  return ((res as any)?.rowCount ?? 0) > 0;
}

/** Run one pass over due tasks. Exported for tests / manual invocation. */
export async function runDueTasks(now: Date = new Date()): Promise<number> {
  let ran = 0;
  try {
    const due = await db
      .select()
      .from(schema.scheduledTasks)
      .where(
        and(
          eq(schema.scheduledTasks.status, "pending"),
          lte(schema.scheduledTasks.runAt, now),
        ),
      )
      .orderBy(asc(schema.scheduledTasks.runAt))
      .limit(BATCH);

    for (const task of due) {
      const handler = handlers.get(task.kind);
      if (!handler) {
        // Unknown kind — park it rather than spinning on it every tick.
        await db
          .update(schema.scheduledTasks)
          .set({
            status: "failed",
            lastError: `no handler registered for kind "${task.kind}"`,
            completedAt: new Date(),
          })
          .where(eq(schema.scheduledTasks.id, task.id));
        continue;
      }

      if (!(await claim(task.id))) continue; // lost the race, another instance has it

      const attempts = task.attempts + 1;
      try {
        await handler({
          id: task.id,
          companyId: task.companyId,
          kind: task.kind,
          bookingId: task.bookingId,
          propertyId: task.propertyId,
          payload: (() => {
            try {
              return JSON.parse(task.payload || "{}");
            } catch {
              return {};
            }
          })(),
        });
        await db
          .update(schema.scheduledTasks)
          .set({ status: "done", attempts, completedAt: new Date(), lastError: "" })
          .where(eq(schema.scheduledTasks.id, task.id));
        ran++;
      } catch (e: any) {
        const msg = e?.message || String(e);
        // Retry with a widening backoff, then give up so a poison task can't
        // block the queue forever.
        const giveUp = attempts >= MAX_ATTEMPTS;
        await db
          .update(schema.scheduledTasks)
          .set({
            status: giveUp ? "failed" : "pending",
            attempts,
            lastError: msg.slice(0, 500),
            runAt: giveUp
              ? task.runAt
              : new Date(Date.now() + attempts * 5 * 60 * 1000),
            completedAt: giveUp ? new Date() : null,
          })
          .where(eq(schema.scheduledTasks.id, task.id));
        console.error(`[scheduler] task ${task.kind} failed (attempt ${attempts})`, msg);
      }
    }
  } catch (e) {
    console.error("[scheduler] tick failed", e);
  }
  return ran;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the 60s tick. Idempotent. */
export function startScheduler(intervalMs = 60 * 1000) {
  if (timer) return;
  // Recover anything left "running" by a process that died mid-task. Safe
  // because handlers are expected to be idempotent-ish and we cap attempts.
  db.update(schema.scheduledTasks)
    .set({ status: "pending" })
    .where(eq(schema.scheduledTasks.status, "running"))
    .catch((e) => console.error("[scheduler] boot recovery failed", e));

  timer = setInterval(() => {
    runDueTasks().catch((e) => console.error("[scheduler] tick error", e));
  }, intervalMs);
  timer.unref?.();
  console.log(`[scheduler] started (every ${Math.round(intervalMs / 1000)}s)`);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
