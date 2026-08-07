/**
 * Automation engine — makes the `automation_rules` table actually do something.
 *
 * Until now rules could be created in the admin UI but nothing ever evaluated
 * them. This module is that evaluator. It is deliberately small and boring:
 *
 *   runAutomations(trigger, ctx)  ->  for each enabled rule of that trigger in
 *                                     that tenant, check conditions, run action
 *
 * Design rules:
 * - Best effort. A failing rule logs and moves on; it must NEVER fail the job
 *   or notification that triggered it.
 * - No parallel notification system. Actions reuse services/sms.ts,
 *   services/notify.ts and the existing job-events log.
 * - Event-driven triggers fire from dispatch.fireEvent(). Time-based triggers
 *   (tech_idle, sla_risk) are swept by the scheduler every minute.
 */
import { db } from "../api/database";
import * as schema from "../api/database/schema";
import { and, eq, isNull, or } from "drizzle-orm";
import { sendSms, trackingUrl } from "./sms";
import { logJobEvent } from "./job-events";
import { predictDelays } from "./ai-dispatch";

export type AutomationTrigger =
  | "wo_created"
  | "tech_enroute"
  | "wo_completed"
  | "tech_idle"
  | "sla_risk";

/** Map an NvcEvent (dispatch) onto an automation trigger, if any. */
export const EVENT_TO_TRIGGER: Record<string, AutomationTrigger> = {
  created: "wo_created",
  enroute: "tech_enroute",
  completed: "wo_completed",
};

export interface AutomationCtx {
  companyId: string;
  bookingId?: string | null;
  /** Anything the action templates can interpolate: {{customerName}} etc. */
  vars?: Record<string, string | number | null>;
  /** Fields conditions can match on. */
  facts?: Record<string, unknown>;
}

function parse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw || "") as T;
  } catch {
    return fallback;
  }
}

/**
 * Condition matching. Conditions are a flat object; every key must match for
 * the rule to run (AND). Supported shapes per key:
 *
 *   { priority: "high" }                exact match
 *   { priority: ["high", "urgent"] }    any-of
 *   { minMinutes: 30 }                  numeric >= (keys prefixed min*)
 *   { maxMinutes: 30 }                  numeric <= (keys prefixed max*)
 *
 * An empty condition object always matches — that's the common case.
 */
export function conditionsMatch(
  conditions: Record<string, unknown>,
  facts: Record<string, unknown>,
): boolean {
  for (const [key, want] of Object.entries(conditions ?? {})) {
    if (want === "" || want == null) continue; // unset filter — ignore

    if (key.startsWith("min")) {
      const factKey = key.slice(3, 4).toLowerCase() + key.slice(4);
      if (Number(facts[factKey] ?? 0) < Number(want)) return false;
      continue;
    }
    if (key.startsWith("max")) {
      const factKey = key.slice(3, 4).toLowerCase() + key.slice(4);
      if (Number(facts[factKey] ?? 0) > Number(want)) return false;
      continue;
    }
    const have = facts[key];
    if (Array.isArray(want)) {
      if (!want.map(String).includes(String(have))) return false;
    } else if (String(have) !== String(want)) {
      return false;
    }
  }
  return true;
}

function interpolate(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ""));
}

/** Notify every admin/dispatcher in the tenant, in-app. */
async function notifyOffice(
  companyId: string,
  title: string,
  body: string,
  bookingId?: string | null,
) {
  const admins = await db
    .select()
    .from(schema.user)
    .where(
      and(
        eq(schema.user.companyId, companyId),
        or(eq(schema.user.role, "admin"), eq(schema.user.role, "dispatcher")),
      ),
    );
  for (const a of admins) {
    await db.insert(schema.notifications).values({
      companyId,
      userId: a.id,
      bookingId: bookingId ?? null,
      type: "automation",
      title,
      body,
    });
  }
}

/** Execute one rule's action. Throws only on programmer error; callers catch. */
async function runAction(
  rule: typeof schema.automationRules.$inferSelect,
  ctx: AutomationCtx,
): Promise<string> {
  const cfg = parse<Record<string, any>>(rule.actionConfig, {});
  const vars = ctx.vars ?? {};

  switch (rule.action) {
    case "send_sms": {
      const to = String(cfg.to || vars.customerPhone || "");
      const body = interpolate(String(cfg.message || ""), vars);
      if (!to || !body) return "skipped: no recipient or message";
      const res = await sendSms(to, body);
      return res.ok ? `sms sent to ${to}` : `sms failed: ${res.error}`;
    }
    case "notify_dispatch":
    case "escalate": {
      const title = interpolate(
        String(cfg.title || rule.name || "Automation"),
        vars,
      );
      const body = interpolate(
        String(cfg.message || rule.description || ""),
        vars,
      );
      await notifyOffice(rule.companyId, title, body, ctx.bookingId);
      return "office notified";
    }
    case "auto_assign": {
      // Auto-assign only ever *suggests* — actual dispatch stays a human/AI
      // decision in the dispatch board, so an automation rule can never
      // silently send the wrong tech to a customer's home.
      await notifyOffice(
        rule.companyId,
        "Auto-assign suggested",
        `Rule "${rule.name}" flagged this job for immediate assignment.`,
        ctx.bookingId,
      );
      return "assignment suggested";
    }
    case "reroute": {
      await notifyOffice(
        rule.companyId,
        "Reroute suggested",
        `Rule "${rule.name}" suggests rerouting. ${
          ctx.bookingId ? trackingUrl(String(vars.token ?? "")) : ""
        }`.trim(),
        ctx.bookingId,
      );
      return "reroute suggested";
    }
    default:
      return `unknown action "${rule.action}"`;
  }
}

/**
 * Evaluate every enabled rule for a trigger. Never throws.
 * Returns the number of rules that actually ran.
 */
export async function runAutomations(
  trigger: AutomationTrigger,
  ctx: AutomationCtx,
): Promise<number> {
  let ran = 0;
  try {
    const rules = await db
      .select()
      .from(schema.automationRules)
      .where(
        and(
          eq(schema.automationRules.companyId, ctx.companyId),
          eq(schema.automationRules.trigger, trigger),
          eq(schema.automationRules.enabled, true),
        ),
      );

    for (const rule of rules) {
      try {
        const conds = parse<Record<string, unknown>>(rule.conditions, {});
        if (!conditionsMatch(conds, ctx.facts ?? {})) continue;

        const outcome = await runAction(rule, ctx);
        ran++;

        await db
          .update(schema.automationRules)
          .set({
            runsCount: (rule.runsCount ?? 0) + 1,
            lastRunAt: new Date(),
          })
          .where(eq(schema.automationRules.id, rule.id));

        if (ctx.bookingId) {
          await logJobEvent({
            companyId: ctx.companyId,
            bookingId: ctx.bookingId,
            kind: "note_added",
            actorRole: "system",
            actorName: "Automation",
            label: `Automation: ${rule.name}`,
            detail: outcome,
          });
        }
      } catch (e) {
        console.error("[automation] rule failed", rule.id, rule.name, e);
      }
    }
  } catch (e) {
    console.error("[automation] evaluation failed", trigger, e);
  }
  return ran;
}

// ── Time-based triggers ──────────────────────────────────────────────────────
// Event triggers fire inline from dispatch. These two are conditions of time
// passing, so nothing fires them — the scheduler sweeps for them each minute.

const IDLE_FLAGGED = new Map<string, number>(); // riderId -> last flagged ms
const SLA_FLAGGED = new Map<string, number>(); // bookingId -> last flagged ms
const REFLAG_AFTER_MS = 60 * 60 * 1000; // don't nag more than hourly

function recentlyFlagged(map: Map<string, number>, key: string): boolean {
  const last = map.get(key);
  if (last && Date.now() - last < REFLAG_AFTER_MS) return true;
  map.set(key, Date.now());
  return false;
}

/**
 * Sweep for time-based automation triggers. Called by the scheduler.
 * Only walks tenants that actually have an enabled time-based rule, so the
 * common case (nobody uses them) costs one indexed query per minute.
 */
export async function sweepTimeTriggers(now: Date = new Date()): Promise<number> {
  let fired = 0;
  try {
    const timeRules = await db
      .select()
      .from(schema.automationRules)
      .where(eq(schema.automationRules.enabled, true));
    const relevant = timeRules.filter(
      (r) => r.trigger === "tech_idle" || r.trigger === "sla_risk",
    );
    if (!relevant.length) return 0;

    const companies = [...new Set(relevant.map((r) => r.companyId))];

    for (const companyId of companies) {
      const rules = relevant.filter((r) => r.companyId === companyId);

      // ── tech_idle: available techs with no active job ──
      if (rules.some((r) => r.trigger === "tech_idle")) {
        const idleMins = Math.max(
          5,
          Math.min(
            ...rules
              .filter((r) => r.trigger === "tech_idle")
              .map((r) => Number(parse<any>(r.conditions, {}).minMinutes ?? 30)),
          ),
        );
        const techs = await db
          .select()
          .from(schema.riders)
          .where(
            and(
              eq(schema.riders.companyId, companyId),
              eq(schema.riders.status, "available"),
            ),
          );
        for (const tech of techs) {
          const since = tech.locationUpdatedAt ? Number(tech.locationUpdatedAt) : null;
          const mins = since ? (now.getTime() - since) / 60000 : idleMins + 1;
          if (mins < idleMins) continue;
          const [u] = await db
            .select()
            .from(schema.user)
            .where(eq(schema.user.id, tech.userId));
          if (recentlyFlagged(IDLE_FLAGGED, tech.id)) continue;
          fired += await runAutomations("tech_idle", {
            companyId,
            vars: { techName: u?.name ?? "", idleMinutes: Math.round(mins) },
            facts: { idleMinutes: Math.round(mins), minutes: Math.round(mins) },
          });
        }
      }

      // ── sla_risk: scheduled soon (or overdue) and still unassigned ──
      if (rules.some((r) => r.trigger === "sla_risk")) {
        const leadMins = Math.max(
          5,
          Math.min(
            ...rules
              .filter((r) => r.trigger === "sla_risk")
              .map((r) => Number(parse<any>(r.conditions, {}).minMinutes ?? 60)),
          ),
        );
        const open = await db
          .select()
          .from(schema.bookings)
          .where(
            and(
              eq(schema.bookings.companyId, companyId),
              eq(schema.bookings.status, "pending"),
              isNull(schema.bookings.deletedAt),
            ),
          );
        for (const b of open) {
          if (!b.scheduledAt) continue;
          const minsUntil = (Number(b.scheduledAt) - now.getTime()) / 60000;
          if (minsUntil > leadMins) continue;
          if (recentlyFlagged(SLA_FLAGGED, b.id)) continue;
          fired += await runAutomations("sla_risk", {
            companyId,
            bookingId: b.id,
            vars: {
              jobName: b.title,
              shortId: b.id.slice(0, 6).toUpperCase(),
              address: b.address,
              minutesUntil: Math.round(minsUntil),
              token: b.publicToken,
            },
            facts: {
              minutesUntil: Math.round(minsUntil),
              minutes: Math.round(minsUntil),
              priority: b.priority,
              risk: "unassigned",
            },
          });
        }

        // ── sla_risk (Phase 5): jobs ALREADY assigned but projected to finish
        // late. The check above only ever saw unassigned work approaching its
        // window — it was blind to a tech running 40 minutes behind.
        const risks = await predictDelays(companyId, { graceMins: 15 });
        for (const r of risks) {
          if (recentlyFlagged(SLA_FLAGGED, r.bookingId)) continue;
          const [bk] = await db
            .select()
            .from(schema.bookings)
            .where(eq(schema.bookings.id, r.bookingId));
          if (!bk) continue;
          fired += await runAutomations("sla_risk", {
            companyId,
            bookingId: r.bookingId,
            vars: {
              jobName: r.title,
              shortId: r.bookingId.slice(0, 6).toUpperCase(),
              address: r.address,
              techName: r.techName,
              minutesLate: r.minutesLate,
              minutesUntil: 0,
              token: bk.publicToken,
            },
            facts: {
              minutesLate: r.minutesLate,
              minutes: r.minutesLate,
              minutesUntil: 0,
              priority: bk.priority,
              risk: "running_late",
              status: r.status,
            },
          });
        }
      }
    }
  } catch (e) {
    console.error("[automation] time sweep failed", e);
  }
  return fired;
}
