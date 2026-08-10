/**
 * SUPERADMIN — B2B tenant provisioning & registry.
 *
 * The `companies` table IS the tenant catalog: each row's `id` (slug) becomes
 * the companyId stamped on every tenant-owned record. These endpoints are
 * guarded by `requireSuperadmin` (the only role allowed cross-tenant access),
 * and use the raw `db` handle because `companies` is GLOBAL — never scoped by
 * the tenant facade.
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { auth } from "../auth";
import { requireSuperadmin, invalidateCompanyCache } from "../middleware/auth";
import { audit } from "../lib/audit";
import {
  issueDefaultTenantKey,
  ensureDefaultTenantKey,
  ensureDefaultPublicKey,
} from "../lib/tenant-keys";
import { scoutBrand } from "../../services/brand-scout";
import { scoutStarterForms } from "../../services/form-scout";
import { scoutStarterTemplates } from "../../services/template-scout";
import { scoutStarterServices } from "../../services/service-scout";
import { provisionNotificationBranding } from "../../services/dispatch";
import { getIndustryPreset } from "../../services/industry-presets";
import { CATALOG_PRESETS } from "../../services/catalog-presets";
import { OPTION_CATALOG_PRESETS } from "../../services/option-catalog-presets";
import {
  resendAvailable,
  createDomainInResend,
  triggerVerify,
  removeDomain,
} from "../../services/email-domains";

import { z } from "zod";
import {
  parseBody, shortText, longText, optText, hexColor, outboundUrl, imageRef, email as emailField, phone,
} from "../lib/validate";

type SessionUser = { id: string; name?: string };

/* -------------------------------------------------------------------------- */
/*  Request bodies                                                            */
/*                                                                            */
/*  Reproduced live on :4200 before this pass (mutations were aimed at the     */
/*  acme-hvac demo tenant and its settings row was snapshotted through         */
/*  drizzle first, then restored):                                            */
/*                                                                            */
/*   - POST /brand-scout { website: "http://127.0.0.1:4200/api/health" }       */
/*     -> 200, and the returned proposal carried primaryColor "#ffffff"        */
/*     scraped from that response. The server fetches whatever URL the caller  */
/*     supplies and echoes parsed content back: a working SSRF with an output  */
/*     channel. { website: "http://169.254.169.254/latest/meta-data/" } (cloud */
/*     instance metadata) was also accepted and attempted.                     */
/*   - PATCH /companies/:id/brand { brand: { logoUrl: "javascript:alert(1)" }} */
/*     -> 200 and STORED. That value is rendered as an <img src> in the tenant */
/*     UI and in outbound notification email headers.                          */
/*   - Same route: primaryColor "chartreuse-ish" stored (breaks the CSS custom */
/*     property and the email theme), email "not-an-email" stored as the        */
/*     tenant's public contact address (guaranteeing bounces on every reply),  */
/*     and a 20,000-character jobNoun stored — that noun is rendered in every  */
/*     label, table header and email subject line in the product.              */
/*   - POST /companies validated nothing beyond "name present": adminPassword  */
/*     had no minimum length, adminEmail was never checked for being an email  */
/*     address, and the slug-collision check ran BEFORE the credential checks, */
/*     so a request with both problems reported only the collision.            */
/* -------------------------------------------------------------------------- */

/** Terminology + footer details the AI scout proposes, all optional. */
const BrandProposal = z
  .object({
    primaryColor: hexColor("Primary colour").nullable(),
    accentColor: hexColor("Accent colour").nullable(),
    // Rendered in an <img src> in-app AND in email headers.
    logoUrl: imageRef("Logo URL").nullable(),
    logoSourceUrl: imageRef("Logo source URL").nullable(),
    workerNoun: shortText("Worker noun", 40).nullable(),
    workerNounPlural: shortText("Worker noun (plural)", 40).nullable(),
    customerNoun: shortText("Customer noun", 40).nullable(),
    customerNounPlural: shortText("Customer noun (plural)", 40).nullable(),
    jobNoun: shortText("Job noun", 40).nullable(),
    jobNounPlural: shortText("Job noun (plural)", 40).nullable(),
    tagline: longText(300).nullable(),
    hours: longText(300).nullable(),
    address: longText(300).nullable(),
    email: emailField("Contact email").nullable(),
    phone: phone.nullable(),
    website: longText(300).nullable(),
    services: z.union([z.string().max(20_000), z.array(z.unknown()).max(200), z.record(z.string(), z.unknown())]).nullable(),
    socials: z.union([z.string().max(5_000), z.record(z.string(), z.unknown())]).nullable(),
  })
  .partial()
  // brand-scout returns explicit nulls for anything it couldn't read off the
  // site, and the admin submits that proposal object as-is. Nulls must be
  // accepted (and are ignored downstream) or the whole onboarding flow 400s.
  .transform((b) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b)) if (v !== null && v !== undefined) out[k] = v;
    return out as typeof b;
  });

const BrandScoutBody = z.object({
  // outboundUrl() blocks javascript:, loopback, link-local (169.254.x) and
  // RFC1918 space — this URL is fetched BY THE SERVER.
  //
  // The preprocess step matters for the real UI: admins type a bare domain
  // ("acme.com") into the Grab Brand Assets box and brand-scout's own
  // normalizeUrl() used to add the scheme. Adding it here first keeps that
  // flow working instead of 400ing on a URL the user considers valid.
  website: z.preprocess(
    (v) => (typeof v === "string" && v.trim() && !/^[a-z][a-z0-9+.-]*:/i.test(v.trim()) ? `https://${v.trim()}` : v),
    outboundUrl("Website"),
  ),
  companyId: optText(120),
  name: optText(200),
});

const BrandPatchBody = z.object({ brand: BrandProposal });

const CompanyCreateBody = z.object({
  name: shortText("Company name", 200),
  slug: optText(80),
  contactEmail: z.union([emailField("Contact email"), z.literal("")]).optional(),
  phone: phone.optional(),
  plan: z.enum(["starter", "pro", "enterprise"], { error: "Unknown plan" }).optional(),
  industry: optText(80),
  industryOther: optText(200),
  // The tenant's own marketing site. Stored and displayed, never fetched by
  // the server from this route — brand-scout is the one that fetches, and it
  // has the stricter outboundUrl() rule.
  website: longText(300).optional(),
  adminName: optText(200),
  adminEmail: emailField("Admin email"),
  // better-auth's own minimum. Enforced here so provisioning fails loudly at
  // the edge instead of half-way through creating a tenant.
  adminPassword: z.string().min(8, "Admin password must be at least 8 characters").max(200),
  managerName: optText(200),
  managerEmail: z.union([emailField("Manager email"), z.literal("")]).optional(),
  managerPassword: z.union([z.string().min(8, "Manager password must be at least 8 characters").max(200), z.literal("")]).optional(),
  brand: BrandProposal.optional(),
});

/**
 * Load curated deep-research knowledge for an ICP (icpKnowledgeBase), if any
 * exists. Returns null for industries not yet researched — callers must
 * degrade gracefully (template-scout/form-scout already do).
 */
async function loadIcpKnowledge(industry: string) {
  if (!industry || industry === "other") return null;
  const [row] = await db
    .select()
    .from(schema.icpKnowledgeBase)
    .where(eq(schema.icpKnowledgeBase.industry, industry));
  if (!row) return null;
  const parseArr = (s: string) => {
    try {
      const a = JSON.parse(s || "[]");
      return Array.isArray(a) ? a : [];
    } catch {
      return [];
    }
  };
  return {
    summary: row.summary || null,
    bestPractices: parseArr(row.bestPractices) as string[],
    workflowNotes: row.workflowNotes || null,
    terminologyNotes: row.terminologyNotes || null,
    toneRefinement: row.toneRefinement || null,
    complianceNotes: row.complianceNotes || null,
  };
}

/** normalize a free-text name into a url-safe slug */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * Seed the CATALOG (schema.catalogItems) for a company from its industry preset.
 * Inserts every non-assembly first, maps each preset `key` → real row id, then
 * inserts assemblies with `components` resolved to [{ itemId, qty }]. Idempotent
 * is the caller's responsibility (only call when the catalog is empty). Returns
 * the number of rows inserted.
 */
async function seedCatalogForCompany(
  companyId: string,
  industryId: string,
): Promise<number> {
  const items = CATALOG_PRESETS[industryId];
  if (!items || items.length === 0) return 0;

  const keyToId: Record<string, string> = {};
  let inserted = 0;

  // Pass 1 — non-assemblies (so their ids exist for component resolution).
  for (const it of items) {
    if (it.kind === "assembly") continue;
    const [row] = await db
      .insert(schema.catalogItems)
      .values({
        companyId,
        kind: it.kind,
        name: it.name,
        sku: it.sku,
        category: it.category,
        description: it.description,
        image: it.image,
        unit: it.unit,
        unitCost: it.unitCost,
        markupPct: it.markupPct,
        priceMode: "auto",
        unitPrice: 0,
        taxable: it.taxable,
        components: "[]",
        active: true,
      })
      .returning({ id: schema.catalogItems.id });
    if (row) {
      keyToId[it.key] = row.id;
      inserted++;
    }
  }

  // Pass 2 — assemblies, resolving component keys to the ids inserted above.
  for (const it of items) {
    if (it.kind !== "assembly") continue;
    const components = (it.components ?? [])
      .map((c) => {
        const itemId = keyToId[c.key];
        return itemId ? { itemId, qty: c.qty } : null;
      })
      .filter((c): c is { itemId: string; qty: number } => c !== null);
    const [row] = await db
      .insert(schema.catalogItems)
      .values({
        companyId,
        kind: "assembly",
        name: it.name,
        sku: it.sku,
        category: it.category,
        description: it.description,
        image: it.image,
        unit: it.unit,
        unitCost: 0,
        markupPct: 0,
        priceMode: "auto",
        unitPrice: 0,
        taxable: it.taxable,
        components: JSON.stringify(components),
        active: true,
      })
      .returning({ id: schema.catalogItems.id });
    if (row) {
      keyToId[it.key] = row.id;
      inserted++;
    }
  }

  return inserted;
}

/**
 * Seed the OPTIONS/TIER CATALOG (schema.optionCategories + optionCategoryItems)
 * for a company from its industry preset — the generalized options/tier quote
 * engine (Phase 3 cross-ICP synthesis #1 build priority: 13 of 17 researched
 * ICPs independently converged on this good/better/best pattern). Without
 * this, a new tenant's /admin/options page is empty until someone builds
 * categories by hand — this makes the wedge feature usable on day one.
 * Idempotent is the caller's responsibility (only call when empty). Returns
 * the number of category rows inserted.
 */
async function seedOptionCatalogForCompany(
  companyId: string,
  industryId: string,
): Promise<number> {
  const categories = OPTION_CATALOG_PRESETS[industryId];
  if (!categories || categories.length === 0) return 0;

  let inserted = 0;
  for (let i = 0; i < categories.length; i++) {
    const cat = categories[i];
    const [catRow] = await db
      .insert(schema.optionCategories)
      .values({
        companyId,
        name: cat.name,
        description: cat.description,
        sortOrder: i,
        active: true,
      })
      .returning({ id: schema.optionCategories.id });
    if (!catRow) continue;
    inserted++;
    for (let j = 0; j < cat.tiers.length; j++) {
      const tier = cat.tiers[j];
      await db.insert(schema.optionCategoryItems).values({
        companyId,
        categoryId: catRow.id,
        tierLabel: tier.tierLabel,
        name: tier.name,
        description: tier.description,
        priceDelta: tier.priceDelta,
        unitCost: 0,
        isDefault: tier.isDefault,
        sortOrder: j,
        active: true,
      });
    }
  }

  return inserted;
}

/**
 * Create (or upgrade) a user with a given role + tenant. Returns the user id.
 * Mirrors the create-superadmin / team provisioning pattern: sign up via
 * better-auth (which may default the role), then stamp role + companyId.
 */
async function ensureUser(opts: {
  name: string;
  email: string;
  password: string;
  role: string;
  companyId: string;
}): Promise<{ id: string; reused: boolean }> {
  const [existing] = await db
    .select()
    .from(schema.user)
    .where(eq(schema.user.email, opts.email));
  if (existing) {
    await db
      .update(schema.user)
      .set({ role: opts.role, companyId: opts.companyId, name: opts.name })
      .where(eq(schema.user.id, existing.id));
    return { id: existing.id, reused: true };
  }
  await auth.api.signUpEmail({
    body: {
      name: opts.name,
      email: opts.email,
      password: opts.password,
      role: opts.role,
    } as any,
  });
  const [u] = await db
    .select()
    .from(schema.user)
    .where(eq(schema.user.email, opts.email));
  if (!u) throw new Error(`could not find user after signup: ${opts.email}`);
  await db
    .update(schema.user)
    .set({ role: opts.role, companyId: opts.companyId })
    .where(eq(schema.user.id, u.id));
  return { id: u.id, reused: false };
}

export const superadminRoutes = new Hono()
  // ---- list all tenants -------------------------------------------------
  .get("/companies", requireSuperadmin, async (c) => {
    const rows = await db.select().from(schema.companies);
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ companies: rows }, 200);
  })

  // ---- single tenant ----------------------------------------------------
  .get("/companies/:id", requireSuperadmin, async (c) => {
    const [row] = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, c.req.param("id")));
    if (!row) return c.json({ message: "Not found" }, 404);
    return c.json({ company: row }, 200);
  })

  // ---- AI brand scout: scrape a website -> structured brand proposal ----
  // No DB writes. The admin reviews/edits the result, then submits it as the
  // `brand` payload on POST /companies (or PATCH for an existing tenant).
  .post("/brand-scout", requireSuperadmin, async (c) => {
    const b = await parseBody(c, BrandScoutBody);
    const website = b.website;
    // companyId only used to namespace the hosted logo object; may not exist
    // as a tenant yet (we're onboarding). Fall back to a derived slug.
    const companyId = slugify(String(b.companyId ?? b.name ?? "") || website);
    try {
      const proposal = await scoutBrand(website, companyId || "pending");
      return c.json({ proposal }, 200);
    } catch (e: any) {
      return c.json(
        { message: `Brand scout failed: ${e?.message ?? "unknown error"}` },
        502,
      );
    }
  })

  // ---- apply a reviewed brand proposal to an EXISTING tenant ------------
  .patch("/companies/:id/brand", requireSuperadmin, async (c) => {
    const me = c.get("user") as SessionUser;
    const id = c.req.param("id");
    const [co] = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, id));
    if (!co) return c.json({ message: "Not found" }, 404);
    const brand = (await parseBody(c, BrandPatchBody)).brand as Record<string, any>;
    const set: Record<string, any> = { updatedAt: new Date() };
    const map: [string, string][] = [
      ["primaryColor", "brandColor"],
      ["accentColor", "accentColor"],
      ["logoUrl", "logo"],
      ["workerNoun", "workerNoun"],
      ["workerNounPlural", "workerNounPlural"],
      ["customerNoun", "customerNoun"],
      ["customerNounPlural", "customerNounPlural"],
      ["jobNoun", "jobNoun"],
      ["jobNounPlural", "jobNounPlural"],
      ["tagline", "tagline"],
      ["hours", "hours"],
      ["address", "address"],
      ["email", "email"],
      ["phone", "phone"],
      ["website", "website"],
    ];
    for (const [src, col] of map) {
      const v = brand[src];
      if (typeof v === "string" && v.trim()) set[col] = v.trim();
    }
    if (brand.services != null)
      set.services =
        typeof brand.services === "string"
          ? brand.services
          : JSON.stringify(brand.services);
    if (brand.socials != null)
      set.socials =
        typeof brand.socials === "string"
          ? brand.socials
          : JSON.stringify(brand.socials);

    await db
      .update(schema.companySettings)
      .set(set)
      .where(eq(schema.companySettings.companyId, id));
    await audit({
      actorId: me?.id,
      actorName: me?.name,
      action: "update",
      entityType: "company",
      entityId: id,
      summary: `Applied AI brand assets to "${co.name}"`,
      companyId: id,
    });
    const [row] = await db
      .select()
      .from(schema.companySettings)
      .where(eq(schema.companySettings.companyId, id));
    // re-sync the branded email/SMS identity from the freshly-applied brand
    if (row)
      await provisionNotificationBranding({
        companyId: id,
        name: row.name || co.name,
        logoUrl: row.logo,
        brandColor: row.brandColor,
        legalName: row.legalName || row.name || co.name,
        address: row.address,
        phone: row.phone,
        email: row.email,
        website: row.website,
      }).catch((e) =>
        console.error("[superadmin] brand re-provisioning failed", e),
      );
    return c.json({ settings: row }, 200);
  })

  // ---- provision a new tenant + its admin & manager users ---------------
  .post("/companies", requireSuperadmin, async (c) => {
    const me = c.get("user") as SessionUser;
    // Every field is validated up front, so a request with a bad admin email
    // AND a colliding slug now reports both problems instead of only the slug.
    const b = await parseBody(c, CompanyCreateBody);

    const name = b.name;

    // slug = tenant id, stamped everywhere. derive from name unless supplied.
    const slug = slugify(String(b.slug ?? "") || name);
    if (!slug) return c.json({ message: "Could not derive a valid slug" }, 400);

    // reject collision with an existing tenant
    const [dupe] = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, slug));
    if (dupe)
      return c.json(
        { message: `A company with slug "${slug}" already exists` },
        409,
      );

    const adminEmail = String(b.adminEmail ?? "").trim().toLowerCase();
    const adminPassword = String(b.adminPassword ?? "");
    const adminName = String(b.adminName ?? "").trim() || `${name} Admin`;
    if (!adminEmail || !adminPassword)
      return c.json(
        { message: "Admin email and password are required" },
        400,
      );

    const managerEmail = String(b.managerEmail ?? "").trim().toLowerCase();
    const managerPassword = String(b.managerPassword ?? "");
    const managerName = String(b.managerName ?? "").trim() || `${name} Manager`;
    const wantManager = Boolean(managerEmail && managerPassword);

    // guard: emails not already in use
    for (const email of [adminEmail, ...(wantManager ? [managerEmail] : [])]) {
      const [u] = await db
        .select()
        .from(schema.user)
        .where(eq(schema.user.email, email));
      if (u)
        return c.json({ message: `Email already in use: ${email}` }, 409);
    }

    // Primary Industry (ICP) — drives templates + service library presets.
    // "other" is a valid sentinel (no preset fits) paired with a free-text
    // description in industryOther, so future/unknown client types aren't
    // forced into an ill-fitting bucket.
    const industryRaw = String(b.industry ?? "").trim();
    const preset = getIndustryPreset(industryRaw);
    const industryOther = String(b.industryOther ?? "").trim();
    const resolvedIndustry = preset?.id ?? (industryRaw === "other" ? "other" : "");
    // Deep per-ICP research (trade publications, standards bodies) — only a
    // handful of pilot industries have this curated yet; null is expected
    // and handled gracefully for the rest.
    const icpKnowledge = await loadIcpKnowledge(resolvedIndustry).catch(() => null);

    // 1) insert the tenant row (id = slug = companyId)
    await db.insert(schema.companies).values({
      id: slug,
      name,
      contactEmail: String(b.contactEmail ?? "").trim(),
      phone: String(b.phone ?? "").trim(),
      plan: b.plan ?? "starter",
      industry: resolvedIndustry,
      industryOther: resolvedIndustry === "other" ? industryOther : "",
      status: "active",
      createdBy: me?.id ?? "",
    });

    // 2) seed the tenant's company_settings row (PK = slug to avoid collision).
    //    Fold in any reviewed AI brand data ("Grab Brand Assets") so the tenant
    //    starts fully branded — colors, logo, terminology, footer details.
    //    Terminology fallback chain: what the AI actually read off their site
    //    first, then the ICP preset's fitting default (e.g. "Plumber" not a
    //    generic "Technician"), then a neutral platform default last.
    const brand = (b.brand ?? {}) as Record<string, any>;
    const str = (v: any, fb = "") =>
      typeof v === "string" && v.trim() ? v.trim() : fb;
    const jsonStr = (v: any) => {
      if (v == null) return "";
      try {
        return typeof v === "string" ? v : JSON.stringify(v);
      } catch {
        return "";
      }
    };
    await db.insert(schema.companySettings).values({
      id: slug,
      companyId: slug,
      name,
      email: str(brand.email, String(b.contactEmail ?? "").trim()),
      phone: str(brand.phone, String(b.phone ?? "").trim()),
      website: str(b.website),
      address: str(brand.address, undefined as any) || undefined,
      logo: str(brand.logoUrl),
      brandColor: str(brand.primaryColor, "#06B6D4"),
      accentColor: str(brand.accentColor),
      workerNoun: str(brand.workerNoun, preset?.workerNoun ?? "Technician"),
      workerNounPlural: str(brand.workerNounPlural, preset?.workerNounPlural ?? "Technicians"),
      customerNoun: str(brand.customerNoun, preset?.customerNoun ?? "Customer"),
      customerNounPlural: str(brand.customerNounPlural, preset?.customerNounPlural ?? "Customers"),
      jobNoun: str(brand.jobNoun, preset?.jobNoun ?? "Job"),
      jobNounPlural: str(brand.jobNounPlural, preset?.jobNounPlural ?? "Jobs"),
      tagline: str(brand.tagline),
      services: jsonStr(brand.services),
      hours: str(brand.hours),
      socials: jsonStr(brand.socials),
    });

    // 2b) auto-provision branded notifications/email/SMS identity so every
    //     message this tenant sends carries their logo, color & contact footer.
    await provisionNotificationBranding({
      companyId: slug,
      name,
      logoUrl: str(brand.logoUrl),
      brandColor: str(brand.primaryColor, "#06B6D4"),
      legalName: name,
      address: str(brand.address),
      phone: str(brand.phone, String(b.phone ?? "").trim()),
      email: str(brand.email, String(b.contactEmail ?? "").trim()),
      website: str(b.website),
    }).catch((e) => console.error("[superadmin] brand provisioning failed", e));

    // 2c) auto-seed 2-3 industry-appropriate starter intake forms based on the
    //     company's services/website so the tenant's Form Creator isn't empty.
    //     AI-generated; falls back to generic forms on any failure. Best-effort
    //     and non-blocking — provisioning must still succeed if this fails.
    try {
      const servicesArr: string[] = Array.isArray(brand.services)
        ? brand.services
        : typeof brand.services === "string" && brand.services.trim()
          ? brand.services
              .split(/[\n,;|]/)
              .map((s: string) => s.trim())
              .filter(Boolean)
          : [];
      const starters = await scoutStarterForms({
        name,
        industry: resolvedIndustry || null,
        industryOther: resolvedIndustry === "other" ? industryOther : null,
        services: servicesArr,
        description: str(brand.description) || str(brand.tagline) || null,
        website: str(b.website) || null,
        workerNoun: str(brand.workerNoun, preset?.workerNoun ?? "Technician"),
        customerNoun: str(brand.customerNoun, preset?.customerNoun ?? "Customer"),
        knowledge: icpKnowledge,
      });
      const brandColor = str(brand.primaryColor, "#06B6D4");
      const logoUrl = str(brand.logoUrl);
      // auto-issue + bind a public (form-submit) key so the seeded forms are
      // immediately publishable — no manual "bind a key" step needed.
      let publicKeyId = "";
      try {
        const pub = await ensureDefaultPublicKey({
          companyId: slug,
          createdBy: me?.id,
          createdByName: me?.name,
        });
        publicKeyId = pub.id;
      } catch (e) {
        console.error("[superadmin] public key provisioning failed", e);
      }
      const usedSlugs = new Set<string>();
      for (const f of starters) {
        let s = f.slug;
        let i = 2;
        while (usedSlugs.has(s)) s = `${f.slug}-${i++}`;
        usedSlugs.add(s);
        await db.insert(schema.intakeForms).values({
          companyId: slug,
          slug: s,
          title: f.title,
          intro: f.intro,
          fields: JSON.stringify(f.fields),
          publicKeyId,
          brandColor,
          logoUrl,
          successMessage: f.successMessage,
          active: true,
          createdBy: me?.id ?? "",
          updatedAt: new Date(),
        });
      }
      console.log(
        `[superadmin] seeded ${starters.length} starter forms for "${slug}"`,
      );
    } catch (e) {
      console.error("[superadmin] starter-form seeding failed", e);
    }

    // 2d) auto-seed 2-3 industry-appropriate WORK-ORDER templates (the Form
    //     Builder / task_templates) so the tenant's builder isn't empty —
    //     residential / commercial / service workflows tailored to their trade.
    //     AI-generated, best-effort, non-blocking; falls back to generics.
    try {
      const servicesArr: string[] = Array.isArray(brand.services)
        ? brand.services
        : typeof brand.services === "string" && brand.services.trim()
          ? brand.services
              .split(/[\n,;|]/)
              .map((s: string) => s.trim())
              .filter(Boolean)
          : [];
      const tpls = await scoutStarterTemplates({
        name,
        industry: resolvedIndustry || null,
        industryOther: resolvedIndustry === "other" ? industryOther : null,
        services: servicesArr,
        description: str(brand.description) || str(brand.tagline) || null,
        website: str(b.website) || null,
        workerNoun: str(brand.workerNoun, preset?.workerNoun ?? "Technician"),
        customerNoun: str(brand.customerNoun, preset?.customerNoun ?? "Customer"),
        brandColor: str(brand.primaryColor, "#06B6D4"),
        knowledge: icpKnowledge,
      });
      for (const t of tpls) {
        await db.insert(schema.taskTemplates).values({
          companyId: slug,
          name: t.name,
          category: t.category,
          icon: t.icon,
          color: t.color,
          description: t.description,
          fields: JSON.stringify(t.fields),
          checklist: JSON.stringify(t.checklist),
          estimatedMins: t.estimatedMins,
          rateModel: JSON.stringify(t.rateModel),
          active: true,
        });
      }
      console.log(
        `[superadmin] seeded ${tpls.length} work-order templates for "${slug}"`,
      );
    } catch (e) {
      console.error("[superadmin] starter-template seeding failed", e);
    }

    // 2e) auto-seed the SERVICE LIBRARY (schema.services), tailored to the
    //     tenant's OWN scraped website services where available (falls back
    //     to the plain ICP preset list when there's no scrape data or the
    //     model call fails) — previously this always used the generic preset
    //     verbatim even when the scrape had real service names for this
    //     specific business. Best-effort, non-blocking.
    if (preset || (Array.isArray(brand.services) && brand.services.length)) {
      try {
        const servicesArr: string[] = Array.isArray(brand.services)
          ? brand.services
          : typeof brand.services === "string" && brand.services.trim()
            ? brand.services
                .split(/[\n,;|]/)
                .map((s: string) => s.trim())
                .filter(Boolean)
            : [];
        const tailored = await scoutStarterServices({
          name,
          industry: resolvedIndustry || null,
          industryOther: resolvedIndustry === "other" ? industryOther : null,
          services: servicesArr,
          description: str(brand.description) || str(brand.tagline) || null,
          website: str(b.website) || null,
          knowledge: icpKnowledge,
        });
        for (const s of tailored) {
          await db.insert(schema.services).values({
            companyId: slug,
            name: s.name,
            category: s.category,
            durationMins: s.durationMins,
            active: true,
          });
        }
        console.log(
          `[superadmin] seeded ${tailored.length} services (${preset?.id ?? "scraped, no preset"}) for "${slug}"`,
        );
      } catch (e) {
        console.error("[superadmin] service-library seeding failed", e);
      }
    }

    // 2f) auto-seed the CATALOG (schema.catalogItems) from the industry preset so
    //     the tenant opens the Catalog with ≥12 priced products/services/assemblies.
    //     Non-assemblies are inserted first so assembly components can be resolved
    //     to real row ids. Best-effort, non-blocking.
    if (preset?.id) {
      try {
        const n = await seedCatalogForCompany(slug, preset.id);
        if (n > 0) {
          console.log(
            `[superadmin] seeded ${n} catalog items (${preset.id}) for "${slug}"`,
          );
        }
      } catch (e) {
        console.error("[superadmin] catalog seeding failed", e);
      }
    }

    // 2g) auto-seed the OPTIONS/TIER CATALOG (schema.optionCategories) from the
    //     industry preset — the generalized options/tier quote engine wedge.
    //     Best-effort, non-blocking.
    if (preset?.id) {
      try {
        const n = await seedOptionCatalogForCompany(slug, preset.id);
        if (n > 0) {
          console.log(
            `[superadmin] seeded ${n} option categories (${preset.id}) for "${slug}"`,
          );
        }
      } catch (e) {
        console.error("[superadmin] option-catalog seeding failed", e);
      }
    }

    // 3) provision the admin + (optional) manager accounts
    const admin = await ensureUser({
      name: adminName,
      email: adminEmail,
      password: adminPassword,
      role: "admin",
      companyId: slug,
    });
    let manager: { id: string } | null = null;
    if (wantManager) {
      manager = await ensureUser({
        name: managerName,
        email: managerEmail,
        password: managerPassword,
        role: "manager",
        companyId: slug,
      });
    }

    // 4) auto-issue this tenant's unique, full-scope secret API key. Locked to
    //    this companyId — every read/write through it can only ever touch this
    //    one tenant. Raw key shown ONCE below (never recoverable afterward).
    const tenantKey = await issueDefaultTenantKey({
      companyId: slug,
      createdBy: me?.id,
      createdByName: me?.name,
    });

    // role->permission catalog is global; nothing to seed per-tenant.
    // refresh the allow-list cache so the new tenant is switchable now.
    invalidateCompanyCache();

    await audit({
      actorId: me?.id,
      actorName: me?.name,
      action: "create",
      entityType: "company",
      entityId: slug,
      summary: `Provisioned tenant "${name}" (admin ${adminEmail}${
        wantManager ? `, manager ${managerEmail}` : ""
      })`,
      companyId: slug,
    });

    const [row] = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, slug));
    return c.json(
      {
        company: row,
        admin: { id: admin.id, email: adminEmail },
        manager: manager ? { id: manager.id, email: managerEmail } : null,
        // raw API key — returned ONCE, store it now (it cannot be recovered).
        apiKey: { prefix: tenantKey.prefix, secret: tenantKey.raw },
      },
      201,
    );
  })

  // ---- backfill: ensure EVERY existing tenant has a unique secret key ----
  // Idempotent. Companies that already have an active secret key are skipped
  // (their key is unrecoverable, so no raw value is returned for those).
  .post("/companies/backfill-keys", requireSuperadmin, async (c) => {
    const me = c.get("user") as SessionUser;
    const companies = await db.select().from(schema.companies);
    const results: {
      companyId: string;
      created: boolean;
      prefix: string;
      secret?: string;
    }[] = [];
    for (const company of companies) {
      const r = await ensureDefaultTenantKey({
        companyId: company.id,
        createdBy: me?.id,
        createdByName: me?.name,
      });
      results.push({
        companyId: r.companyId,
        created: r.created,
        prefix: r.prefix,
        secret: r.raw,
      });
    }
    const createdCount = results.filter((r) => r.created).length;
    await audit({
      actorId: me?.id,
      actorName: me?.name,
      action: "create",
      entityType: "api_key",
      entityId: "backfill",
      summary: `Backfilled tenant API keys: ${createdCount} created, ${
        results.length - createdCount
      } already present`,
    });
    return c.json(
      {
        total: results.length,
        created: createdCount,
        // raw secrets ONLY for the ones we just created — save them now.
        results,
      },
      200,
    );
  })

  // ---- email sending domains (cross-tenant approval queue) ----
  // All submitted domains across every tenant, newest first.
  .get("/email-domains", requireSuperadmin, async (c) => {
    const rows = await db.select().from(schema.tenantEmailDomains);
    const companies = await db.select().from(schema.companies);
    const nameById = new Map(companies.map((co) => [co.id, co.name]));
    const domains = rows
      .map((r) => ({
        ...r,
        companyName: nameById.get(r.companyId) || r.companyId,
        records: safeParse(r.records),
      }))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return c.json({ domains, resendAvailable: resendAvailable() }, 200);
  })

  // Approve: create the domain in Resend, store id + DNS records.
  .post("/email-domains/:id/approve", requireSuperadmin, async (c) => {
    const me = c.get("user") as SessionUser;
    const id = c.req.param("id");
    const [row] = await db
      .select()
      .from(schema.tenantEmailDomains)
      .where(eq(schema.tenantEmailDomains.id, id))
      .limit(1);
    if (!row) return c.json({ message: "not found" }, 404);
    if (!resendAvailable())
      return c.json({ message: "RESEND_API_KEY not configured" }, 503);
    try {
      const updated = await createDomainInResend(id);
      await audit({
        actorId: me?.id,
        actorName: me?.name,
        action: "create",
        entityType: "email_domain",
        entityId: id,
        summary: `Approved email domain ${row.domain} for ${row.companyId}`,
      });
      return c.json({ domain: { ...updated, records: safeParse(updated.records) } }, 200);
    } catch (e: any) {
      return c.json({ message: e?.message || "approve failed" }, 502);
    }
  })

  // Force a verify re-check from the superadmin console.
  .post("/email-domains/:id/verify", requireSuperadmin, async (c) => {
    const id = c.req.param("id");
    const [row] = await db
      .select()
      .from(schema.tenantEmailDomains)
      .where(eq(schema.tenantEmailDomains.id, id))
      .limit(1);
    if (!row) return c.json({ message: "not found" }, 404);
    if (!row.resendDomainId)
      return c.json({ message: "Not approved yet" }, 409);
    const updated = await triggerVerify(id);
    return c.json({ domain: { ...updated, records: safeParse(updated.records) } }, 200);
  })

  // Reject / remove a domain (also deletes it in Resend).
  .delete("/email-domains/:id", requireSuperadmin, async (c) => {
    const me = c.get("user") as SessionUser;
    const id = c.req.param("id");
    const [row] = await db
      .select()
      .from(schema.tenantEmailDomains)
      .where(eq(schema.tenantEmailDomains.id, id))
      .limit(1);
    if (!row) return c.json({ message: "not found" }, 404);
    await removeDomain(id);
    await audit({
      actorId: me?.id,
      actorName: me?.name,
      action: "delete",
      entityType: "email_domain",
      entityId: id,
      summary: `Removed email domain ${row.domain} for ${row.companyId}`,
    });
    return c.json({ ok: true }, 200);
  });

function safeParse(s: string | null | undefined) {
  try {
    return JSON.parse(s || "[]");
  } catch {
    return [];
  }
}
