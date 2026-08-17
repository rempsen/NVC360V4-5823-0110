import { Hono } from "hono";
import * as schema from "../database/schema";
import { eq } from "drizzle-orm";
import { requireAdmin, tx } from "../middleware/auth";
import { audit } from "../lib/audit";
import { putObject } from "../lib/storage";
import type { AppEnv } from "../env";

type SessionUser = { id: string; name?: string };

export type IntakeFieldType =
  | "text"
  | "textarea"
  | "email"
  | "phone"
  | "number"
  | "select"
  | "radio"
  | "checkbox"
  | "date"
  | "address"
  | "file";

/**
 * Default field catalog for a new intake form. These map to the core lead
 * fields the pipeline understands (name/email/phone/address/...). Tenants can
 * add any number of custom fields on top of these.
 */
export const INTAKE_FIELD_CATALOG = [
  { key: "name", label: "Full name", type: "text", enabled: true, required: true, fixed: true },
  { key: "email", label: "Email", type: "email", enabled: true, required: true },
  { key: "phone", label: "Phone", type: "phone", enabled: true, required: true },
  { key: "address", label: "Service address", type: "address", enabled: true, required: true },
  { key: "serviceType", label: "Service type", type: "select", enabled: true, required: false },
  { key: "preferredAt", label: "Preferred date", type: "date", enabled: true, required: false },
  { key: "notes", label: "Notes / describe the problem", type: "textarea", enabled: true, required: false },
  { key: "photo", label: "Photo upload", type: "file", enabled: true, required: false },
] as const;

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "intake";

/** Random 6-digit shared PIN for work-order forms — easy for staff to type on a phone. */
const genAccessCode = () => String(Math.floor(100000 + Math.random() * 900000));

/**
 * Normalize stored fields to the rich shape. Backward-compatible with the old
 * [{key,label,enabled,required}] format — fills in id/type/width.
 */
// Canonical type lookup for core keys — used as fallback for legacy rows that
// were saved without a type field (migration also backfills these, but this
// layer means a stale read can never break the rendered form).
const CORE_KEY_TYPES: Record<string, IntakeFieldType> = {
  name: "text", email: "email", phone: "phone", address: "address",
  serviceType: "select", preferredAt: "date", notes: "textarea", photo: "file",
};

function normalizeFields(raw: any): any[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((f: any, i: number) => {
    const fixedDef = INTAKE_FIELD_CATALOG.find((d) => d.key === f.key);
    return {
      id: f.id || (f.key ? `f_${f.key}` : `f_${i}_${Math.random().toString(36).slice(2, 7)}`),
      key: f.key || `custom_${i}`,
      type: (f.type || CORE_KEY_TYPES[f.key] || fixedDef?.type || "text") as IntakeFieldType,
      label: f.label ?? fixedDef?.label ?? "Field",
      placeholder: f.placeholder ?? "",
      options: Array.isArray(f.options) ? f.options : [],
      enabled: f.enabled !== false,
      required: !!f.required,
      sectionId: f.sectionId || "",
      width: f.width === "half" ? "half" : "full",
      fixed: (!!fixedDef && "fixed" in fixedDef && !!fixedDef.fixed) || !!f.fixed,
      core: !!fixedDef, // maps to a built-in pipeline field
    };
  });
}

function normalizeSections(raw: any): any[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((s: any, i: number) => ({
    id: s.id || `s_${i}_${Math.random().toString(36).slice(2, 7)}`,
    title: s.title ?? "Section",
    description: s.description ?? "",
  }));
}

function mask(row: typeof schema.intakeForms.$inferSelect) {
  return {
    id: row.id,
    companyId: row.companyId,
    slug: row.slug,
    title: row.title,
    intro: row.intro,
    fields: normalizeFields(JSON.parse(row.fields || "[]")),
    sections: normalizeSections(JSON.parse(row.sections || "[]")),
    recipientName: row.recipientName,
    recipientEmail: row.recipientEmail,
    publicKeyId: row.publicKeyId,
    brandColor: row.brandColor,
    logoUrl: row.logoUrl,
    successMessage: row.successMessage,
    defaultServiceId: row.defaultServiceId,
    active: row.active,
    submitCount: row.submitCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    formType: row.formType || "lead",
    accessCode: row.accessCode || "",
    allowTechAssign: row.allowTechAssign,
  };
}

export const formsRoutes = new Hono<AppEnv>()
  // field catalog for the builder UI
  .get("/field-catalog", requireAdmin, (c) => c.json({ fields: INTAKE_FIELD_CATALOG }, 200))

  // upload an intake-form header logo (multipart: file) — hosted on our storage,
  // so it always renders on the public form/emails (unlike e.g. a pasted Google
  // Drive share link, which requires auth and never resolves as a raw image).
  .post("/logo", requireAdmin, async (c) => {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ message: "No file" }, 400);
    if (file.size > 4 * 1024 * 1024) return c.json({ message: "Logo too large (max 4MB)" }, 400);
    if (file.type && !["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"].includes(file.type))
      return c.json({ message: `Unsupported type ${file.type}` }, 400);
    const ext = (file.name.split(".").pop() || "png").toLowerCase().slice(0, 8);
    const key = `intake-form-logos/${crypto.randomUUID()}.${ext}`;
    const stored = await putObject(key, Buffer.from(await file.arrayBuffer()), file.type || "image/png");
    return c.json({ url: stored.url }, 200);
  })

  // list forms for the acting tenant
  .get("/", requireAdmin, async (c) => {
    const rows = await tx(c).select(schema.intakeForms);
    rows.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    const base =
      process.env.APP_URL?.replace(/\/$/, "") || new URL(c.req.url).origin.replace(/\/$/, "");
    return c.json({ forms: rows.map(mask), publicBase: base }, 200);
  })

  // create — any tenant admin can create their own form
  .post("/", requireAdmin, async (c) => {
    const me = c.get("user") as SessionUser;
    const b = await c.req.json().catch(() => ({}));
    const title = (b.title || "Request Service").toString().trim();
    let slug = slugify(b.slug || title);

    // ensure slug unique within tenant
    const existing = await tx(c).select(schema.intakeForms);
    const taken = new Set(existing.map((f) => f.slug));
    if (taken.has(slug)) {
      let i = 2;
      while (taken.has(`${slug}-${i}`)) i++;
      slug = `${slug}-${i}`;
    }

    const formType = b.formType === "work_order" ? "work_order" : "lead";
    const fields = Array.isArray(b.fields) && b.fields.length
      ? normalizeFields(b.fields)
      : (formType === "work_order" ? [] : INTAKE_FIELD_CATALOG.map((f) => ({ ...f })));
    const sections = normalizeSections(b.sections);

    const [row] = await tx(c).insert(schema.intakeForms, {
      slug,
      title: title || (formType === "work_order" ? "Create Work Order" : title),
      intro: (b.intro || "").toString(),
      fields: JSON.stringify(fields),
      sections: JSON.stringify(sections),
      recipientName: (b.recipientName || "").toString(),
      recipientEmail: (b.recipientEmail || "").toString().trim().toLowerCase(),
      publicKeyId: (b.publicKeyId || "").toString(),
      brandColor: (b.brandColor || "#06b6d4").toString(),
      logoUrl: (b.logoUrl || "").toString(),
      successMessage: (b.successMessage || "Thanks! We've received your request and will reach out shortly.").toString(),
      defaultServiceId: (b.defaultServiceId || "").toString(),
      active: b.active === false ? false : true,
      createdBy: me?.id ?? "",
      formType,
      accessCode: formType === "work_order" ? (b.accessCode ? String(b.accessCode) : genAccessCode()) : "",
      allowTechAssign: b.allowTechAssign === false ? false : true,
      updatedAt: new Date(),
    });
    await audit({
      actorId: me?.id, actorName: me?.name, action: "create",
      entityType: "intake_form", entityId: row.id, summary: `Created intake form "${title}"`,
    });
    return c.json({ form: mask(row) }, 201);
  })

  // update — any tenant admin
  .patch("/:id", requireAdmin, async (c) => {
    const me = c.get("user") as SessionUser;
    const id = c.req.param("id");
    const b = await c.req.json().catch(() => ({}));
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (b.title != null) patch.title = String(b.title);
    if (b.intro != null) patch.intro = String(b.intro);
    if (b.fields != null) patch.fields = JSON.stringify(normalizeFields(b.fields));
    if (b.sections != null) patch.sections = JSON.stringify(normalizeSections(b.sections));
    if (b.recipientName != null) patch.recipientName = String(b.recipientName);
    if (b.recipientEmail != null) patch.recipientEmail = String(b.recipientEmail).trim().toLowerCase();
    if (b.publicKeyId != null) patch.publicKeyId = String(b.publicKeyId);
    if (b.brandColor != null) patch.brandColor = String(b.brandColor);
    if (b.logoUrl != null) patch.logoUrl = String(b.logoUrl);
    if (b.successMessage != null) patch.successMessage = String(b.successMessage);
    if (b.defaultServiceId != null) patch.defaultServiceId = String(b.defaultServiceId);
    if (b.active != null) patch.active = !!b.active;
    if (b.slug != null) patch.slug = slugify(String(b.slug));
    if (b.formType != null) patch.formType = b.formType === "work_order" ? "work_order" : "lead";
    if (b.accessCode != null) patch.accessCode = String(b.accessCode);
    if (b.allowTechAssign != null) patch.allowTechAssign = !!b.allowTechAssign;
    if (b.regenerateAccessCode) patch.accessCode = genAccessCode();

    const [row] = await tx(c).update(schema.intakeForms, patch, eq(schema.intakeForms.id, id));
    if (!row) return c.json({ message: "not found" }, 404);
    await audit({
      actorId: me?.id, actorName: me?.name, action: "update",
      entityType: "intake_form", entityId: id, summary: `Updated intake form "${row.title}"`,
    });
    return c.json({ form: mask(row) }, 200);
  })

  // submissions for a form (admin readable)
  .get("/:id/submissions", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const rows = await tx(c).select(
      schema.intakeSubmissions,
      eq(schema.intakeSubmissions.formId, id),
    );
    rows.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    return c.json({
      submissions: rows.slice(0, 200).map((r) => ({
        id: r.id, bookingId: r.bookingId, payload: JSON.parse(r.payload || "{}"),
        origin: r.origin, createdAt: r.createdAt,
      })),
    }, 200);
  })

  // delete — any tenant admin
  .delete("/:id", requireAdmin, async (c) => {
    const me = c.get("user") as SessionUser;
    const id = c.req.param("id");
    await tx(c).delete(schema.intakeForms, eq(schema.intakeForms.id, id));
    await audit({
      actorId: me?.id, actorName: me?.name, action: "delete",
      entityType: "intake_form", entityId: id, summary: "Deleted intake form",
    });
    return c.json({ ok: true }, 200);
  });
