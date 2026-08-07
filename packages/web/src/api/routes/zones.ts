import { Hono } from "hono";
import { z } from "zod";
import * as schema from "../database/schema";
import { eq } from "drizzle-orm";
import { requireAuth, requireAdmin, tx } from "../middleware/auth";
import { audit } from "../lib/audit";
import { parseBody, shortText } from "../lib/validate";

type SessionUser = { id: string; name?: string };

/** A polygon is a list of [lat, lng] pairs. Bounded so a client can't post
 *  a multi-megabyte ring and have it stored verbatim. */
const polygon = z
  .array(z.tuple([z.number().finite(), z.number().finite()]))
  .max(5_000, "Zone outline has too many points");

const hexColor = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Color must be a hex value like #06B6D4");

/** Surge is a multiplier on the client charge — a negative or 100x value here
 *  would corrupt pricing, so it is bounded on both sides. */
const surgeMultiplier = z
  .number({ message: "Surge multiplier must be a number" })
  .finite("Surge multiplier must be a real number")
  .min(0.1, "Surge multiplier can't be below 0.1")
  .max(10, "Surge multiplier can't exceed 10");

const ZoneCreate = z.object({
  name: shortText("Name", 120),
  color: hexColor.optional(),
  polygon: polygon.optional(),
  surgeMultiplier: surgeMultiplier.optional(),
  active: z.boolean().optional(),
});

const ZoneUpdate = z
  .object({
    name: shortText("Name", 120).optional(),
    color: hexColor.optional(),
    polygon: polygon.optional(),
    surgeMultiplier: surgeMultiplier.optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export const zonesRoutes = new Hono()
  .get("/", requireAuth, async (c) => {
    const rows = await tx(c).select(schema.serviceZones);
    return c.json({ zones: rows.map((z) => ({ ...z, polygon: safeParse(z.polygon) })) }, 200);
  })
  .post("/", requireAdmin, async (c) => {
    const me = c.get("user") as SessionUser;
    const b = await parseBody(c, ZoneCreate);

    const [zone] = await tx(c).insert(schema.serviceZones, {
      name: b.name,
      color: b.color || "#06B6D4",
      polygon: JSON.stringify(b.polygon ?? []),
      surgeMultiplier: b.surgeMultiplier ?? 1,
      active: b.active ?? true,
    });
    await audit({ actorId: me?.id, actorName: me?.name, action: "create", entityType: "service_zone", entityId: zone.id, summary: `Created zone "${b.name}"` });
    return c.json({ zone: { ...zone, polygon: safeParse(zone.polygon) } }, 201);
  })
  .put("/:id", requireAdmin, async (c) => {
    const me = c.get("user") as SessionUser;
    const id = c.req.param("id");
    const b = await parseBody(c, ZoneUpdate);

    const patch: Partial<typeof schema.serviceZones.$inferInsert> = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.color !== undefined) patch.color = b.color;
    if (b.surgeMultiplier !== undefined) patch.surgeMultiplier = b.surgeMultiplier;
    if (b.active !== undefined) patch.active = b.active;
    if (b.polygon !== undefined) patch.polygon = JSON.stringify(b.polygon);

    const [zone] = await tx(c).update(schema.serviceZones, patch, eq(schema.serviceZones.id, id));
    // Was an unchecked destructure followed by `zone.polygon` — updating a
    // nonexistent id threw and returned 500 instead of 404.
    if (!zone) return c.json({ message: "Zone not found" }, 404);

    await audit({ actorId: me?.id, actorName: me?.name, action: "update", entityType: "service_zone", entityId: id, summary: `Updated zone "${zone.name}"` });
    return c.json({ zone: { ...zone, polygon: safeParse(zone.polygon) } }, 200);
  })
  .delete("/:id", requireAdmin, async (c) => {
    const me = c.get("user") as SessionUser;
    const id = c.req.param("id");
    // Confirm it exists so deleting an unknown id doesn't report success.
    const existing = await tx(c).selectOne(schema.serviceZones, eq(schema.serviceZones.id, id));
    if (!existing) return c.json({ message: "Zone not found" }, 404);
    await tx(c).delete(schema.serviceZones, eq(schema.serviceZones.id, id));
    await audit({ actorId: me?.id, actorName: me?.name, action: "delete", entityType: "service_zone", entityId: id, summary: `Deleted zone "${existing.name}"` });
    return c.json({ ok: true }, 200);
  });

/** Stored polygons are JSON text; a malformed row must not 500 the list. */
function safeParse(raw: string | null | undefined): unknown[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
