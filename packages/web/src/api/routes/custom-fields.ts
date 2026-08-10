import { Hono } from "hono";
import * as schema from "../database/schema";
import { eq, and, inArray } from "drizzle-orm";
import { requireAuth, requireAdmin, tx } from "../middleware/auth";
import { audit } from "../lib/audit";
import { z } from "zod";
import { parseBody, shortText, longText, sortOrder, bool, stringList } from "../lib/validate";

type SessionUser = { id: string; name?: string };

/* -------------------------------------------------------------------------- */
/*  Request bodies                                                            */
/*                                                                            */
/*  The worst bug in this file was reproduced end to end in a real browser:    */
/*                                                                            */
/*    POST /api/custom-fields { label: "x", type: "select", entity: "tech",    */
/*                             options: "a,b,c" }   -> 201                     */
/*                                                                            */
/*  `options` was stored with a blind JSON.stringify, so a STRING was saved    */
/*  as `"\"a,b,c\""`. The renderer does JSON.parse(options).map(...), which    */
/*  threw "o.map is not a function" — and because that component is mounted    */
/*  inside the technician drawer, the ENTIRE drawer was replaced by the error  */
/*  boundary ("Try again" / "Reload page") for every admin, on every tech,     */
/*  permanently, until that one row was deleted. One malformed API call took   */
/*  out a core admin screen.                                                  */
/*                                                                            */
/*  Also reproduced: `type: "nuclear-launch"` and `entity: "whatever"` both    */
/*  accepted (a field with an unknown type renders as a bare text box under a  */
/*  record type no screen ever reads), a 20,000-character label accepted, and  */
/*  PUT/DELETE on a bogus id returning 200 for work that never happened.       */
/*                                                                            */
/*  Value writes are validated too: the fieldIds in a values payload must be   */
/*  real field definitions in this tenant, so a caller can't stuff arbitrary   */
/*  key/value rows into custom_field_values.                                   */
/* -------------------------------------------------------------------------- */

/** Must stay in sync with FIELD_TYPES in web/pages/admin/tags.tsx. */
const FIELD_TYPES = [
  "text", "textarea", "number", "date", "select", "checkbox", "file", "signature", "payment", "note",
] as const;
const fieldType = z.enum(FIELD_TYPES, { error: "Unknown field type" });

/** Must stay in sync with ENTITIES in web/pages/admin/tags.tsx. */
const ENTITIES = ["client", "tech", "work_order", "booking"] as const;
const entity = z.enum(ENTITIES, { error: "Unknown record type" });

const FieldCreate = z.object({
  entity,
  label: shortText("Label", 120),
  type: fieldType.optional(),
  options: stringList("Options", 100, 200).optional(),
  placeholder: longText(200).optional(),
  required: bool("Required").optional(),
  section: shortText("Section", 60).optional(),
  sortOrder: sortOrder.optional(),
});
const FieldPatch = z
  .object({
    label: shortText("Label", 120),
    type: fieldType,
    options: stringList("Options", 100, 200),
    placeholder: longText(200),
    required: bool("Required"),
    section: shortText("Section", 60),
    sortOrder,
    active: bool("Active"),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { error: "Nothing to update" });

/** Stored values: a map of fieldId -> answer. Bounded on both sides. */
const ValuesBody = z.object({
  values: z.record(
    z.string().min(1),
    z.string({ error: "Field values must be text" }).max(20_000, "Answer is too long"),
    { error: "Values must be an object of field answers" },
  ),
});

export const customFieldsRoutes = new Hono()
  // list field definitions for an entity type: client | tech | work_order
  .get("/", requireAuth, async (c) => {
    const entityQ = c.req.query("entity");
    let rows = await tx(c).select(schema.customFields);
    rows.sort((a, b) => a.sortOrder - b.sortOrder);
    if (entityQ) rows = rows.filter((f) => f.entity === entityQ);
    return c.json({ fields: rows }, 200);
  })
  .post("/", requireAdmin, async (c) => {
    const me = c.get("user") as SessionUser;
    const b = await parseBody(c, FieldCreate);
    const existing = await tx(c).select(
      schema.customFields,
      eq(schema.customFields.entity, b.entity),
    );
    const [field] = await tx(c).insert(schema.customFields, {
      entity: b.entity,
      label: b.label,
      type: b.type || "text",
      options: JSON.stringify(b.options ?? []),
      placeholder: b.placeholder ?? "",
      required: b.required ?? false,
      section: b.section || "General",
      sortOrder: b.sortOrder ?? existing.length,
    });
    await audit({ actorId: me?.id, actorName: me?.name, action: "create", entityType: "custom_field", entityId: field.id, summary: `Added field "${b.label}" to ${b.entity}` });
    return c.json({ field }, 201);
  })
  .put("/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const b = await parseBody(c, FieldPatch);
    const { options, ...rest } = b;
    const patch: Record<string, unknown> = { ...rest };
    if (options !== undefined) patch.options = JSON.stringify(options);
    const [field] = await tx(c).update(
      schema.customFields,
      patch as Partial<typeof schema.customFields.$inferInsert>,
      eq(schema.customFields.id, id),
    );
    if (!field) return c.json({ message: "Field not found" }, 404);
    return c.json({ field }, 200);
  })
  .delete("/:id", requireAdmin, async (c) => {
    const me = c.get("user") as SessionUser;
    const id = c.req.param("id");
    const t = tx(c);
    const existing = await t.selectOne(schema.customFields, eq(schema.customFields.id, id));
    if (!existing) return c.json({ message: "Field not found" }, 404);
    // Drop the stored answers too — they were orphaned rows before.
    await t.delete(schema.customFieldValues, eq(schema.customFieldValues.fieldId, id));
    await t.delete(schema.customFields, eq(schema.customFields.id, id));
    await audit({ actorId: me?.id, actorName: me?.name, action: "delete", entityType: "custom_field", entityId: id, summary: `Removed custom field "${existing.label}"` });
    return c.json({ ok: true }, 200);
  })
  // get stored values for an entity instance
  .get("/values/:type/:id", requireAuth, async (c) => {
    const entityType = c.req.param("type");
    const entityId = c.req.param("id");
    const rows = await tx(c).select(
      schema.customFieldValues,
      and(
        eq(schema.customFieldValues.entityType, entityType),
        eq(schema.customFieldValues.entityId, entityId),
      ),
    );
    const map: Record<string, string> = {};
    for (const r of rows) map[r.fieldId] = r.value;
    return c.json({ values: map }, 200);
  })
  // upsert values for an entity instance
  .put("/values/:type/:id", requireAuth, async (c) => {
    const entityTypeParam = c.req.param("type");
    const entityId = c.req.param("id");
    const { values } = await parseBody(c, ValuesBody);
    const fieldIds = Object.keys(values);
    if (fieldIds.length > 200)
      return c.json({ message: "Too many fields in one save", fields: { values: "Too many fields" } }, 400);
    if (fieldIds.length) {
      const t = tx(c);
      // Only accept ids that are real field definitions in this tenant.
      const defs = await t.select(schema.customFields, inArray(schema.customFields.id, fieldIds));
      const knownIds = new Set(defs.map((d) => d.id));
      const unknown = fieldIds.filter((f) => !knownIds.has(f));
      if (unknown.length)
        return c.json({ message: "Unknown custom field", fields: { values: "One or more fields no longer exist" } }, 400);
      const existing = await t.select(
        schema.customFieldValues,
        and(
          eq(schema.customFieldValues.entityType, entityTypeParam),
          eq(schema.customFieldValues.entityId, entityId),
          inArray(schema.customFieldValues.fieldId, fieldIds),
        ),
      );
      const existingMap = new Map(existing.map((e) => [e.fieldId, e.id]));
      for (const fid of fieldIds) {
        if (existingMap.has(fid)) {
          await t.update(
            schema.customFieldValues,
            { value: values[fid], updatedAt: new Date() },
            eq(schema.customFieldValues.id, existingMap.get(fid)!),
          );
        } else {
          await t.insert(schema.customFieldValues, {
            fieldId: fid,
            entityType: entityTypeParam,
            entityId,
            value: values[fid],
            updatedAt: new Date(),
          });
        }
      }
    }
    return c.json({ ok: true }, 200);
  });
