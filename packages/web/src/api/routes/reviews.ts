import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq } from "drizzle-orm";
import { requireAuth, requireAdmin, tx, tenantId } from "../middleware/auth";
import { audit } from "../lib/audit";
import { z } from "zod";
import { jsonBody, longText } from "../lib/validate";
import type { AppEnv } from "../env";

type SessionUser = { id: string; name?: string };

/** Moderation is the only thing an admin may change on a review. */
const ReviewModeration = z.object({
  hidden: z.boolean().optional(),
  featured: z.boolean().optional(),
  reply: longText(2_000).optional(),
});

export const reviewsRoutes = new Hono<AppEnv>()
  // admin list (with customer + rider names)
  .get("/", requireAuth, async (c) => {
    const t = tx(c);
    const rows = await t.select(schema.reviews);
    // scope the id->name lookup to this tenant's users (global table, explicit filter)
    const users = await db.select().from(schema.user).where(eq(schema.user.companyId, tenantId(c)));
    const riders = await t.select(schema.riders);
    const uName = new Map(users.map((u) => [u.id, u.name]));
    const rUserId = new Map(riders.map((r) => [r.id, r.userId]));
    const list = rows
      .map((r) => ({
        ...r,
        customerName: uName.get(r.customerId) ?? "Client",
        riderName: r.riderId ? uName.get(rUserId.get(r.riderId) ?? "") ?? "Technician" : null,
      }))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return c.json({ reviews: list }, 200);
  })
  // public: only visible (non-hidden), used for marketing/landing
  .get("/public", async (c) => {
    const rows = await tx(c).select(schema.reviews);
    const visible = rows
      .filter((r) => !r.hidden)
      .sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0));
    return c.json({ reviews: visible }, 200);
  })
  .patch("/:id", requireAdmin, jsonBody(ReviewModeration), async (c) => {
    const me = c.get("user") as SessionUser;
    const id = c.req.param("id");
    const b = c.req.valid("json");
    const patch: Record<string, unknown> = {};
    for (const k of ["hidden", "featured", "reply"] as const)
      if (b[k] !== undefined) patch[k] = b[k];
    const [row] = await tx(c).update(
      schema.reviews,
      patch as Partial<typeof schema.reviews.$inferInsert>,
      eq(schema.reviews.id, id),
    );
    await audit({ actorId: me?.id, actorName: me?.name, action: "update", entityType: "review", entityId: id, summary: `Moderated review` });
    return c.json({ review: row }, 200);
  })
  .delete("/:id", requireAdmin, async (c) => {
    const me = c.get("user") as SessionUser;
    const id = c.req.param("id");
    await tx(c).delete(schema.reviews, eq(schema.reviews.id, id));
    await audit({ actorId: me?.id, actorName: me?.name, action: "delete", entityType: "review", entityId: id, summary: "Deleted review" });
    return c.json({ ok: true }, 200);
  });
