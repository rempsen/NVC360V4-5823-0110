import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq } from "drizzle-orm";
import { requireAuth, tx } from "../middleware/auth";
import { isSuperadmin } from "../lib/permissions";
import {
  PROVIDERS, type ProviderId, hasCredentials, credentialSource, buildAuthorizeUrl,
  exchangeCode, refreshTokens, redirectUri, invalidateCredentialCache,
} from "../../services/oauth";
import { uploadToDrive, DEFAULT_BACKUP_FOLDER } from "../../services/google-drive";
import { loadDataset, toCsv, toXlsx, DATASET_COLUMNS } from "./export";
import { audit } from "../lib/audit";
import { z } from "zod";
import { jsonBody, shortText, longText, bool } from "../lib/validate";
import type { AppEnv } from "../env";

/* -------------------------------------------------------------------------- */
/*  Request bodies                                                            */
/*                                                                            */
/*  Reproduced live on :4200 before this pass:                                */
/*                                                                            */
/*   - PUT /app-credentials/google_drive { clientId: { a: 1 } } -> 200, and    */
/*     the stored client id was the literal string "[object Object]". That is  */
/*     the OAuth app id every tenant's Google connection is built from, so a   */
/*     fat-fingered paste silently breaks connecting for everyone with no      */
/*     error anywhere — the credential just never works.                      */
/*   - PUT /drive/settings { subfolderByMonth: "yes" } -> 200 reporting the    */
/*     OLD value. The typeof guard skipped the write, so the response looked   */
/*     successful while nothing changed: a toggle that silently doesn't save.  */
/*   - PUT /drive/settings { folderName: 5,000 chars } -> 200 (truncated to    */
/*     80 with no complaint) and { folderName: {} } -> 200, silently ignored.  */
/*   - POST /:id/disconnect <bogus id> -> 200 {} — reports a disconnect that   */
/*     never happened, on a row that may belong to another tenant. Compare     */
/*     /:id/sync, which correctly 404s.                                       */
/* -------------------------------------------------------------------------- */

const AppCredentialsBody = z.object({
  // Real OAuth client ids are long opaque strings, never objects.
  clientId: shortText("Client ID", 400),
  // Blank/absent means "keep the existing secret" — the form shows it masked.
  clientSecret: z.string().trim().max(600, "Client secret is too long").optional(),
  enabled: bool("Enabled").optional(),
});

const DriveExportBody = z.object({
  dataset: shortText("Dataset", 60),
  format: z.enum(["csv", "xlsx"], { error: "Format must be csv or xlsx" }).optional(),
});

const DriveSettingsBody = z
  .object({
    // Length-capped but NOT min(1): the real UI submits this field on every
    // save, and clearing it legitimately means "use the default folder name".
    // A min-length rule here would break the Drive settings dialog.
    folderName: longText(80),
    subfolderByDataset: bool("Dataset subfolders"),
    subfolderByMonth: bool("Month subfolders"),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { error: "Nothing to update" });

// short-lived state store for the OAuth handshake (CSRF + which integration row)
const stateStore = new Map<string, { integrationId: string; provider: ProviderId; exp: number }>();
function putState(integrationId: string, provider: ProviderId): string {
  const s = crypto.randomUUID().replace(/-/g, "");
  stateStore.set(s, { integrationId, provider, exp: Date.now() + 10 * 60_000 });
  return s;
}
function takeState(s: string) {
  const v = stateStore.get(s);
  if (!v) return null;
  stateStore.delete(s);
  if (v.exp < Date.now()) return null;
  return v;
}

function metaFor(provider: string) {
  const cfg = (PROVIDERS as any)[provider];
  return cfg ? { name: cfg.name, category: cfg.category } : { name: provider, category: "Service" };
}

const popupResult = (ok: boolean, msg: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${ok ? "Connected" : "Error"}</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#0b1220;color:#e2e8f0;display:grid;place-items:center;height:100vh;margin:0}
.card{text-align:center;max-width:340px;padding:32px}.ico{font-size:44px}h1{font-size:18px;margin:14px 0 6px}p{color:#94a3b8;font-size:13px;margin:0}</style></head>
<body><div class="card"><div class="ico">${ok ? "✅" : "⚠️"}</div><h1>${ok ? "Connected" : "Couldn’t connect"}</h1><p>${msg}</p></div>
<script>try{window.opener&&window.opener.postMessage({type:"oauth",ok:${ok}},"*")}catch(e){}setTimeout(()=>window.close(),1400)</script></body></html>`;

export const integrationsRoutes = new Hono<AppEnv>()
  .get("/", requireAuth, async (c) => {
    const rows = await tx(c).select(schema.integrations);
    const enriched = await Promise.all(rows.map(async (r) => ({
      id: r.id,
      provider: r.provider,
      status: r.status,
      accountLabel: r.accountLabel,
      lastSyncAt: r.lastSyncAt,
      scope: r.scope,
      // `available` = the platform has registered an OAuth app for this provider.
      // Tenants never see/manage keys — they just click Connect when available.
      available: await hasCredentials(r.provider as ProviderId),
      ...metaFor(r.provider),
    })));
    return c.json({ integrations: enriched }, 200);
  })

  // Owner-only: full credential status (which providers are registered & where keys live).
  .get("/credential-status", requireAuth, async (c) => {
    const u = c.get("user") as any;
    if (!isSuperadmin(u?.role)) return c.json({ message: "Forbidden" }, 403);
    const status = await Promise.all(Object.values(PROVIDERS).map(async (p) => {
      const source = await credentialSource(p.id);
      return {
        provider: p.id, name: p.name, category: p.category,
        envPrefix: p.envPrefix,
        configured: source !== "none",
        source, // "db" | "env" | "none"
        redirectUri: redirectUri(p.id),
      };
    }));
    return c.json({ providers: status }, 200);
  })

  // Owner-only: load stored client ids (secrets masked) so the setup form can prefill.
  .get("/app-credentials", requireAuth, async (c) => {
    const u = c.get("user") as any;
    if (!isSuperadmin(u?.role)) return c.json({ message: "Forbidden" }, 403);
    const rows = await db.select().from(schema.oauthAppCredentials);
    const byProvider: Record<string, any> = {};
    for (const r of rows) {
      byProvider[r.provider] = {
        clientId: r.clientId,
        hasSecret: !!r.clientSecret,
        enabled: r.enabled,
        updatedAt: r.updatedAt,
      };
    }
    return c.json({ credentials: byProvider }, 200);
  })

  // Owner-only: save (upsert) an OAuth app's client id/secret for a provider.
  // Goes live immediately — no server restart needed.
  .put("/app-credentials/:provider", requireAuth, jsonBody(AppCredentialsBody), async (c) => {
    const u = c.get("user") as any;
    if (!isSuperadmin(u?.role)) return c.json({ message: "Forbidden" }, 403);
    const provider = c.req.param("provider") as ProviderId;
    if (!PROVIDERS[provider]) return c.json({ message: "Unsupported provider" }, 400);
    const body = c.req.valid("json");
    const clientId = body.clientId;
    const clientSecretRaw = body.clientSecret;
    const enabled = body.enabled === undefined ? true : body.enabled;

    const existing = await db.select().from(schema.oauthAppCredentials)
      .where(eq(schema.oauthAppCredentials.provider, provider)).then((r) => r[0]);

    // Empty secret on update = keep existing secret (form shows it masked).
    const clientSecret = clientSecretRaw === undefined || clientSecretRaw === ""
      ? (existing?.clientSecret ?? "")
      : clientSecretRaw;

    if (existing) {
      await db.update(schema.oauthAppCredentials).set({
        clientId, clientSecret, enabled, updatedBy: u.id, updatedAt: new Date(),
      }).where(eq(schema.oauthAppCredentials.provider, provider));
    } else {
      await db.insert(schema.oauthAppCredentials).values({
        provider, clientId, clientSecret, enabled, updatedBy: u.id, updatedAt: new Date(),
      });
    }
    invalidateCredentialCache();
    return c.json({ ok: true, provider, source: await credentialSource(provider) }, 200);
  })

  // Owner-only: remove stored credentials for a provider (falls back to env if any).
  .delete("/app-credentials/:provider", requireAuth, async (c) => {
    const u = c.get("user") as any;
    if (!isSuperadmin(u?.role)) return c.json({ message: "Forbidden" }, 403);
    const provider = c.req.param("provider") as ProviderId;
    await db.delete(schema.oauthAppCredentials).where(eq(schema.oauthAppCredentials.provider, provider));
    invalidateCredentialCache();
    return c.json({ ok: true, source: await credentialSource(provider) }, 200);
  })

  // Step 1: begin OAuth — returns the provider authorize URL for a popup.
  .post("/:id/authorize", requireAuth, async (c) => {
    const row = await tx(c).selectOne(schema.integrations, eq(schema.integrations.id, c.req.param("id")));
    if (!row) return c.json({ message: "Not found" }, 404);
    const provider = row.provider as ProviderId;
    if (!PROVIDERS[provider]) return c.json({ message: "Unsupported provider" }, 400);
    if (!(await hasCredentials(provider))) {
      // Not yet enabled by the platform owner — tenant sees a friendly "coming soon".
      return c.json({ message: "not_available", provider }, 412);
    }
    const state = putState(row.id, provider);
    const url = (await buildAuthorizeUrl(provider, state))!;
    return c.json({ authorizeUrl: url }, 200);
  })

  // Step 2: provider redirects back here with ?code&state (browser hits it directly).
  .get("/oauth/callback/:provider", async (c) => {
    const provider = c.req.param("provider") as ProviderId;
    const code = c.req.query("code");
    const state = c.req.query("state");
    const err = c.req.query("error");
    c.header("Content-Type", "text/html; charset=utf-8");
    if (err) return c.body(popupResult(false, `${provider}: ${err}`));
    if (!code || !state) return c.body(popupResult(false, "Missing authorization code."));
    const st = takeState(state);
    if (!st || st.provider !== provider) return c.body(popupResult(false, "Session expired. Try again."));
    try {
      const { tokens, raw } = await exchangeCode(provider, code);
      const cfg = PROVIDERS[provider];
      let label = cfg.name, externalId = "";
      if (cfg.accountInfo) {
        const info = await cfg.accountInfo(tokens, raw);
        label = info.label; externalId = info.externalId;
      }
      await db.update(schema.integrations).set({
        status: "connected",
        accountLabel: label,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt) : null,
        scope: tokens.scope || cfg.scopes.join(" "),
        externalAccountId: externalId,
        lastSyncAt: new Date(),
      }).where(eq(schema.integrations.id, st.integrationId));
      return c.body(popupResult(true, `${cfg.name} linked as ${label}.`));
    } catch (e: any) {
      await db.update(schema.integrations).set({ status: "error" }).where(eq(schema.integrations.id, st.integrationId));
      return c.body(popupResult(false, e?.message === "missing_credentials" ? "App credentials missing." : "Token exchange failed."));
    }
  })

  // ---- Google Drive: export/backup a dataset INTO the connected Drive ----
  // POST /api/integrations/drive/export  body: { dataset, format }
  // dataset ∈ work-orders | technicians | clients | invoices ; format ∈ csv | xlsx
  // Tenant-scoped end to end: the data comes from tx(c) (this company only) and
  // lands in the company's own connected Google Drive ("NVC360 Backups" folder).
  .post("/drive/export", requireAuth, jsonBody(DriveExportBody), async (c) => {
    const t = tx(c);
    const body = c.req.valid("json");
    const dataset = body.dataset;
    const format: "csv" | "xlsx" = body.format ?? "csv";

    if (!DATASET_COLUMNS[dataset])
      return c.json({ message: "Unknown dataset", fields: { dataset: "Unknown dataset" } }, 400);

    // find this tenant's connected Drive integration
    const drive = await t.selectOne(
      schema.integrations,
      eq(schema.integrations.provider, "google_drive"),
    );
    if (!drive || drive.status !== "connected")
      return c.json({ message: "Google Drive is not connected." }, 412);

    // build the file in-memory from the tenant's own data
    const cols = DATASET_COLUMNS[dataset];
    const rows = await loadDataset(dataset, t);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const base = `nvc360-${dataset}-${stamp}`;

    // Resolve the export folder layout from this integration's saved config:
    //   <rootFolder>/<dataset>/<YYYY-MM>/<file>
    // rootFolder is admin-configurable; the dataset + month subfolders keep
    // exports tidy and easy to find. Toggles let admins flatten the layout.
    let cfg: { folderName?: string; subfolderByDataset?: boolean; subfolderByMonth?: boolean } = {};
    try { cfg = JSON.parse(drive.config || "{}"); } catch { cfg = {}; }
    const rootFolder = (cfg.folderName || DEFAULT_BACKUP_FOLDER).trim() || DEFAULT_BACKUP_FOLDER;
    const month = new Date().toISOString().slice(0, 7); // YYYY-MM
    const folderPath = [rootFolder];
    if (cfg.subfolderByDataset !== false) folderPath.push(dataset);
    if (cfg.subfolderByMonth !== false) folderPath.push(month);

    let content: Buffer | string;
    let mimeType: string;
    let name: string;
    if (format === "xlsx") {
      const title = dataset.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
      content = await toXlsx(rows, cols, title, title);
      mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      name = `${base}.xlsx`;
    } else {
      content = toCsv(rows, cols.map((col) => col.key));
      mimeType = "text/csv; charset=utf-8";
      name = `${base}.csv`;
    }

    try {
      const result = await uploadToDrive(drive, { name, mimeType, content, folderPath });
      await t.update(
        schema.integrations,
        { lastSyncAt: new Date() },
        eq(schema.integrations.id, drive.id),
      );
      const me = c.get("user") as { id?: string; name?: string } | null;
      await audit({
        actorId: me?.id,
        actorName: me?.name,
        action: "create",
        entityType: "integration",
        entityId: drive.id,
        summary: `Exported ${rows.length} ${dataset} row(s) to Google Drive (${result.folderPath}/${name})`,
        companyId: t.companyId,
      });
      return c.json(
        {
          ok: true,
          rows: rows.length,
          file: result.name,
          folder: result.folder,
          folderPath: result.folderPath,
          folderLink: result.folderLink,
          link: result.webViewLink,
        },
        200,
      );
    } catch (e: any) {
      const msg = String(e?.message || "drive_upload_failed");
      // These are USER-actionable connection problems, not server failures —
      // return 4xx (never 5xx/502) for two reasons: (1) it's the correct
      // semantic — nothing is wrong with our server, the tenant's Drive
      // connection needs attention; (2) production sits behind Cloudflare,
      // which intercepts 502/504 upstream errors and replaces the body with
      // its own HTML error page, discarding our JSON entirely — that's what
      // produced the "Unexpected token '<', <!DOCTYPE..." error in the UI.
      if (msg === "drive_not_connected" || msg === "drive_reauth_required")
        return c.json({ message: "Google Drive access expired — click Reconnect and re-authorize to keep backups working.", reauthRequired: true }, 409);
      return c.json({ message: msg }, 422);
    }
  })

  // Read the Drive export folder settings for this tenant.
  .get("/drive/settings", requireAuth, async (c) => {
    const drive = await tx(c).selectOne(
      schema.integrations,
      eq(schema.integrations.provider, "google_drive"),
    );
    let cfg: any = {};
    try { cfg = JSON.parse(drive?.config || "{}"); } catch { cfg = {}; }
    return c.json({
      folderName: (cfg.folderName as string) || DEFAULT_BACKUP_FOLDER,
      subfolderByDataset: cfg.subfolderByDataset !== false,
      subfolderByMonth: cfg.subfolderByMonth !== false,
      defaultFolderName: DEFAULT_BACKUP_FOLDER,
    }, 200);
  })

  // Update the Drive export folder settings (folder name + subfolder toggles).
  .put("/drive/settings", requireAuth, jsonBody(DriveSettingsBody), async (c) => {
    const t = tx(c);
    const drive = await t.selectOne(
      schema.integrations,
      eq(schema.integrations.provider, "google_drive"),
    );
    if (!drive) return c.json({ message: "Google Drive is not connected." }, 412);
    const body = c.req.valid("json");
    let cfg: any = {};
    try { cfg = JSON.parse(drive.config || "{}"); } catch { cfg = {}; }

    if (body.folderName !== undefined) {
      // Strip slashes/control chars — this is a single folder name, not a path.
      const clean = body.folderName.replace(/[\\/]+/g, " ").replace(/\s+/g, " ").trim();
      cfg.folderName = clean || DEFAULT_BACKUP_FOLDER;
    }
    if (body.subfolderByDataset !== undefined) cfg.subfolderByDataset = body.subfolderByDataset;
    if (body.subfolderByMonth !== undefined) cfg.subfolderByMonth = body.subfolderByMonth;

    await t.update(schema.integrations, { config: JSON.stringify(cfg) }, eq(schema.integrations.id, drive.id));
    return c.json({
      ok: true,
      folderName: cfg.folderName || DEFAULT_BACKUP_FOLDER,
      subfolderByDataset: cfg.subfolderByDataset !== false,
      subfolderByMonth: cfg.subfolderByMonth !== false,
    }, 200);
  })

  .post("/:id/disconnect", requireAuth, async (c) => {
    // Was returning 200 {} for an id that doesn't exist in this tenant,
    // reporting a disconnect that never happened.
    const found = await tx(c).selectOne(schema.integrations, eq(schema.integrations.id, c.req.param("id")));
    if (!found) return c.json({ message: "Not found" }, 404);
    const [r] = await tx(c).update(schema.integrations, {
      status: "disconnected", accountLabel: "", accessToken: "", refreshToken: "", expiresAt: null, scope: "", externalAccountId: "",
    }, eq(schema.integrations.id, c.req.param("id")));
    return c.json({ integration: r }, 200);
  })

  // Refresh the access token (manual "sync") — proves the connection is live.
  .post("/:id/sync", requireAuth, async (c) => {
    const t9 = tx(c);
    const row = await t9.selectOne(schema.integrations, eq(schema.integrations.id, c.req.param("id")));
    if (!row) return c.json({ message: "Not found" }, 404);
    const provider = row.provider as ProviderId;
    if (row.status !== "connected") return c.json({ message: "Not connected" }, 400);
    try {
      if (row.refreshToken && (await hasCredentials(provider))) {
        const t = await refreshTokens(provider, row.refreshToken);
        await t9.update(schema.integrations, {
          accessToken: t.accessToken,
          refreshToken: t.refreshToken || row.refreshToken,
          expiresAt: t.expiresAt ? new Date(t.expiresAt) : row.expiresAt,
          scope: t.scope || row.scope,
          lastSyncAt: new Date(),
        }, eq(schema.integrations.id, row.id));
      } else {
        await t9.update(schema.integrations, { lastSyncAt: new Date() }, eq(schema.integrations.id, row.id));
      }
      const r = await t9.selectOne(schema.integrations, eq(schema.integrations.id, row.id));
      return c.json({ integration: r, ok: true }, 200);
    } catch (e: any) {
      await t9.update(schema.integrations, { status: "error" }, eq(schema.integrations.id, row.id));
      // 4xx, not 502 — see the drive/export handler above for why: Cloudflare
      // eats 502/504 bodies and replaces them with an HTML error page.
      return c.json({ message: e?.message || "sync_failed" }, 422);
    }
  });
