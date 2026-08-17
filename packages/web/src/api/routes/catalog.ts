import type { AppEnv } from "../env";
import { Hono } from "hono";
import * as schema from "../database/schema";
import { eq } from "drizzle-orm";
import { db } from "../database";
import { requireAdmin, tx, tenantId } from "../middleware/auth";
import { audit } from "../lib/audit";
import { putObject } from "../lib/storage";
import { getIndustryPreset } from "../../services/industry-presets";
import { z } from "zod";
import { jsonBody, money, shortText, longText, optText, id as idField } from "../lib/validate";

/**
 * Catalog item shape. `PATCH /:id` previously did `set = { ...body }` with a
 * hand-maintained denylist of five keys — any column not on that list could be
 * written by a client, and unitCost/markupPct/unitPrice took negative values
 * that flow straight into quote subtotals and technician pay.
 */
const CatalogFields = {
  kind: z.enum(["product", "service", "assembly"]).optional(),
  name: shortText("Name", 200),
  sku: optText(64),
  category: optText(120),
  description: longText(5_000).optional(),
  image: optText(2_000),
  unit: optText(32),
  unitCost: money("Unit cost").optional(),
  // NOT percent(): trades routinely mark material up well past 100%. Capped
  // at 1000% only to stop a fat-fingered 10000 from wrecking a quote.
  markupPct: z.number().finite().min(0, "Markup can't be negative").max(1000, "Markup can't exceed 1000%").optional(),
  priceMode: z.enum(["auto", "manual"]).optional(),
  unitPrice: money("Unit price").optional(),
  taxable: z.boolean().optional(),
  components: z.unknown().optional(),
  serviceId: idField("Service").nullable().optional(),
};

const CatalogCreate = z.object(CatalogFields);
/** Same fields, all optional — and nothing else gets through. */
const CatalogPatch = z
  .object({ ...CatalogFields, name: shortText("Name", 200).optional() })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

/**
 * These three call sites were `audit(c, "create", "catalog_item", ...)` —
 * positional args against a function that takes a single options object. Every
 * catalog audit insert therefore had `action: undefined`, failed the NOT NULL
 * constraint, and was swallowed by audit()'s own try/catch: catalog changes
 * left no audit trail at all.
 */
async function auditItem(c: any, action: string, entityId: string, summary: string) {
  const me = c.get("user") as { id?: string; name?: string } | undefined;
  await audit({
    actorId: me?.id,
    actorName: me?.name,
    action,
    entityType: "catalog_item",
    entityId,
    summary,
    companyId: tenantId(c),
  });
}

const CategoryCreate = z.object({ name: shortText("Category name", 120) });
const CategoryPatch = z.object({
  name: shortText("Category name", 120).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
import {
  normalizeCatalogItem,
  itemUnitCost,
  itemUnitPrice,
  marginPct,
  type CatalogItem,
} from "../../shared/catalog";

const MAX_BYTES = 15 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif"];

/** Decorate a raw row with resolved cost/price/margin (assemblies rolled up). */
function decorate(rows: (typeof schema.catalogItems.$inferSelect)[]) {
  const items: CatalogItem[] = rows.map(normalizeCatalogItem);
  const byId = new Map(items.map((i) => [i.id, i]));
  const lookup = (id: string) => byId.get(id);
  return rows.map((r) => {
    const it = normalizeCatalogItem(r);
    const cost = itemUnitCost(it, lookup);
    const price = itemUnitPrice(it, lookup);
    return {
      ...r,
      components: it.components,
      resolvedUnitCost: cost,
      resolvedUnitPrice: price,
      resolvedMarginPct: marginPct(cost, price),
    };
  });
}

function normComponents(v: unknown): string {
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === "string") {
    try { const a = JSON.parse(v); return Array.isArray(a) ? JSON.stringify(a) : "[]"; } catch { return "[]"; }
  }
  return "[]";
}

export const catalogRoutes = new Hono<AppEnv>()
  // list (optionally filter by kind + search)
  .get("/", async (c) => {
    const kind = c.req.query("kind");
    const q = (c.req.query("q") || "").toLowerCase();
    const includeInactive = c.req.query("all") === "1";
    let rows = await tx(c).select(schema.catalogItems);
    rows = rows.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    if (!includeInactive) rows = rows.filter((r) => r.active);
    if (kind && kind !== "all") rows = rows.filter((r) => r.kind === kind);
    if (q)
      rows = rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.sku.toLowerCase().includes(q) ||
          r.category.toLowerCase().includes(q)
      );
    return c.json({ items: decorate(rows) }, 200);
  })
  // ---------------------------------------------------------------------
  // Shared category LIST (managed, ordered) — the single source of truth
  // used by BOTH the Form Builder template "Category" dropdown and the
  // Product Catalog item "Category" field, so admins edit one list and it
  // applies everywhere. Seeded once from the tenant's industry preset on
  // first read (a fresh tenant isn't empty); fully editable after that.
  //
  // IMPORTANT: this MUST be registered before the generic "/:id" route
  // below — Hono matches routes in registration order, so GET "/categories"
  // was previously being swallowed by GET "/:id" (with id="categories"),
  // silently 404ing since no catalog item has that id. Same reasoning kept
  // this whole block ahead of "/:id" further down.
  // ---------------------------------------------------------------------
  .get("/categories", requireAdmin, async (c) => {
    const t = tx(c);
    let rows = await t.select(schema.formCategories);
    if (rows.length === 0) {
      const [co] = await db
        .select({ industry: schema.companies.industry })
        .from(schema.companies)
        .where(eq(schema.companies.id, tenantId(c)));
      const preset = getIndustryPreset(co?.industry);
      const seed = preset?.categories?.length ? preset.categories : ["General", "Residential", "Commercial", "Service"];
      await t.insert(
        schema.formCategories,
        seed.map((name, i) => ({ name, sortOrder: i })),
      );
      rows = await t.select(schema.formCategories);
    }
    rows.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    return c.json({ categories: rows }, 200);
  })
  .post("/categories", requireAdmin, jsonBody(CategoryCreate), async (c) => {
    const t = tx(c);
    const { name } = c.req.valid("json");
    const existing = await t.select(schema.formCategories);
    if (existing.some((r) => r.name.toLowerCase() === name.toLowerCase()))
      return c.json({ message: "A category with this name already exists." }, 409);
    const maxOrder = existing.reduce((m, r) => Math.max(m, r.sortOrder), -1);
    const [row] = await t.insert(schema.formCategories, { name, sortOrder: maxOrder + 1 });
    return c.json({ category: row }, 201);
  })
  .patch("/categories/:id", requireAdmin, jsonBody(CategoryPatch), async (c) => {
    const t = tx(c);
    const id = c.req.param("id");
    const body = c.req.valid("json");
    const patch: Record<string, unknown> = {};
    if (body.name) patch.name = body.name;
    if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;
    const before = await t.selectOne(schema.formCategories, eq(schema.formCategories.id, id));
    const [row] = await t.update(schema.formCategories, patch, eq(schema.formCategories.id, id));
    // Renaming a category doesn't retroactively rewrite existing catalog items
    // or templates that reference the OLD name by design (avoids surprising
    // bulk edits) — but we do it here anyway since "rename" should mean rename,
    // not "orphan everything that used the old value".
    if (before && row && patch.name && before.name !== row.name) {
      await t.update(
        schema.catalogItems,
        { category: row.name } as any,
        eq(schema.catalogItems.category, before.name),
      );
      await t.update(
        schema.taskTemplates,
        { category: row.name } as any,
        eq(schema.taskTemplates.category, before.name),
      );
    }
    return c.json({ category: row }, 200);
  })
  .delete("/categories/:id", requireAdmin, async (c) => {
    const t = tx(c);
    const id = c.req.param("id");
    const row = await t.selectOne(schema.formCategories, eq(schema.formCategories.id, id));
    if (!row) return c.json({ message: "Not found" }, 404);
    const inUseCatalog = (await t.select(schema.catalogItems, eq(schema.catalogItems.category, row.name))).length;
    const inUseTemplates = (await t.select(schema.taskTemplates, eq(schema.taskTemplates.category, row.name))).length;
    if (inUseCatalog + inUseTemplates > 0)
      return c.json({
        message: `"${row.name}" is used by ${inUseCatalog} catalog item(s) and ${inUseTemplates} template(s). Reassign them to another category before deleting.`,
      }, 409);
    await t.delete(schema.formCategories, eq(schema.formCategories.id, id));
    return c.json({ ok: true }, 200);
  })
  // single item (with resolved math)
  .get("/:id", async (c) => {
    const row = await tx(c).selectOne(schema.catalogItems, eq(schema.catalogItems.id, c.req.param("id")));
    if (!row) return c.json({ message: "Not found" }, 404);
    const [dec] = decorate([row]);
    return c.json({ item: dec }, 200);
  })
  // create
  .post("/", requireAdmin, jsonBody(CatalogCreate), async (c) => {
    const b = c.req.valid("json");
    const [row] = await tx(c).insert(schema.catalogItems, {
      kind: b.kind ?? "product",
      name: b.name,
      sku: b.sku ?? "",
      category: b.category ?? "General",
      description: b.description ?? "",
      image: b.image ?? "",
      unit: b.unit ?? "each",
      unitCost: b.unitCost ?? 0,
      markupPct: b.markupPct ?? 0,
      priceMode: b.priceMode ?? "auto",
      unitPrice: b.unitPrice ?? 0,
      taxable: b.taxable !== false,
      components: normComponents(b.components),
      serviceId: b.serviceId ?? null,
    });
    await auditItem(c, "create", row.id, `Created ${row.kind} "${row.name}"`);
    const [dec] = decorate([row]);
    return c.json({ item: dec }, 201);
  })
  // update
  .patch("/:id", requireAdmin, jsonBody(CatalogPatch), async (c) => {
    const b = c.req.valid("json");
    // The schema strips unknown keys, so the old delete-list is gone: id,
    // companyId, createdAt and the derived resolved* fields simply can't
    // arrive any more.
    const set: Record<string, unknown> = { ...b };
    if (b.components !== undefined) set.components = normComponents(b.components);
    const [row] = await tx(c).update(
      schema.catalogItems,
      set as Partial<typeof schema.catalogItems.$inferInsert>,
      eq(schema.catalogItems.id, c.req.param("id")),
    );
    if (!row) return c.json({ message: "Not found" }, 404);
    await auditItem(c, "update", row.id, `Updated "${row.name}"`);
    const [dec] = decorate([row]);
    return c.json({ item: dec }, 200);
  })
  // soft delete
  .delete("/:id", requireAdmin, async (c) => {
    const [row] = await tx(c).update(
      schema.catalogItems,
      { active: false },
      eq(schema.catalogItems.id, c.req.param("id")),
    );
    if (row) await auditItem(c, "delete", row.id, `Archived "${row.name}"`);
    return c.json({ success: true }, 200);
  })
  // image upload (multipart: file)
  .post("/:id/image", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ message: "No file" }, 400);
    if (file.size > MAX_BYTES) return c.json({ message: "File too large (max 15MB)" }, 400);
    if (file.type && !ALLOWED.includes(file.type))
      return c.json({ message: `Unsupported type ${file.type}` }, 400);
    const ext = (file.name.split(".").pop() || "png").toLowerCase().slice(0, 8);
    const key = `catalog/${id}/${crypto.randomUUID()}.${ext}`;
    const stored = await putObject(
      key,
      Buffer.from(await file.arrayBuffer()),
      file.type || "image/png",
    );
    await tx(c).update(schema.catalogItems, { image: stored.url }, eq(schema.catalogItems.id, id));
    return c.json({ url: stored.url }, 200);
  })
  // distinct categories actually IN USE on catalog items (for the catalog filter bar)
  .get("/meta/categories", async (c) => {
    const rows = await tx(c).select(schema.catalogItems, eq(schema.catalogItems.active, true));
    const cats = Array.from(new Set(rows.map((r) => r.category))).filter(Boolean).sort();
    return c.json({ categories: cats }, 200);
  })
  // migrate legacy services → catalog (idempotent: skips already-migrated by serviceId)
  .post("/seed-from-services", requireAdmin, async (c) => {
    const t = tx(c);
    const services = await t.select(schema.services);
    const existing = await t.select(schema.catalogItems);
    const migrated = new Set(existing.map((e) => e.serviceId).filter(Boolean));
    let created = 0;
    for (const s of services) {
      if (migrated.has(s.id)) continue;
      await t.insert(schema.catalogItems, {
        kind: "service",
        name: s.name,
        category: s.category || "General",
        description: s.description || "",
        image: s.image || "",
        unit: "job",
        unitCost: 0,
        markupPct: 0,
        priceMode: "manual",
        unitPrice: s.basePrice || 0,
        taxable: true,
        serviceId: s.id,
      });
      created++;
    }
    return c.json({ created, total: services.length }, 200);
  });
