import { Hono } from "hono";
import * as schema from "../database/schema";
import { eq } from "drizzle-orm";
import { requireAuth, tx } from "../middleware/auth";
import { z } from "zod";
import { jsonBody, shortText, longText } from "../lib/validate";
import type { AppEnv } from "../env";

/**
 * Automation rules were written straight from `await c.req.json()` — unvalidated,
 * and invisible to the RPC types (so the admin screen's calls couldn't be checked
 * either). `conditions`/`actionConfig` stay free-form objects because rule shapes
 * differ per trigger, but they must at least BE objects.
 */
const RuleBody = z.object({
  name: shortText("Name", 120),
  description: longText(1_000).optional(),
  trigger: shortText("Trigger", 64),
  action: shortText("Action", 64),
  conditions: z.record(z.string(), z.unknown()).optional(),
  actionConfig: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

const RulePatch = RuleBody.partial();

export const automationRoutes = new Hono<AppEnv>()
  .get("/", requireAuth, async (c) => {
    const rows = await tx(c).select(schema.automationRules);
    return c.json({ rules: rows }, 200);
  })
  .post("/", requireAuth, jsonBody(RuleBody), async (c) => {
    const b = c.req.valid("json");
    const [r] = await tx(c).insert(schema.automationRules, {
      name: b.name,
      description: b.description ?? "",
      trigger: b.trigger,
      conditions: JSON.stringify(b.conditions ?? {}),
      action: b.action,
      actionConfig: JSON.stringify(b.actionConfig ?? {}),
      enabled: b.enabled ?? true,
    });
    return c.json({ rule: r }, 201);
  })
  .patch("/:id", requireAuth, jsonBody(RulePatch), async (c) => {
    const b = c.req.valid("json");
    const set: Record<string, unknown> = {};
    for (const k of ["name", "description", "trigger", "action", "enabled"] as const)
      if (b[k] !== undefined) set[k] = b[k];
    if (b.conditions !== undefined) set.conditions = JSON.stringify(b.conditions);
    if (b.actionConfig !== undefined)
      set.actionConfig = JSON.stringify(b.actionConfig);
    const [r] = await tx(c).update(
      schema.automationRules,
      set,
      eq(schema.automationRules.id, c.req.param("id")),
    );
    return c.json({ rule: r }, 200);
  })
  .delete("/:id", requireAuth, async (c) => {
    await tx(c).delete(
      schema.automationRules,
      eq(schema.automationRules.id, c.req.param("id")),
    );
    return c.json({ ok: true }, 200);
  });
