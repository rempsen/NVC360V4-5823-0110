import { Hono } from "hono";
import * as schema from "../database/schema";
import { eq } from "drizzle-orm";
import { requireAuth, tx } from "../middleware/auth";
import { isAdminRole } from "../lib/permissions";
import type { AppEnv } from "../env";

type SessionUser = { id: string; role?: string; email: string; name: string };

export const skillsRoutes = new Hono<AppEnv>()
  // list all skills in the company's library
  .get("/", requireAuth, async (c) => {
    const rows = await tx(c).select(schema.skillLibrary);
    rows.sort(
      (a, b) =>
        a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
    );
    return c.json({ skills: rows }, 200);
  })
  // add a skill (type-new-to-add). Idempotent on name (case-insensitive).
  .post("/", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    if (!isAdminRole(u.role)) return c.json({ message: "Forbidden" }, 403);
    const body = await c.req.json();
    const name = String(body.name || "").trim();
    if (!name) return c.json({ message: "Skill name is required" }, 400);
    const category = String(body.category || "General").trim() || "General";
    const existing = await tx(c).select(schema.skillLibrary);
    const dup = existing.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (dup) return c.json({ skill: dup }, 200);
    const [s] = await tx(c).insert(schema.skillLibrary, { name, category });
    return c.json({ skill: s }, 201);
  })
  .delete("/:id", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser;
    if (!isAdminRole(u.role)) return c.json({ message: "Forbidden" }, 403);
    await tx(c).delete(schema.skillLibrary, eq(schema.skillLibrary.id, c.req.param("id")));
    return c.json({ ok: true }, 200);
  });
