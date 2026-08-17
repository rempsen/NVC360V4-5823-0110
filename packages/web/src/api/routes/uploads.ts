import { Hono } from "hono";
import * as schema from "../database/schema";
import { and, eq } from "drizzle-orm";
import { requireAuth, tx } from "../middleware/auth";
import { audit } from "../lib/audit";
import { putObject, deleteObject, signedGetUrl } from "../lib/storage";
import type { AppEnv } from "../env";

type SessionUser = { id: string; name?: string };

const MAX_BYTES = 15 * 1024 * 1024; // 15MB
const ALLOWED = [
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "application/pdf",
];

export const uploadsRoutes = new Hono<AppEnv>()
  // list attachments for an entity
  .get("/:type/:id", requireAuth, async (c) => {
    const entityType = c.req.param("type");
    const entityId = c.req.param("id");
    const rows = await tx(c).select(
      schema.attachments,
      and(eq(schema.attachments.entityType, entityType), eq(schema.attachments.entityId, entityId)),
    );
    rows.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    return c.json({ attachments: rows }, 200);
  })
  // upload a file (multipart). fields: file, entityType, entityId, label
  .post("/", requireAuth, async (c) => {
    const me = c.get("user") as SessionUser;
    const form = await c.req.formData();
    const file = form.get("file");
    const entityType = String(form.get("entityType") || "");
    const entityId = String(form.get("entityId") || "");
    const label = String(form.get("label") || "");
    if (!(file instanceof File)) return c.json({ message: "No file" }, 400);
    if (!entityType || !entityId) return c.json({ message: "entityType and entityId required" }, 400);
    if (file.size > MAX_BYTES) return c.json({ message: "File too large (max 15MB)" }, 400);
    if (file.type && !ALLOWED.includes(file.type))
      return c.json({ message: `Unsupported type ${file.type}` }, 400);

    const ext = (file.name.split(".").pop() || "bin").toLowerCase().slice(0, 8);
    const id = crypto.randomUUID();
    const key = `attachments/${entityType}/${id}.${ext}`;
    const buf = Buffer.from(await file.arrayBuffer());
    const stored = await putObject(key, buf, file.type || "application/octet-stream");

    const [row] = await tx(c).insert(schema.attachments, {
      entityType, entityId,
      filename: file.name,
      url: stored.url,
      storageKey: stored.key,
      mime: file.type || "",
      size: file.size,
      label,
      uploadedBy: me?.name || "",
    });
    await audit({ actorId: me?.id, actorName: me?.name, action: "create", entityType: "attachment", entityId: row.id, summary: `Uploaded ${file.name} to ${entityType}` });
    return c.json({ attachment: row }, 201);
  })
  .delete("/:id", requireAuth, async (c) => {
    const me = c.get("user") as SessionUser;
    const id = c.req.param("id");
    const t = tx(c);
    const row = await t.selectOne(schema.attachments, eq(schema.attachments.id, id));
    if (row) {
      // prefer the stored object key; fall back to URL-derived for legacy rows
      const key = row.storageKey || row.url.replace("/uploads/", "");
      await deleteObject(key).catch(() => {});
      await t.delete(schema.attachments, eq(schema.attachments.id, id));
      await audit({ actorId: me?.id, actorName: me?.name, action: "delete", entityType: "attachment", entityId: id, summary: `Removed ${row.filename}` });
    }
    return c.json({ ok: true }, 200);
  })
  // serve an S3-stored object via a short-lived signed redirect (used when no
  // public CDN base is configured). Requires auth.
  .get("/file/:key{.+}", requireAuth, async (c) => {
    const key = decodeURIComponent(c.req.param("key"));
    const url = await signedGetUrl(key, 300);
    if (!url) return c.json({ message: "Not available" }, 404);
    return c.redirect(url, 302);
  });
