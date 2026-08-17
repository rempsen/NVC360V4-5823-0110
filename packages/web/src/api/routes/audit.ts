import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { desc } from "drizzle-orm";
import { requireAdmin, tx } from "../middleware/auth";
import type { AppEnv } from "../env";

export const auditRoutes = new Hono<AppEnv>()
  .get("/", requireAdmin, async (c) => {
    const limit = Math.min(Number(c.req.query("limit") || 200), 500);
    // Scope to the acting tenant — never leak another company's audit trail.
    const where = tx(c).scope(schema.auditLog);
    const q = db.select().from(schema.auditLog);
    const rows = await (where ? q.where(where) : q)
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(limit);
    return c.json({ entries: rows.map((r) => ({ ...r, meta: JSON.parse(r.meta || "{}") })) }, 200);
  });
