import { Hono } from "hono";
import * as schema from "../database/schema";
import { eq, and, gte, lte } from "drizzle-orm";
import { requireAuth, requireAdmin, tx } from "../middleware/auth";
import type { AppEnv } from "../env";

export const shiftsRoutes = new Hono<AppEnv>()
  // list shifts/time-off, optional ?riderId & ?from & ?to (ms)
  .get("/", requireAuth, async (c) => {
    const riderId = c.req.query("riderId");
    const from = c.req.query("from");
    const to = c.req.query("to");
    const conds = [];
    if (riderId) conds.push(eq(schema.techShifts.riderId, riderId));
    if (from) conds.push(gte(schema.techShifts.date, new Date(Number(from))));
    if (to) conds.push(lte(schema.techShifts.date, new Date(Number(to))));
    const rows = await tx(c).select(
      schema.techShifts,
      conds.length ? and(...conds) : undefined,
    );
    return c.json({ shifts: rows }, 200);
  })
  .post("/", requireAdmin, async (c) => {
    const b = await c.req.json();
    if (!b.riderId || !b.date) return c.json({ message: "riderId and date required" }, 400);
    const [shift] = await tx(c).insert(schema.techShifts, {
      riderId: b.riderId,
      kind: b.kind || "shift",
      date: new Date(b.date),
      startMin: b.startMin ?? 540,
      endMin: b.endMin ?? 1020,
      note: b.note ?? "",
    });
    return c.json({ shift }, 201);
  })
  .put("/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const b = await c.req.json();
    const patch: Record<string, unknown> = {};
    for (const k of ["kind", "startMin", "endMin", "note"]) if (k in b) patch[k] = b[k];
    if (b.date) patch.date = new Date(b.date);
    const [shift] = await tx(c).update(
      schema.techShifts,
      patch as Partial<typeof schema.techShifts.$inferInsert>,
      eq(schema.techShifts.id, id),
    );
    return c.json({ shift }, 200);
  })
  .delete("/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    await tx(c).delete(schema.techShifts, eq(schema.techShifts.id, id));
    return c.json({ ok: true }, 200);
  });
