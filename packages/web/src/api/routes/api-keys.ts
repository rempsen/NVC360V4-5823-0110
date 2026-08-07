import { Hono } from "hono";
import * as schema from "../database/schema";
import { eq } from "drizzle-orm";
import { requireAdmin, tx } from "../middleware/auth";
import { generateApiKey, generatePublicKey } from "../middleware/auth";
import { audit } from "../lib/audit";
import { z } from "zod";
import { parseBody, shortText } from "../lib/validate";

/**
 * The label went in as any string of any length and expiresInDays was coerced
 * with Number(), so `expiresInDays: "soon"` produced NaN and silently minted a
 * key that never expires. Scopes were already filtered against the catalog.
 */
const KeyCreate = z.object({
  label: shortText("Label", 120),
  keyType: z.enum(["secret", "public"]).optional(),
  scopes: z.array(z.string().max(120)).max(100).optional(),
  allowedOrigins: z.union([z.array(z.string().max(300)).max(50), z.string().max(2_000)]).optional(),
  expiresInDays: z
    .number({ error: "Expiry must be a number of days" })
    .int("Expiry must be a whole number of days")
    .min(1, "Expiry must be at least 1 day")
    .max(3_650, "Expiry can't be more than 3650 days")
    .optional(),
});


type SessionUser = { id: string; name?: string };

/** Catalog of available scopes, surfaced to the UI for per-key selection. */
export const SCOPE_CATALOG = [
  { id: "workorders:read", label: "Read work orders / jobs", group: "Work Orders" },
  { id: "workorders:write", label: "Create & update work orders", group: "Work Orders" },
  { id: "workorders:assign", label: "Assign / reassign jobs to techs", group: "Work Orders" },
  { id: "techs:read", label: "Read technicians, status & location", group: "Technicians" },
  { id: "clients:read", label: "Read clients", group: "Clients" },
  { id: "clients:write", label: "Create & update clients", group: "Clients" },
  { id: "catalog:read", label: "Read catalog & pricing", group: "Catalog" },
  { id: "reports:read", label: "Read reports & analytics", group: "Reports" },
  { id: "reviews:read", label: "Read reviews", group: "Reviews" },
  { id: "zones:read", label: "Read service zones", group: "Zones" },
  { id: "zones:write", label: "Manage service zones", group: "Zones" },
  { id: "photos:read", label: "Read job photos & attachments", group: "Media" },
  { id: "logs:read", label: "Read audit logs", group: "Logs" },
  { id: "messages:write", label: "Send messages / notifications", group: "Comms" },
  { id: "export:read", label: "Export / read all data", group: "Export" },
] as const;

function mask(row: typeof schema.apiKeys.$inferSelect) {
  return {
    id: row.id,
    label: row.label,
    prefix: row.prefix,
    keyType: row.keyType || "secret",
    // Public keys are browser-safe — expose the full key so forms can re-use it.
    publicKey: row.keyType === "public" ? (row.publicKey || "") : "",
    allowedOrigins: (row.allowedOrigins || "").split(",").map((s) => s.trim()).filter(Boolean),
    scopes: (row.scopes || "").split(",").map((s) => s.trim()).filter(Boolean),
    createdBy: row.createdBy,
    createdByName: row.createdByName,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    active: !row.revokedAt && (!row.expiresAt || row.expiresAt > Date.now()),
  };
}

export const apiKeysRoutes = new Hono()
  // available scopes for the create UI
  .get("/scopes", requireAdmin, (c) => c.json({ scopes: SCOPE_CATALOG }, 200))

  // MCP connection info for the UI (URL + Claude Code config snippet)
  .get("/mcp-info", requireAdmin, (c) => {
    const base =
      process.env.APP_URL?.replace(/\/$/, "") ||
      new URL(c.req.url).origin.replace(/\/$/, "");
    return c.json(
      {
        mcpUrl: `${base}/api/mcp`,
        baseUrl: base,
      },
      200,
    );
  })

  .get("/", requireAdmin, async (c) => {
    const rows = await tx(c).select(schema.apiKeys);
    rows.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    return c.json({ keys: rows.map(mask) }, 200);
  })

  // Issue a key.
  //  - PUBLIC (publishable) keys: any tenant admin can mint these — they're
  //    browser-safe and only authorize the intake-form submit surface.
  //  - SECRET keys: SUPERADMIN ONLY (full REST/MCP access across the platform).
  .post("/", requireAdmin, async (c) => {
    const me = c.get("user") as SessionUser & { role?: string };
    const b = await parseBody(c, KeyCreate);
    const label = b.label;

    const keyType: "secret" | "public" = b.keyType === "public" ? "public" : "secret";

    // Secret keys remain locked to superadmin.
    if (keyType === "secret" && (me as any)?.role !== "superadmin") {
      return c.json({ message: "Only a superadmin can create secret API keys." }, 403);
    }

    let scopes: string[] = [];
    let allowedOrigins: string[] = [];

    if (keyType === "secret") {
      scopes = Array.isArray(b.scopes) ? b.scopes : [];
      const valid = new Set(SCOPE_CATALOG.map((s) => s.id));
      scopes = scopes.filter((s) => s === "*" || valid.has(s));
      if (scopes.length === 0)
        return c.json({ message: "select at least one scope" }, 400);
    } else {
      // public keys are limited to the form-submit surface; no API scopes.
      scopes = ["forms:submit"];
      allowedOrigins = Array.isArray(b.allowedOrigins)
        ? b.allowedOrigins.map((s: string) => String(s).trim()).filter(Boolean)
        : String(b.allowedOrigins || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    }

    let expiresAt: number | null = null;
    if (b.expiresInDays) {
      expiresAt = Date.now() + b.expiresInDays * 86400_000;
    }

    const gen = keyType === "public" ? await generatePublicKey() : await generateApiKey();
    const [row] = await tx(c).insert(schema.apiKeys, {
      label,
      hashedKey: gen.hashed,
      prefix: gen.prefix,
      keyType,
      // Persist the full key for public/publishable keys so it can be
      // re-displayed & auto-embedded into share links. Never for secret keys.
      publicKey: keyType === "public" ? gen.raw : "",
      scopes: scopes.join(","),
      allowedOrigins: allowedOrigins.join(","),
      createdBy: me?.id ?? "",
      createdByName: me?.name ?? "",
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    });
    await audit({
      actorId: me?.id,
      actorName: me?.name,
      action: "create",
      entityType: "api_key",
      entityId: row.id,
      summary: `Created ${keyType} key "${label}"`,
      meta: { scopes, keyType },
    });
    // raw key returned ONCE — never stored
    return c.json({ key: mask(row), secret: gen.raw }, 201);
  })

  // revoke — admins may revoke their own public keys; secret keys are superadmin-only.
  .post("/:id/revoke", requireAdmin, async (c) => {
    const me = c.get("user") as SessionUser & { role?: string };
    const id = c.req.param("id");
    const existing = await tx(c).selectOne(schema.apiKeys, eq(schema.apiKeys.id, id));
    if (!existing) return c.json({ message: "not found" }, 404);
    if (existing.keyType !== "public" && (me as any)?.role !== "superadmin") {
      return c.json({ message: "Only a superadmin can revoke secret keys." }, 403);
    }
    const [row] = await tx(c).update(
      schema.apiKeys,
      { revokedAt: new Date() },
      eq(schema.apiKeys.id, id),
    );
    if (!row) return c.json({ message: "not found" }, 404);
    await audit({
      actorId: me?.id,
      actorName: me?.name,
      action: "delete",
      entityType: "api_key",
      entityId: id,
      summary: `Revoked API key "${row.label}"`,
    });
    return c.json({ key: mask(row) }, 200);
  })

  .delete("/:id", requireAdmin, async (c) => {
    const me = c.get("user") as SessionUser & { role?: string };
    const id = c.req.param("id");
    const existing = await tx(c).selectOne(schema.apiKeys, eq(schema.apiKeys.id, id));
    if (!existing) return c.json({ message: "not found" }, 404);
    if (existing.keyType !== "public" && (me as any)?.role !== "superadmin") {
      return c.json({ message: "Only a superadmin can delete secret keys." }, 403);
    }
    await tx(c).delete(schema.apiKeys, eq(schema.apiKeys.id, id));
    await audit({
      actorId: me?.id,
      actorName: me?.name,
      action: "delete",
      entityType: "api_key",
      entityId: id,
      summary: "Deleted API key",
    });
    return c.json({ ok: true }, 200);
  });
