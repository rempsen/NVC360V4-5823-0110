// ─── Public options/selections page — no auth, token-based ────────────────
// Mirrors the trust model of routes/track.ts: a booking's `publicToken`
// (already used for live tracking) also unlocks its options/selections page
// at /s/:token. The customer picks one tier per category and types their
// name as an e-signature; on submit the price deltas become line items on
// the booking and the existing billing pipeline (recomputeBooking) recomputes
// subtotal/tax/total — no separate pricing math.
import { Hono } from "hono";
import { db } from "../database";
import { tdb } from "../database/tenant";
import * as schema from "../database/schema";
import { eq } from "drizzle-orm";
import { buildUnitLineItem, parseLineItems } from "../../shared/catalog";
import { recomputeBooking } from "../../services/billing";
import { z } from "zod";
import { parseBody, id as idField, shortText } from "../lib/validate";

/**
 * PUBLIC, token-only body. Prices are already resolved server-side from the
 * catalog (never trusted from the client), but the body itself was raw: an
 * unbounded `selections` array meant one request could drive thousands of
 * inserts, and two selections for the SAME category were both accepted and
 * both billed as separate line items.
 */
const SubmitBody = z.object({
  selections: z
    .array(z.object({ categoryId: idField("Category id"), itemId: idField("Option id") }))
    .min(1, "No selections provided")
    .max(50, "Too many selections")
    .refine(
      (arr) => new Set(arr.map((s) => s.categoryId)).size === arr.length,
      "Only one option can be chosen per category",
    ),
  signatureName: shortText("Signature name", 120),
});

async function resolveByToken(token: string) {
  const [b] = await db
    .select()
    .from(schema.bookings)
    .where(eq(schema.bookings.publicToken, token));
  if (!b) return null;
  if (b.tokenExpiresAt && b.tokenExpiresAt < Date.now()) return null;
  return b;
}

function sortByOrder<T extends { sortOrder: number; name?: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.sortOrder - b.sortOrder || (a.name ?? "").localeCompare(b.name ?? ""));
}

/** Line items created from option selections carry this itemId prefix so a
 *  resubmit can cleanly replace the prior set without touching other lines. */
const OPT_LINE_PREFIX = "opt_";

export const optionSelectionsRoutes = new Hono()
  .get("/:token", async (c) => {
    const token = c.req.param("token");
    const b = await resolveByToken(token);
    if (!b) return c.json({ message: "Not found" }, 404);

    const t = tdb(b.companyId);
    const [co] = await db.select().from(schema.companies).where(eq(schema.companies.id, b.companyId));
    const cats = sortByOrder((await t.select(schema.optionCategories)).filter((x) => x.active));
    const items = (await t.select(schema.optionCategoryItems)).filter((x) => x.active);
    const byCategory = new Map<string, typeof items>();
    for (const it of items) {
      const arr = byCategory.get(it.categoryId) ?? [];
      arr.push(it);
      byCategory.set(it.categoryId, arr);
    }
    const existing = await t.select(schema.bookingOptionSelections, eq(schema.bookingOptionSelections.bookingId, b.id));

    const categories = cats
      .map((cat) => ({
        id: cat.id,
        name: cat.name,
        description: cat.description,
        items: sortByOrder(byCategory.get(cat.id) ?? []).map((i) => ({
          id: i.id,
          tierLabel: i.tierLabel,
          name: i.name,
          description: i.description,
          image: i.image,
          priceDelta: i.priceDelta,
          isDefault: i.isDefault,
        })),
      }))
      .filter((cat) => cat.items.length > 0);

    return c.json({
      booking: { id: b.id, title: b.title, status: b.status, address: b.address },
      company: co ? { name: co.name } : null,
      categories,
      existingSelections: existing.map((s) => ({
        categoryId: s.categoryId,
        itemId: s.itemId,
        signatureName: s.signatureName,
        selectedAt: s.selectedAt,
      })),
      // once a signature has been captured, the page can show a locked/"thank you" state
      locked: existing.length > 0 && existing.every((s) => !!s.signatureName),
    }, 200);
  })
  .post("/:token", async (c) => {
    const token = c.req.param("token");
    const b = await resolveByToken(token);
    if (!b) return c.json({ message: "Not found" }, 404);

    const { selections, signatureName } = await parseBody(c, SubmitBody);

    const t = tdb(b.companyId);
    const cats = new Map((await t.select(schema.optionCategories)).map((x) => [x.id, x]));
    const items = await t.select(schema.optionCategoryItems);
    const itemsById = new Map(items.map((x) => [x.id, x]));

    // validate + resolve every submitted selection against the real catalog —
    // never trust client-submitted names/prices for what gets billed.
    const resolved: { category: typeof schema.optionCategories.$inferSelect; item: typeof schema.optionCategoryItems.$inferSelect }[] = [];
    for (const sel of selections) {
      const category = cats.get(sel.categoryId);
      const item = itemsById.get(sel.itemId);
      if (!category || !item || item.categoryId !== category.id) {
        return c.json({ message: `Invalid selection for category ${sel.categoryId}` }, 400);
      }
      resolved.push({ category, item });
    }

    const now = new Date();
    // replace: drop any prior selections for this booking, insert the fresh set
    await t.delete(schema.bookingOptionSelections, eq(schema.bookingOptionSelections.bookingId, b.id));
    for (const { category, item } of resolved) {
      await t.insert(schema.bookingOptionSelections, {
        bookingId: b.id,
        categoryId: category.id,
        categoryName: category.name,
        itemId: item.id,
        itemName: item.name,
        tierLabel: item.tierLabel,
        priceDelta: item.priceDelta,
        selectedBy: "customer",
        signatureName,
        selectedAt: now,
      });
    }

    // roll selections into the booking's line items as one unit-line per
    // category (transparent on the invoice), replacing any prior opt_ lines.
    const existingLines = parseLineItems(b.lineItems).filter((li) => !li.itemId.startsWith(OPT_LINE_PREFIX));
    const newLines = resolved
      .filter(({ item }) => (item.priceDelta || 0) !== 0) // the included/base tier (delta 0) doesn't need a line
      .map(({ category, item }) =>
        buildUnitLineItem({
          itemId: `${OPT_LINE_PREFIX}${item.id}`,
          name: `${category.name}: ${item.name}${item.tierLabel ? ` (${item.tierLabel})` : ""}`,
          unit: "each",
          qty: 1,
          unitPrice: item.priceDelta,
          unitPayRate: 0,
          taxable: true,
        }),
      );
    await t.update(
      schema.bookings,
      { lineItems: JSON.stringify([...existingLines, ...newLines]) },
      eq(schema.bookings.id, b.id),
    );
    const billing = await recomputeBooking(b.companyId, b.id);

    return c.json({ ok: true, billing }, 200);
  });
