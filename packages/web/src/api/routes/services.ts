import { Hono } from "hono";
import { z } from "zod";
import * as schema from "../database/schema";
import { eq } from "drizzle-orm";
import { requireAdmin, tx } from "../middleware/auth";
import { jsonBody, money, durationMins, shortText, longText } from "../lib/validate";
import type { AppEnv } from "../env";

/**
 * Service catalog.
 *
 * These endpoints feed `basePrice` and `durationMins` straight into pricing and
 * technician-pay maths, so they were the highest-risk unvalidated writes in the
 * API — a live probe created a service with an empty name, a price of -99999 and
 * a duration of -5 and got back 201 Created. Validation starts here for that
 * reason.
 */

/** `rateModel` is a JSON blob owned by the pricing UI; accept object or string. */
const rateModel = z.union([z.string().max(20_000), z.record(z.string(), z.any())]);

const ServiceCreate = z.object({
  name: shortText("Name", 120),
  category: shortText("Category", 80),
  description: longText(5_000).optional(),
  icon: z.string().trim().max(60).optional(),
  image: z.string().trim().max(2_000).optional(),
  basePrice: money("Base price").optional(),
  durationMins: durationMins.optional(),
  rateModel: rateModel.optional(),
});

/** PATCH is a partial update — every field optional, but validated when present. */
const ServiceUpdate = z
  .object({
    name: shortText("Name", 120).optional(),
    category: shortText("Category", 80).optional(),
    description: longText(5_000).optional(),
    icon: z.string().trim().max(60).optional(),
    image: z.string().trim().max(2_000).optional(),
    basePrice: money("Base price").optional(),
    durationMins: durationMins.optional(),
    rateModel: rateModel.optional(),
    active: z.boolean().optional(),
  })
  // A PATCH that changes nothing is a client bug worth surfacing, not a no-op
  // that reports success.
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

const serializeRateModel = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

export const servicesRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const t = tx(c);
    const list = (await t.select(schema.services, eq(schema.services.active, true)))
      .sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    return c.json({ services: list }, 200);
  })
  .get("/:id", async (c) => {
    const svc = await tx(c).selectOne(schema.services, eq(schema.services.id, c.req.param("id")));
    if (!svc) return c.json({ message: "Not found" }, 404);
    return c.json({ service: svc }, 200);
  })
  .post("/", requireAdmin, jsonBody(ServiceCreate), async (c) => {
    const body = c.req.valid("json");

    const [svc] = await tx(c).insert(schema.services, {
      name: body.name,
      category: body.category,
      description: body.description ?? "",
      icon: body.icon ?? "wrench",
      image: body.image ?? "",
      basePrice: body.basePrice ?? 0,
      durationMins: body.durationMins ?? 60,
      rateModel: body.rateModel !== undefined ? serializeRateModel(body.rateModel) : "",
    });
    return c.json({ service: svc }, 201);
  })
  .patch("/:id", requireAdmin, jsonBody(ServiceUpdate), async (c) => {
    const body = c.req.valid("json");

    // Only ever write validated, known keys. This also closes the
    // mass-assignment surface that `{ ...body }` used to leave open (id,
    // createdAt, rating, companyId could all be sent).
    const set: Partial<typeof schema.services.$inferInsert> = {};
    if (body.name !== undefined) set.name = body.name;
    if (body.category !== undefined) set.category = body.category;
    if (body.description !== undefined) set.description = body.description;
    if (body.icon !== undefined) set.icon = body.icon;
    if (body.image !== undefined) set.image = body.image;
    if (body.basePrice !== undefined) set.basePrice = body.basePrice;
    if (body.durationMins !== undefined) set.durationMins = body.durationMins;
    if (body.active !== undefined) set.active = body.active;
    if (body.rateModel !== undefined) set.rateModel = serializeRateModel(body.rateModel);

    const [svc] = await tx(c).update(schema.services, set, eq(schema.services.id, c.req.param("id")));
    if (!svc) return c.json({ message: "Not found" }, 404);
    return c.json({ service: svc }, 200);
  })
  .delete("/:id", requireAdmin, async (c) => {
    // Soft delete. Must confirm the row existed, otherwise deleting a
    // nonexistent id reported success.
    const [svc] = await tx(c).update(
      schema.services,
      { active: false },
      eq(schema.services.id, c.req.param("id")),
    );
    if (!svc) return c.json({ message: "Not found" }, 404);
    return c.json({ success: true }, 200);
  });
