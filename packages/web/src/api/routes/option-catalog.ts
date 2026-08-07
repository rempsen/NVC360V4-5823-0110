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
import { z } from "zod";
import {
  parseBody,
  shortText,
  longText,
  money,
  signedMoney,
  sortOrder,
  imageRef,
  bool,
} from "../lib/validate";

/* -------------------------------------------------------------------------- */
/*  Request bodies                                                            */
/*                                                                            */
/*  This file hand-coerced every field, which hid money bugs rather than       */
/*  rejecting them. Reproduced live before this pass:                          */
/*                                                                            */
/*   - POST /categories/:id/items { priceDelta: "1,200" } -> 201 with          */
/*     priceDelta 0. Number("1,200") is NaN and `|| 0` swallowed it, so the    */
/*     "Best" upgrade tier was published to customers as FREE. Same for        */
/*     "lots", "$1200", and any pasted value with a comma or currency sign.    */
/*     This is the worst class of bug in the file: it bills the wrong amount   */
/*     silently instead of erroring.                                           */
/*   - priceDelta: 1e308 and unitCost: "free" were accepted the same way.      */
/*   - POST /categories with a 20,000-character name -> 201.                   */
/*   - PATCH /categories/:id { sortOrder: 1e12 } -> 200.                       */
/*   - PATCH /categories/:id {} and { companyId: "other-co" } -> bare 500:     */
/*     nothing survived the field filter, so drizzle got an empty SET clause   */
/*     and threw "No values to set".                                           */
/*   - PATCH item { image: "javascript:alert(1)" } -> 200, and that value is   */
/*     rendered in an <img src> on the PUBLIC customer options page.           */
/*   - DELETE /categories/<bogus id> -> 200 ok:true, reporting a delete that   */
/*     never happened.                                                        */
/* -------------------------------------------------------------------------- */

const CategoryCreate = z.object({
  name: shortText("Name", 120),
  description: longText(1_000).optional(),
  sortOrder: sortOrder.optional(),
});
const CategoryPatch = z
  .object({
    name: shortText("Name", 120),
    description: longText(1_000),
    sortOrder: sortOrder,
    active: bool("Active"),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { error: "Nothing to update" });

const ItemFields = {
  name: shortText("Name", 120),
  tierLabel: longText(60).optional(),
  description: longText(1_000).optional(),
  image: imageRef("Image").optional(),
  // A tier delta may be negative (a downgrade credit) but must be a real
  // number — never a string we quietly turn into 0.
  priceDelta: signedMoney("Price delta").optional(),
  unitCost: money("Unit cost").optional(),
  isDefault: bool("Default tier").optional(),
  sortOrder: sortOrder.optional(),
  active: bool("Active").optional(),
};
const ItemCreate = z.object(ItemFields);
const ItemPatch = z
  .object({ ...ItemFields, name: shortText("Name", 120).optional() })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { error: "Nothing to update" });

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
    const b = await parseBody(c, CategoryCreate);
    const existing = await t.select(schema.optionCategories);
    const maxOrder = existing.reduce((m, r) => Math.max(m, r.sortOrder), -1);
    const [row] = await t.insert(schema.optionCategories, {
      name: b.name,
      description: b.description ?? "",
      sortOrder: b.sortOrder ?? maxOrder + 1,
    });
    return c.json({ category: { ...row, items: [] } }, 201);
  })
  .patch("/categories/:id", requireAdmin, async (c) => {
    const t = tx(c);
    const id = c.req.param("id");
    const b = await parseBody(c, CategoryPatch);
    const [row] = await t.update(schema.optionCategories, b, eq(schema.optionCategories.id, id));
    if (!row) return c.json({ message: "Not found" }, 404);
    return c.json({ category: row }, 200);
  })
  .delete("/categories/:id", requireAdmin, async (c) => {
    const t = tx(c);
    const id = c.req.param("id");
    const cat = await t.selectOne(schema.optionCategories, eq(schema.optionCategories.id, id));
    if (!cat) return c.json({ message: "Not found" }, 404);
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
    const b = await parseBody(c, ItemCreate);
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
      tierLabel: b.tierLabel ?? "",
      name: b.name,
      description: b.description ?? "",
      image: b.image ?? "",
      priceDelta: b.priceDelta ?? 0,
      unitCost: b.unitCost ?? 0,
      isDefault: b.isDefault ?? false,
      sortOrder: b.sortOrder ?? maxOrder + 1,
    });
    return c.json({ item: row }, 201);
  })
  .patch("/categories/:id/items/:itemId", requireAdmin, async (c) => {
    const t = tx(c);
    const categoryId = c.req.param("id");
    const itemId = c.req.param("itemId");
    const b = await parseBody(c, ItemPatch);
    if (b.isDefault) {
      const siblings = await t.select(schema.optionCategoryItems, eq(schema.optionCategoryItems.categoryId, categoryId));
      for (const it of siblings) {
        if (it.id !== itemId && it.isDefault) {
          await t.update(schema.optionCategoryItems, { isDefault: false }, eq(schema.optionCategoryItems.id, it.id));
        }
      }
    }
    const [row] = await t.update(
      schema.optionCategoryItems,
      b,
      and(eq(schema.optionCategoryItems.id, itemId), eq(schema.optionCategoryItems.categoryId, categoryId)),
    );
    if (!row) return c.json({ message: "Not found" }, 404);
    return c.json({ item: row }, 200);
  })
  .delete("/categories/:id/items/:itemId", requireAdmin, async (c) => {
    const t = tx(c);
    const itemId = c.req.param("itemId");
    const item = await t.selectOne(
      schema.optionCategoryItems,
      and(eq(schema.optionCategoryItems.id, itemId), eq(schema.optionCategoryItems.categoryId, c.req.param("id"))),
    );
    if (!item) return c.json({ message: "Not found" }, 404);
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
