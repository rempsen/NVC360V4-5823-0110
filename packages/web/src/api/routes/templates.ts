import { Hono } from "hono";
import * as schema from "../database/schema";
import { eq } from "drizzle-orm";
import { requireAuth, tx } from "../middleware/auth";
import { z } from "zod";
import { jsonBody, shortText, longText, hexColor } from "../lib/validate";
import type { AppEnv } from "../env";

/**
 * Work-order templates. `fields`/`checklist` are builder-authored arrays and
 * `rateModel` may arrive as either an object or an already-stringified snapshot,
 * so those stay loose — everything a human types is bounded.
 */
const TemplateBody = z.object({
  name: shortText("Name", 120),
  category: shortText("Category", 64).optional(),
  icon: shortText("Icon", 64).optional(),
  color: hexColor().optional(),
  description: longText(2_000).optional(),
  fields: z.array(z.unknown()).optional(),
  checklist: z.array(z.unknown()).optional(),
  estimatedMins: z.number().int().min(0).max(43_200).optional(),
  rateModel: z.unknown().optional(),
  active: z.boolean().optional(),
});

const TemplatePatch = TemplateBody.partial();

export const templatesRoutes = new Hono<AppEnv>()
  .get("/", requireAuth, async (c) => {
    const rows = await tx(c).select(schema.taskTemplates);
    return c.json({ templates: rows }, 200);
  })
  .get("/:id", requireAuth, async (c) => {
    const t = await tx(c).selectOne(
      schema.taskTemplates,
      eq(schema.taskTemplates.id, c.req.param("id")),
    );
    if (!t) return c.json({ message: "Not found" }, 404);
    return c.json({ template: t }, 200);
  })
  .post("/", requireAuth, jsonBody(TemplateBody), async (c) => {
    const body = c.req.valid("json");
    const [t] = await tx(c).insert(schema.taskTemplates, {
      name: body.name,
      category: body.category ?? "General",
      icon: body.icon ?? "clipboard-list",
      color: body.color ?? "#0ea5e9",
      description: body.description ?? "",
      fields: JSON.stringify(body.fields ?? []),
      checklist: JSON.stringify(body.checklist ?? []),
      estimatedMins: body.estimatedMins ?? 60,
      rateModel:
        body.rateModel !== undefined
          ? typeof body.rateModel === "string"
            ? body.rateModel
            : JSON.stringify(body.rateModel)
          : "",
    });
    return c.json({ template: t }, 201);
  })
  .patch("/:id", requireAuth, jsonBody(TemplatePatch), async (c) => {
    const body = c.req.valid("json");
    const set: Record<string, unknown> = {};
    for (const k of ["name", "category", "icon", "color", "description", "estimatedMins", "active"] as const)
      if (body[k] !== undefined) set[k] = body[k];
    if (body.fields !== undefined) set.fields = JSON.stringify(body.fields);
    if (body.checklist !== undefined) set.checklist = JSON.stringify(body.checklist);
    if (body.rateModel !== undefined)
      set.rateModel =
        typeof body.rateModel === "string" ? body.rateModel : JSON.stringify(body.rateModel);
    const [t] = await tx(c).update(
      schema.taskTemplates,
      set,
      eq(schema.taskTemplates.id, c.req.param("id")),
    );
    return c.json({ template: t }, 200);
  })
  .delete("/:id", requireAuth, async (c) => {
    await tx(c).delete(
      schema.taskTemplates,
      eq(schema.taskTemplates.id, c.req.param("id")),
    );
    return c.json({ ok: true }, 200);
  });
