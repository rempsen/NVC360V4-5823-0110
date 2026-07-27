import { Hono } from "hono";
import { eq } from "drizzle-orm";
import * as schema from "../database/schema";
import { db } from "../database";
import { requireAuth, requireAdmin, tx, tenantId } from "../middleware/auth";
import { audit } from "../lib/audit";

type SessionUser = { id: string; name?: string };

/**
 * Resolve (creating if needed) the company_settings row for the ACTIVE tenant.
 * Tenancy: one row per company, keyed by companyId via the tdb facade — never
 * the legacy id="default" singleton (that leaked one config across all tenants).
 */
async function getOrInit(c: any) {
  const t = tx(c);
  let row = await t.selectOne(schema.companySettings);
  if (!row) {
    [row] = await t.insert(schema.companySettings, {
      id: tenantId(c), // unique per tenant (PK)
    });
  }
  return row;
}

export const settingsRoutes = new Hono()
  .get("/", requireAuth, async (c) => {
    const settings = await getOrInit(c);
    // surface the tenant's Primary Industry (ICP) + free-text "other"
    // description so the UI (Form Builder category dropdown, etc.) can adapt.
    // Stored on companies, not settings.
    let industry = "";
    let industryOther = "";
    try {
      const [co] = await db
        .select({ industry: schema.companies.industry, industryOther: schema.companies.industryOther })
        .from(schema.companies)
        .where(eq(schema.companies.id, tenantId(c)));
      industry = co?.industry ?? "";
      industryOther = co?.industryOther ?? "";
    } catch {
      // best-effort; default to empty
    }
    return c.json({ settings: { ...settings, industry, industryOther } }, 200);
  })
  .put("/", requireAdmin, async (c) => {
    const me = c.get("user") as SessionUser;
    const body = await c.req.json();
    const existing = await getOrInit(c);
    const allowed = [
      "name", "legalName", "email", "phone", "address", "lat", "lng",
      "timezone", "currency", "taxRate", "taxLabel", "logo", "brandColor", "website",
      "defaultRegion", "autoTaxByRegion", "geofenceRadiusM",
    ];
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of allowed) if (k in body) patch[k] = body[k];
    const [updated] = await tx(c).update(
      schema.companySettings,
      patch as any,
      undefined,
    );
    await audit({
      actorId: me?.id, actorName: me?.name, action: "update",
      entityType: "company_settings", entityId: existing.id,
      summary: "Updated company settings",
    });
    return c.json({ settings: updated }, 200);
  });
