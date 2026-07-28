// ─── Options/Tier Catalog — admin CRUD ────────────────────────────────────
// Generalized options/tier quote engine (Phase 3 cross-ICP synthesis #1
// build priority). Admins build reusable "option categories" (e.g.
// "Flooring", "Garage Door Model") each with 2+ tiers carrying a price
// delta (e.g. Good/Better/Best). These get attached to a booking via the
// public, token-based selection page (see routes/option-selections.ts).
import { Hono } from "hono";
import * as schema from "../database/schema";
import { eq, and } from "drizzle-orm";
import { requireAdmin, tx } from "../middleware/auth";

function sortByOrder<T extends { sortOrder: number; name?: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.sortOrder - b.sortOrder || (a.name ?? "").localeCompare(b.name ?? ""));
}

export const optionCatalogRoutes = new Hono()
  // ── Categories (with nested items) ───────────────────────────────────
  .get("/categories", requireAdmin, async (c) => {
    const t = tx(c);
    const cats = sortByOrder(await t.select(schema.optionCategories));
    const items = await t.select(schema.optionCategoryItems);
    const byCategory = new Map<string, typeof items>();
    for (const it of items) {
      const arr = byCategory.get(it.categoryId) ?? [];
      arr.push(it);
      byCategory.set(it.categoryId, arr);
    }
    const result = cats.map((cat) => ({
      ...cat,
      items: sortByOrder(byCategory.get(cat.id) ?? []),
    }));
    return c.json({ categories: result }, 200);
  })
  .post("/categories", requireAdmin, async (c) => {
    const t = tx(c);
    const b = await c.req.json().catch(() => ({}));
    const name = String(b.name ?? "").trim();
    if (!name) return c.json({ message: "name required" }, 400);
    const existing = await t.select(schema.optionCategories);
    const maxOrder = existing.reduce((m, r) => Math.max(m, r.sortOrder), -1);
    const [row] = await t.insert(schema.optionCategories, {
      name,
      description: String(b.description ?? "").trim(),
      sortOrder: typeof b.sortOrder === "number" ? b.sortOrder : maxOrder + 1,
    });
    return c.json({ category: { ...row, items: [] } }, 201);
  })
  .patch("/categories/:id", requireAdmin, async (c) => {
    const t = tx(c);
    const id = c.req.param("id");
    const b = await c.req.json().catch(() => ({}));
    const patch: Record<string, unknown> = {};
    if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim();
    if (typeof b.description === "string") patch.description = b.description.trim();
    if (typeof b.sortOrder === "number") patch.sortOrder = b.sortOrder;
    if (typeof b.active === "boolean") patch.active = b.active;
    const [row] = await t.update(schema.optionCategories, patch, eq(schema.optionCategories.id, id));
    if (!row) return c.json({ message: "Not found" }, 404);
    return c.json({ category: row }, 200);
  })
  .delete("/categories/:id", requireAdmin, async (c) => {
    const t = tx(c);
    const id = c.req.param("id");
    await t.delete(schema.optionCategoryItems, eq(schema.optionCategoryItems.categoryId, id));
    await t.delete(schema.optionCategories, eq(schema.optionCategories.id, id));
    return c.json({ ok: true }, 200);
  })
  // ── Tier items within a category ──────────────────────────────────────
  .post("/categories/:id/items", requireAdmin, async (c) => {
    const t = tx(c);
    const categoryId = c.req.param("id");
    const cat = await t.selectOne(schema.optionCategories, eq(schema.optionCategories.id, categoryId));
    if (!cat) return c.json({ message: "Category not found" }, 404);
    const b = await c.req.json().catch(() => ({}));
    const name = String(b.name ?? "").trim();
    if (!name) return c.json({ message: "name required" }, 400);
    const existing = await t.select(schema.optionCategoryItems, eq(schema.optionCategoryItems.categoryId, categoryId));
    const maxOrder = existing.reduce((m, r) => Math.max(m, r.sortOrder), -1);
    // only one default tier per category — clear any existing default if this one is marked default
    if (b.isDefault) {
      for (const it of existing) {
        if (it.isDefault) {
          await t.update(schema.optionCategoryItems, { isDefault: false }, eq(schema.optionCategoryItems.id, it.id));
        }
      }
    }
    const [row] = await t.insert(schema.optionCategoryItems, {
      categoryId,
      tierLabel: String(b.tierLabel ?? "").trim(),
      name,
      description: String(b.description ?? "").trim(),
      image: String(b.image ?? "").trim(),
      priceDelta: Number(b.priceDelta) || 0,
      unitCost: Number(b.unitCost) || 0,
      isDefault: !!b.isDefault,
      sortOrder: typeof b.sortOrder === "number" ? b.sortOrder : maxOrder + 1,
    });
    return c.json({ item: row }, 201);
  })
  .patch("/categories/:id/items/:itemId", requireAdmin, async (c) => {
    const t = tx(c);
    const categoryId = c.req.param("id");
    const itemId = c.req.param("itemId");
    const b = await c.req.json().catch(() => ({}));
    if (b.isDefault) {
      const siblings = await t.select(schema.optionCategoryItems, eq(schema.optionCategoryItems.categoryId, categoryId));
      for (const it of siblings) {
        if (it.id !== itemId && it.isDefault) {
          await t.update(schema.optionCategoryItems, { isDefault: false }, eq(schema.optionCategoryItems.id, it.id));
        }
      }
    }
    const patch: Record<string, unknown> = {};
    if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim();
    if (typeof b.tierLabel === "string") patch.tierLabel = b.tierLabel.trim();
    if (typeof b.description === "string") patch.description = b.description.trim();
    if (typeof b.image === "string") patch.image = b.image.trim();
    if (b.priceDelta !== undefined) patch.priceDelta = Number(b.priceDelta) || 0;
    if (b.unitCost !== undefined) patch.unitCost = Number(b.unitCost) || 0;
    if (typeof b.isDefault === "boolean") patch.isDefault = b.isDefault;
    if (typeof b.sortOrder === "number") patch.sortOrder = b.sortOrder;
    if (typeof b.active === "boolean") patch.active = b.active;
    const [row] = await t.update(
      schema.optionCategoryItems,
      patch,
      and(eq(schema.optionCategoryItems.id, itemId), eq(schema.optionCategoryItems.categoryId, categoryId)),
    );
    if (!row) return c.json({ message: "Not found" }, 404);
    return c.json({ item: row }, 200);
  })
  .delete("/categories/:id/items/:itemId", requireAdmin, async (c) => {
    const t = tx(c);
    const itemId = c.req.param("itemId");
    await t.delete(schema.optionCategoryItems, eq(schema.optionCategoryItems.id, itemId));
    return c.json({ ok: true }, 200);
  })
  // ── Per-booking view for admins (mirrors what the public page shows) ──
  .get("/bookings/:bookingId/selections", requireAdmin, async (c) => {
    const t = tx(c);
    const bookingId = c.req.param("bookingId");
    const rows = await t.select(schema.bookingOptionSelections, eq(schema.bookingOptionSelections.bookingId, bookingId));
    return c.json({ selections: rows }, 200);
  })
  // ── Attach-rate report — the Phase 3 "attach-rate reporting" ask ──────
  // For every category, what % of bookings that made a selection picked a
  // non-default (upgrade) tier, and how much incremental revenue that drove.
  .get("/attach-rate", requireAdmin, async (c) => {
    const t = tx(c);
    const cats = await t.select(schema.optionCategories);
    const items = await t.select(schema.optionCategoryItems);
    const selections = await t.select(schema.bookingOptionSelections);
    const itemById = new Map(items.map((i) => [i.id, i]));

    const byCategory = new Map<string, typeof selections>();
    for (const s of selections) {
      const arr = byCategory.get(s.categoryId) ?? [];
      arr.push(s);
      byCategory.set(s.categoryId, arr);
    }

    const report = cats.map((cat) => {
      const sels = byCategory.get(cat.id) ?? [];
      const total = sels.length;
      let upgrades = 0;
      let incrementalRevenue = 0;
      for (const s of sels) {
        const item = itemById.get(s.itemId);
        const isDefault = item?.isDefault ?? s.priceDelta <= 0;
        if (!isDefault) upgrades++;
        incrementalRevenue += s.priceDelta || 0;
      }
      return {
        categoryId: cat.id,
        categoryName: cat.name,
        totalSelections: total,
        upgradeSelections: upgrades,
        attachRatePct: total > 0 ? Math.round((upgrades / total) * 1000) / 10 : 0,
        incrementalRevenue: Math.round(incrementalRevenue * 100) / 100,
      };
    });

    return c.json({
      report,
      summary: {
        totalCategories: cats.length,
        totalSelections: selections.length,
        totalIncrementalRevenue: Math.round(selections.reduce((s, x) => s + (x.priceDelta || 0), 0) * 100) / 100,
      },
    }, 200);
  });
