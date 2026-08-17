import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq, desc, and } from "drizzle-orm";
import { requireAuth, tenantId } from "../middleware/auth";
import type { AppEnv } from "../env";

type SessionUser = { id: string };

export const notificationsRoutes = new Hono<AppEnv>()
  .get("/", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    const rows = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, u.id))
      .orderBy(desc(schema.notifications.createdAt))
      .limit(50);
    return c.json({ notifications: rows }, 200);
  })
  .post("/:id/read", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    // Ownership guard: a user may only mark THEIR OWN notification read (IDOR fix).
    await db
      .update(schema.notifications)
      .set({ read: true })
      .where(
        and(
          eq(schema.notifications.id, c.req.param("id")),
          eq(schema.notifications.userId, u.id),
        ),
      );
    return c.json({ success: true }, 200);
  })
  .post("/read-all", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    await db
      .update(schema.notifications)
      .set({ read: true })
      .where(eq(schema.notifications.userId, u.id));
    return c.json({ success: true }, 200);
  })
  // Register (or refresh) an Expo push token for the current device.
  // Idempotent: upsert on the unique token so re-registering just bumps lastSeenAt.
  .post("/push-token", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    const body = await c.req.json().catch(() => ({}));
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token || !token.startsWith("ExponentPushToken")) {
      return c.json({ message: "Invalid push token" }, 400);
    }
    const platform = body.platform === "android" ? "android" : "ios";
    const deviceName =
      typeof body.deviceName === "string" ? body.deviceName.slice(0, 120) : "";

    const existing = await db
      .select()
      .from(schema.pushTokens)
      .where(eq(schema.pushTokens.token, token));

    if (existing.length) {
      // Token may have moved to a different user (shared device / re-login).
      await db
        .update(schema.pushTokens)
        .set({
          userId: u.id,
          companyId: tenantId(c),
          platform,
          deviceName,
          lastSeenAt: new Date(),
        })
        .where(eq(schema.pushTokens.token, token));
    } else {
      await db.insert(schema.pushTokens).values({
        userId: u.id,
        companyId: tenantId(c),
        token,
        platform,
        deviceName,
        lastSeenAt: new Date(),
      });
    }
    return c.json({ success: true }, 200);
  })
  // Unregister this device's token (called on logout).
  .post("/push-token/remove", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    const body = await c.req.json().catch(() => ({}));
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) return c.json({ message: "Missing token" }, 400);
    await db
      .delete(schema.pushTokens)
      .where(
        and(
          eq(schema.pushTokens.token, token),
          eq(schema.pushTokens.userId, u.id),
        ),
      );
    return c.json({ success: true }, 200);
  });
