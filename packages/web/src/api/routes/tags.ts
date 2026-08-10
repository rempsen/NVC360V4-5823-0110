import { Hono } from "hono";
import * as schema from "../database/schema";
import { eq, and, inArray } from "drizzle-orm";
import { requireAuth, requireAdmin, tx } from "../middleware/auth";
import { audit } from "../lib/audit";
import { z } from "zod";
import { parseBody, shortText, hexColor, idList } from "../lib/validate";

type SessionUser = { id: string; name?: string };

/* -------------------------------------------------------------------------- */
/*  Request bodies                                                            */
/*                                                                            */
/*  Reproduced live against :4200 before this pass:                           */
/*                                                                            */
/*   - POST / { color: "javascript:alert(1)" } and { color: "<script>x" }      */
/*     -> 201. The value goes straight into style={{ background: t.color }}    */
/*     and `${t.color}22` in tag-picker, so the chip renders with no colour    */
/*     at all — an invisible tag nobody can see they applied.                  */
/*   - POST / { scope: "whatever-i-want" } -> 201. Scope drives the only       */
/*     filter the pickers do (client | tech | both), so that tag is invisible  */
/*     in every picker while still existing in the list.                       */
/*   - POST / { label: 20,000 chars } -> 201, and { label: 123 } -> 201        */
/*     stored as the string "123.0".                                          */
/*   - PUT /:id <bogus id> -> 200 {} — reports a rename that never happened.   */
/*   - PUT /:id {} -> bare 500 (drizzle "No values to set").                   */
/*   - DELETE /:id <bogus id> -> 200 ok:true — same lie, plus a bogus audit    */
/*     log entry for a deletion that never occurred.                          */
/*   - PUT /entity/:type/:id { tagIds: "hi" } -> 200 ok:true, having ALREADY   */
/*     deleted every existing tag link for that record and inserted nothing.   */
/*     Silent data loss from a malformed payload.                             */
/*   - { tagIds: [1, 2] } and { tagIds: [5,000 ids] } -> 500, again after the  */
/*     delete had committed.                                                  */
/*                                                                            */
/*  The entity link route now also rejects tag ids that don't belong to the    */
/*  caller's tenant, so a cross-tenant id can't be linked onto a local record. */
/* -------------------------------------------------------------------------- */

const SCOPES = ["both", "client", "tech"] as const;
const scope = z.enum(SCOPES, { error: "Scope must be both, client or tech" });

/** The record types the UI can tag. Anything else is a typo or an attack. */
const ENTITY_TYPES = ["client", "tech", "work_order", "booking"] as const;
const entityType = z.enum(ENTITY_TYPES, { error: "Unknown record type" });

const TagCreate = z.object({
  label: shortText("Label", 60),
  color: hexColor("Colour").optional(),
  scope: scope.optional(),
});
const TagPatch = z
  .object({ label: shortText("Label", 60), color: hexColor("Colour"), scope })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { error: "Nothing to update" });

const EntityTagsBody = z.object({ tagIds: idList("Tags", 100) });

export const tagsRoutes = new Hono()
  // list all tags (optional ?scope=client|tech)
  .get("/", requireAuth, async (c) => {
    const scopeQ = c.req.query("scope");
    const rows = await tx(c).select(schema.tags);
    const filtered = scopeQ
      ? rows.filter((t) => t.scope === scopeQ || t.scope === "both")
      : rows;
    return c.json({ tags: filtered }, 200);
  })
  .post("/", requireAdmin, async (c) => {
    const me = c.get("user") as SessionUser;
    const b = await parseBody(c, TagCreate);
    const [tag] = await tx(c).insert(schema.tags, {
      label: b.label,
      color: b.color || "#06B6D4",
      scope: b.scope || "both",
    });
    await audit({ actorId: me?.id, actorName: me?.name, action: "create", entityType: "tag", entityId: tag.id, summary: `Created tag "${b.label}"` });
    return c.json({ tag }, 201);
  })
  .put("/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const b = await parseBody(c, TagPatch);
    const [tag] = await tx(c).update(schema.tags, b, eq(schema.tags.id, id));
    if (!tag) return c.json({ message: "Tag not found" }, 404);
    return c.json({ tag }, 200);
  })
  .delete("/:id", requireAdmin, async (c) => {
    const me = c.get("user") as SessionUser;
    const id = c.req.param("id");
    const t = tx(c);
    // Confirm the tag exists in THIS tenant before claiming a delete and
    // writing an audit entry for it.
    const existing = await t.selectOne(schema.tags, eq(schema.tags.id, id));
    if (!existing) return c.json({ message: "Tag not found" }, 404);
    await t.delete(schema.entityTags, eq(schema.entityTags.tagId, id));
    await t.delete(schema.tags, eq(schema.tags.id, id));
    await audit({ actorId: me?.id, actorName: me?.name, action: "delete", entityType: "tag", entityId: id, summary: `Deleted tag "${existing.label}"` });
    return c.json({ ok: true }, 200);
  })
  // tags assigned to an entity
  .get("/entity/:type/:id", requireAuth, async (c) => {
    const type = entityType.safeParse(c.req.param("type"));
    if (!type.success) return c.json({ tags: [] }, 200);
    const entityId = c.req.param("id");
    const t = tx(c);
    const links = await t.select(
      schema.entityTags,
      and(eq(schema.entityTags.entityType, type.data), eq(schema.entityTags.entityId, entityId)),
    );
    if (links.length === 0) return c.json({ tags: [] }, 200);
    const tagIds = links.map((l) => l.tagId);
    const tagRows = await t.select(schema.tags, inArray(schema.tags.id, tagIds));
    return c.json({ tags: tagRows }, 200);
  })
  // set the full tag list for an entity (replace)
  .put("/entity/:type/:id", requireAdmin, async (c) => {
    const type = entityType.safeParse(c.req.param("type"));
    if (!type.success) return c.json({ message: "Unknown record type" }, 404);
    const entityId = c.req.param("id");
    const { tagIds } = await parseBody(c, EntityTagsBody);
    const t = tx(c);
    // Every id must be a real tag in this tenant. Validated BEFORE the delete
    // so a bad payload can't wipe the record's existing tags on its way to a
    // failure.
    if (tagIds.length) {
      const known = await t.select(schema.tags, inArray(schema.tags.id, tagIds));
      const knownIds = new Set(known.map((r) => r.id));
      const unknown = tagIds.filter((tid) => !knownIds.has(tid));
      if (unknown.length)
        return c.json({ message: `Unknown tag: ${unknown[0]}`, fields: { tagIds: "One or more tags no longer exist" } }, 400);
    }
    await t.delete(
      schema.entityTags,
      and(eq(schema.entityTags.entityType, type.data), eq(schema.entityTags.entityId, entityId)),
    );
    if (tagIds.length) {
      await t.insert(
        schema.entityTags,
        // De-duplicate: the same tag twice in one payload used to create two
        // links and show the chip twice.
        [...new Set(tagIds)].map((tagId) => ({ tagId, entityType: type.data, entityId })),
      );
    }
    return c.json({ ok: true }, 200);
  });
