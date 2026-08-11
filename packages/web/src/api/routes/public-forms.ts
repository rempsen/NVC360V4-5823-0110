import { Hono } from "hono";
import { db } from "../database";
import { tdb } from "../database/tenant";
import * as schema from "../database/schema";
import { and, eq } from "drizzle-orm";
import { resolvePublicKey, hashApiKey } from "../middleware/auth";
import { putObject } from "../lib/storage";
import { rateLimit, keyByIp } from "../lib/rate-limit";
import { fireEvent } from "../../services/dispatch";
import { checkServiceZone } from "../../services/zones";
import { attachMembership, findCompanyUserByEmail } from "../lib/memberships";
import { recomputeBooking } from "../../services/billing";
import { reconcileRiderStatus } from "../../services/presence";
import { capture } from "../lib/analytics";
import { incr } from "../lib/metrics";
import { z } from "zod";
import {
  parseBody,
  id as idField,
  isoDate,
  latitude,
  longitude,
  longText,
  optText,
  priority as priorityField,
  jsonBlob,
  jsonObject,
} from "../lib/validate";

/**
 * Employee work-order submission body.
 *
 * This endpoint is UNAUTHENTICATED (PIN-gated only) and creates a real
 * booking, a real invoice and fires real customer notifications, so it was the
 * highest-risk unvalidated body in the API. Previously every field was taken
 * raw: `lineItems`/`rateModel`/`fieldData` were JSON.stringify'd with no size
 * cap, free text had no length cap, and `lat`/`lng` were written straight to
 * the row (with `body.lat && body.lng` also skipping zone enforcement whenever
 * lat was exactly 0).
 */
const WorkOrderSubmit = z.object({
  customerId: idField("Client").optional(),
  clientName: optText(200),
  clientEmail: optText(320),
  clientPhone: optText(32),
  clientAddress: optText(500),
  serviceId: idField("Service").optional(),
  riderId: idField("Technician").optional(),
  title: optText(200),
  priority: priorityField.optional(),
  scheduledAt: isoDate("Schedule").optional(),
  address: optText(500),
  lat: latitude.optional(),
  lng: longitude.optional(),
  notes: longText(10_000).optional(),
  staffNotes: longText(10_000).optional(),
  region: optText(64),
  submittedBy: optText(200),
  fieldData: jsonObject().optional(),
  rateModel: jsonBlob(50_000).optional(),
  lineItems: z.array(jsonBlob(20_000)).max(500, "Too many line items").optional(),
});
import {
  normalizeCatalogItem,
  itemUnitCost,
  itemUnitPrice,
  marginPct,
  type CatalogItem,
} from "../../shared/catalog";

/** Decorate raw catalog rows with resolved cost/price (mirrors catalog.ts decorate()). */
function decorateCatalog(rows: (typeof schema.catalogItems.$inferSelect)[]) {
  const items: CatalogItem[] = rows.map(normalizeCatalogItem);
  const byId = new Map(items.map((i) => [i.id, i]));
  const lookup = (id: string) => byId.get(id);
  return rows.map((r) => {
    const it = normalizeCatalogItem(r);
    const cost = itemUnitCost(it, lookup);
    const price = itemUnitPrice(it, lookup);
    return { ...r, components: it.components, resolvedUnitCost: cost, resolvedUnitPrice: price, resolvedMarginPct: marginPct(cost, price) };
  });
}

/** Rate-limit for the PIN-gated employee actions on a work_order form (per IP). */
const workOrderLimiter = rateLimit({
  name: "public-wo",
  limit: Number(process.env.RL_WORKORDER_LIMIT ?? 60),
  windowMs: 60_000,
  keyFn: keyByIp,
});

/** Constant-time-ish shared-PIN check for a work_order form. Not a real auth
 *  session — just gates the link so it isn't wide open to the internet. */
function checkAccessCode(form: typeof schema.intakeForms.$inferSelect, c: any): boolean {
  if (form.formType !== "work_order") return true;
  const code = c.req.header("x-access-code") || c.req.header("X-Access-Code") || "";
  return !!form.accessCode && code === form.accessCode;
}

/** Fallback types for core fields that may be missing `type` in legacy rows */
const CORE_KEY_TYPES: Record<string, string> = {
  name: "text",
  email: "email",
  phone: "tel",
  address: "address",
  message: "textarea",
  service_type: "select",
  preferred_date: "date",
  company_name: "text",
};

function normalizePublicFields(raw: any[]): any[] {
  return raw.map((f: any) => ({
    ...f,
    type: f.type || CORE_KEY_TYPES[f.key] || "text",
  }));
}

/**
 * PUBLIC, UNAUTHENTICATED tenant intake forms.
 *
 *   GET  /api/public/forms/:companyId/:slug          -> form schema + branding
 *   POST /api/public/forms/:companyId/:slug/submit    -> creates a pending lead
 *
 * The submit endpoint authenticates with a browser-safe publishable key
 * (nvcpub_...) sent as `X-Public-Key` (or the form's bound key). Tenant is
 * resolved from the URL + verified against the key's companyId. All writes go
 * through tdb(companyId) so nothing can leak across tenants.
 */

const submitLimiter = rateLimit({
  name: "intake",
  limit: Number(process.env.RL_INTAKE_LIMIT ?? 30),
  windowMs: 60_000,
  keyFn: keyByIp,
});

// Public address lookups are cheap but proxy a paid API, so cap them per-IP.
const geoLimiter = rateLimit({
  name: "public-geo",
  limit: Number(process.env.RL_PUBLIC_GEO_LIMIT ?? 60),
  windowMs: 60_000,
  keyFn: keyByIp,
});

const GMAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;

function clientIp(c: any): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "0.0.0.0"
  );
}

async function loadForm(companyId: string, slug: string) {
  const [row] = await db
    .select()
    .from(schema.intakeForms)
    .where(and(eq(schema.intakeForms.companyId, companyId), eq(schema.intakeForms.slug, slug)))
    .limit(1);
  return row || null;
}

export const publicFormsRoutes = new Hono()
  // ---- address autocomplete (no auth, rate-limited) ----
  // Mirrors /geo/autocomplete but available to unauthenticated public forms so
  // every address field on a public intake page can still auto-populate.
  .get("/geo/autocomplete", geoLimiter, async (c) => {
    const q = c.req.query("q")?.trim();
    if (!q || q.length < 3) return c.json({ predictions: [] }, 200);

    if (GMAPS_KEY) {
      const url = new URL("https://maps.googleapis.com/maps/api/place/autocomplete/json");
      url.searchParams.set("input", q);
      url.searchParams.set("key", GMAPS_KEY);
      url.searchParams.set("components", "country:ca|country:us");
      const r = await fetch(url);
      const data = (await r.json()) as any;
      const predictions = (data.predictions || []).map((p: any) => ({
        placeId: p.place_id,
        description: p.description,
        main: p.structured_formatting?.main_text ?? p.description,
        secondary: p.structured_formatting?.secondary_text ?? "",
      }));
      return c.json({ predictions, provider: "google" }, 200);
    }

    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", q);
    url.searchParams.set("format", "json");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("limit", "6");
    const r = await fetch(url, { headers: { "User-Agent": "NVC360/1.0" } });
    const data = (await r.json()) as any;
    const predictions = (data || []).map((p: any) => ({
      placeId: `osm:${p.lat},${p.lon}`,
      description: p.display_name,
      main: p.display_name.split(",")[0],
      secondary: p.display_name.split(",").slice(1).join(",").trim(),
      lat: parseFloat(p.lat),
      lng: parseFloat(p.lon),
    }));
    return c.json({ predictions, provider: "osm" }, 200);
  })
  // ---- resolve a placeId to coords + formatted address (no auth, rate-limited) ----
  .get("/geo/details", geoLimiter, async (c) => {
    const placeId = c.req.query("placeId");
    if (!placeId) return c.json({ message: "placeId required" }, 400);

    if (placeId.startsWith("osm:")) {
      const [lat, lng] = placeId.slice(4).split(",").map(Number);
      return c.json({ lat, lng, address: c.req.query("description") || "" }, 200);
    }

    if (GMAPS_KEY) {
      const url = new URL("https://maps.googleapis.com/maps/api/place/details/json");
      url.searchParams.set("place_id", placeId);
      url.searchParams.set("key", GMAPS_KEY);
      url.searchParams.set("fields", "geometry,formatted_address");
      const r = await fetch(url);
      const data = (await r.json()) as any;
      const loc = data.result?.geometry?.location;
      return c.json(
        {
          lat: loc?.lat ?? null,
          lng: loc?.lng ?? null,
          address: data.result?.formatted_address ?? "",
          provider: "google",
        },
        200,
      );
    }
    return c.json({ message: "No geocoder configured" }, 500);
  })
  // ---- form schema (no auth) ----
  .get("/:companyId/:slug", async (c) => {
    const companyId = c.req.param("companyId");
    const slug = c.req.param("slug");
    const form = await loadForm(companyId, slug);
    if (!form || !form.active) return c.json({ message: "Form not found" }, 404);

    const t = tdb(companyId);
    // company display name for the header
    const [company] = await db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, companyId))
      .limit(1);
    // tenant's brand vocabulary for their field worker (e.g. "Installer" for
    // BMD Materials) — same source the admin work-order modal reads via
    // useWorkerNoun(), so the public work-order form's per-unit pay labels
    // match ("pay the Installer" instead of a hardcoded "Technician").
    const cs = await t.selectOne(schema.companySettings);
    // active services for the "service type" dropdown
    const services = (await t.select(schema.services, eq(schema.services.active, true)))
      .map((s) => ({ id: s.id, name: s.name, category: s.category }));

    // include the public key prefix so the browser can submit (the page reads it)
    let publicKey = "";
    if (form.publicKeyId) {
      const [k] = await db
        .select()
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.id, form.publicKeyId))
        .limit(1);
      // NOTE: we cannot return the raw key (it's hashed). The page submits using
      // the key embedded at build/share time; here we only confirm one is bound.
      if (k && k.keyType === "public" && !k.revokedAt) publicKey = k.prefix;
    }

    return c.json({
      form: {
        title: form.title,
        intro: form.intro,
        fields: normalizePublicFields(JSON.parse(form.fields || "[]")),
        sections: JSON.parse(form.sections || "[]"),
        brandColor: form.brandColor,
        logoUrl: form.logoUrl,
        successMessage: form.successMessage,
        companyName: company?.name || form.title,
        hasPublicKey: !!publicKey,
        formType: form.formType || "lead",
        allowTechAssign: form.allowTechAssign,
        workerNoun: cs?.workerNoun || "Technician",
      },
      services,
    }, 200);
  })

  // ---- verify the shared employee access code (work_order forms only) ----
  .post("/:companyId/:slug/verify-code", workOrderLimiter, async (c) => {
    const companyId = c.req.param("companyId");
    const slug = c.req.param("slug");
    const form = await loadForm(companyId, slug);
    if (!form || !form.active || form.formType !== "work_order")
      return c.json({ message: "Form not found" }, 404);
    const b = await parseBody(c, z.object({ code: z.string().max(128).optional() }));
    const code = (b.code ?? "").trim();
    const ok = !!form.accessCode && code === form.accessCode;
    return c.json({ ok }, ok ? 200 : 401);
  })

  // ---- catalog items for the work-order line-item builder (PIN required) ----
  .get("/:companyId/:slug/catalog", workOrderLimiter, async (c) => {
    const companyId = c.req.param("companyId");
    const slug = c.req.param("slug");
    const form = await loadForm(companyId, slug);
    if (!form || !form.active || form.formType !== "work_order")
      return c.json({ message: "Form not found" }, 404);
    if (!checkAccessCode(form, c)) return c.json({ message: "Invalid access code" }, 401);

    const q = (c.req.query("q") || "").toLowerCase();
    const kind = c.req.query("kind");
    let rows = await tdb(companyId).select(schema.catalogItems, eq(schema.catalogItems.active, true));
    if (kind && kind !== "all") rows = rows.filter((r) => r.kind === kind);
    if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.sku.toLowerCase().includes(q) || r.category.toLowerCase().includes(q));
    rows = rows.sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ items: decorateCatalog(rows) }, 200);
  })

  // ---- search existing clients by name/email/phone (PIN required) ----
  .get("/:companyId/:slug/clients", workOrderLimiter, async (c) => {
    const companyId = c.req.param("companyId");
    const slug = c.req.param("slug");
    const form = await loadForm(companyId, slug);
    if (!form || !form.active || form.formType !== "work_order")
      return c.json({ message: "Form not found" }, 404);
    if (!checkAccessCode(form, c)) return c.json({ message: "Invalid access code" }, 401);

    const q = (c.req.query("q") || "").trim().toLowerCase();
    if (q.length < 2) return c.json({ clients: [] }, 200);
    const rows = await db
      .select()
      .from(schema.user)
      .where(and(eq(schema.user.companyId, companyId), eq(schema.user.role, "customer")));
    const matches = rows
      .filter((u) =>
        u.name?.toLowerCase().includes(q) ||
        u.email?.toLowerCase().includes(q) ||
        (u.phone || "").toLowerCase().includes(q))
      .slice(0, 20)
      .map((u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone || "", address: u.address || "" }));
    return c.json({ clients: matches }, 200);
  })

  // ---- active technicians, for forms that allow tech assignment (PIN required) ----
  .get("/:companyId/:slug/riders", workOrderLimiter, async (c) => {
    const companyId = c.req.param("companyId");
    const slug = c.req.param("slug");
    const form = await loadForm(companyId, slug);
    if (!form || !form.active || form.formType !== "work_order")
      return c.json({ message: "Form not found" }, 404);
    if (!checkAccessCode(form, c)) return c.json({ message: "Invalid access code" }, 401);
    if (!form.allowTechAssign) return c.json({ riders: [] }, 200);

    const rows = await tdb(companyId).select(schema.riders);
    const out = await Promise.all(rows.map(async (r) => {
      const [u] = await db.select().from(schema.user).where(eq(schema.user.id, r.userId)).limit(1);
      return { id: r.id, name: u?.name || "Technician", skillClass: r.skillClass, status: r.status };
    }));
    return c.json({ riders: out }, 200);
  })

  // ---- submit (public key required) ----
  .post("/:companyId/:slug/submit", submitLimiter, async (c) => {
    const companyId = c.req.param("companyId");
    const slug = c.req.param("slug");
    const form = await loadForm(companyId, slug);
    if (!form || !form.active) return c.json({ message: "Form not found" }, 404);

    // ---- work_order forms submit through a completely different path: they
    // create a REAL, priced work order (booking) with the same optionality as
    // the admin work-order modal (client search/create, catalog line items,
    // optional tech + schedule). They're gated by the shared employee PIN
    // instead of a publishable key — no public key check applies here. ----
    if (form.formType === "work_order") {
      if (!checkAccessCode(form, c)) return c.json({ message: "Invalid access code" }, 401);
      const origin = c.req.header("origin") || c.req.header("referer") || "";
      return submitWorkOrder(c, companyId, form, origin);
    }

    // ---- authenticate the publishable key (lead forms only) ----
    const rawKey =
      c.req.header("x-public-key") ||
      c.req.header("X-Public-Key") ||
      "";
    const pub = await resolvePublicKey(rawKey);
    if (!pub) return c.json({ message: "Invalid or missing public key" }, 401);
    if (pub.companyId !== companyId)
      return c.json({ message: "Key does not belong to this tenant" }, 403);
    // if the form binds a specific key, enforce it
    if (form.publicKeyId && form.publicKeyId !== pub.id)
      return c.json({ message: "Key not authorized for this form" }, 403);

    // ---- origin allow-list (if configured on the key) ----
    const origin = c.req.header("origin") || c.req.header("referer") || "";
    if (pub.allowedOrigins.length) {
      const ok = pub.allowedOrigins.some((o) => origin.startsWith(o));
      if (!ok) return c.json({ message: "Origin not allowed" }, 403);
    }

    // ---- parse body (multipart for optional photo, else JSON) ----
    const ct = c.req.header("content-type") || "";
    let body: Record<string, any> = {};
    let photoFile: File | null = null;
    if (ct.includes("multipart/form-data")) {
      const fd = await c.req.formData();
      for (const [k, v] of fd.entries()) {
        if (v instanceof File) { if (k === "photo") photoFile = v; }
        else body[k] = v;
      }
    } else {
      body = await c.req.json().catch(() => ({}));
    }

    // This handler can't take a fixed zod schema: the body carries arbitrary
    // per-form custom-field keys and may arrive as multipart. So the core
    // fields are capped explicitly instead. Uncapped, a public form could push
    // a 50k-character "name" into the row and into every notification email.
    const cap = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
    const name = cap(body.name, 200);
    const email = cap(body.email, 320).toLowerCase();
    const phone = cap(body.phone, 32);
    const address = cap(body.address, 500);
    const notes = cap(body.notes, 10_000);
    const serviceId = cap(body.serviceId || body.serviceType, 128);
    // `new Date("next tuesday")` is an Invalid Date, which drizzle writes
    // happily and which then breaks every screen that formats the column.
    const preferredRaw = body.preferredAt ? new Date(String(body.preferredAt)) : null;
    const preferredAt =
      preferredRaw && !Number.isNaN(preferredRaw.getTime()) ? preferredRaw : null;

    // ---- field config (rich) ----
    type RF = {
      id?: string; key: string; type?: string; enabled?: boolean; required?: boolean;
      label?: string; core?: boolean;
    };
    const fields = JSON.parse(form.fields || "[]") as RF[];
    const CORE_KEYS = new Set(["name", "email", "phone", "address", "notes", "serviceType", "preferredAt", "photo"]);
    const coreVal: Record<string, string> = { name, email, phone, address, notes };

    // ---- collect CUSTOM field answers (anything not a core key) ----
    const customAnswers: Array<{ label: string; key: string; value: string }> = [];
    for (const f of fields) {
      if (!f.enabled) continue;
      if (CORE_KEYS.has(f.key)) continue;
      const raw = body[f.key];
      const value = cap(Array.isArray(raw) ? raw.join(", ") : raw, 5_000);
      customAnswers.push({ label: f.label || f.key, key: f.key, value });
    }

    // ---- validate required fields per form config ----
    for (const f of fields) {
      if (!f.enabled || !f.required) continue;
      if (f.key === "photo" || f.key === "serviceType" || f.key === "preferredAt") continue;
      if (CORE_KEYS.has(f.key)) {
        if (!coreVal[f.key]) return c.json({ message: `${f.label || f.key} is required` }, 400);
      } else {
        const ans = customAnswers.find((a) => a.key === f.key);
        if (!ans?.value) return c.json({ message: `${f.label || f.key} is required` }, 400);
      }
    }
    if (!name) return c.json({ message: "Name is required" }, 400);

    const t = tdb(companyId);

    // ---- resolve a service (picked, form default, or first active) ----
    let svcId = serviceId || form.defaultServiceId || "";
    let svc = svcId ? await t.selectOne(schema.services, eq(schema.services.id, svcId)) : undefined;
    if (!svc) {
      svc = await t.selectOne(schema.services, eq(schema.services.active, true));
    }
    // Safety net: a tenant may publish an intake form before adding any
    // bookable service. Rather than dead-ending the customer (lead lost), we
    // auto-provision a generic "General Request" service for this tenant so the
    // submission always lands as a real booking/lead. Admins can rename, price,
    // or split it later in Catalog → Services.
    if (!svc) {
      const [created] = await db
        .insert(schema.services)
        .values({
          companyId,
          name: "General Request",
          category: "general",
          description: "Auto-created to capture intake form requests. Rename or customize in Catalog → Services.",
          icon: "clipboard-list",
          basePrice: 0,
          durationMins: 60,
          active: true,
        })
        .returning()
        .catch(() => [] as (typeof schema.services.$inferSelect)[]);
      svc = created;
    }
    if (!svc) return c.json({ message: "We couldn't process your request right now. Please try again shortly." }, 503);
    svcId = svc.id;

    // ---- find-or-create the customer user (tenant-scoped by email) ----
    // Match on membership, not user.companyId: a customer this company shares
    // with another company still belongs to THIS roster.
    let customer = email
      ? ((await findCompanyUserByEmail(email, companyId)) ?? undefined)
      : undefined;
    if (!customer) {
      const uid = crypto.randomUUID();
      // email must be globally unique on the user table; namespace if missing/clash
      const safeEmail = email || `lead-${uid.slice(0, 8)}@${companyId}.intake.local`;
      const ins = await db
        .insert(schema.user)
        .values({
          id: uid,
          name: name || "Website lead",
          email: safeEmail,
          role: "customer",
          companyId,
          phone: phone || null,
          address: address || null,
        })
        .returning()
        .catch(async () => {
          // email collision across tenants -> create with namespaced email
          const uid2 = crypto.randomUUID();
          return db
            .insert(schema.user)
            .values({
              id: uid2,
              name: name || "Website lead",
              email: `lead-${uid2.slice(0, 8)}+${companyId}@intake.local`,
              role: "customer",
              companyId,
              phone: phone || null,
              address: address || null,
            })
            .returning();
        });
      customer = ins[0];
      // Without a membership the new client would not show on this company's
      // client list, which is membership-scoped now.
      if (customer) await attachMembership({ userId: customer.id, companyId, role: "customer", status: "active" });
    }

    // ---- optional photo upload ----
    let photoUrl = "";
    if (photoFile && photoFile.size > 0 && photoFile.size <= 15 * 1024 * 1024) {
      const ext = (photoFile.name.split(".").pop() || "jpg").toLowerCase().slice(0, 8);
      const key = `intake/${companyId}/${crypto.randomUUID()}.${ext}`;
      const buf = Buffer.from(await photoFile.arrayBuffer());
      const stored = await putObject(key, buf, photoFile.type || "image/jpeg");
      photoUrl = stored.url;
    }

    // ---- zone enforcement (if client submitted geocoded lat/lng with the form) ----
    // Shared with both booking-create paths (services/zones.ts) — this used to
    // be a third inline copy. `Number.isFinite`, not truthiness: lat/lng 0 are
    // real coordinates and used to skip enforcement entirely.
    const subLat = typeof body.lat === "number" ? body.lat : parseFloat(body.lat);
    const subLng = typeof body.lng === "number" ? body.lng : parseFloat(body.lng);
    if (Number.isFinite(subLat) && Number.isFinite(subLng)) {
      const zone = await checkServiceZone(t.companyId, subLat, subLng);
      if (!zone.ok) {
        return c.json({ message: "Sorry, your address is outside our service area. Please contact us directly for availability." }, 422);
      }
    }

    // ---- create the pending lead booking ----
    const scheduledAt = preferredAt && !isNaN(preferredAt.getTime()) ? preferredAt : new Date(Date.now() + 86400_000);
    const customNotes = customAnswers.filter((a) => a.value).map((a) => `${a.label}: ${a.value}`).join("\n");
    const composedNotes = [notes, customNotes, photoUrl ? `Photo: ${photoUrl}` : ""].filter(Boolean).join("\n");
    const [booking] = await t.insert(schema.bookings, {
      customerId: customer.id,
      serviceId: svcId,
      title: svc.name,
      priority: "normal",
      status: "pending", // lands in the pipeline as a new lead
      scheduledAt,
      address: address || "(no address provided)",
      notes: composedNotes,
      customerPhone: phone || "",
      fieldData: JSON.stringify({
        source: "intake_form",
        formSlug: slug,
        preferredAt: preferredAt ? preferredAt.toISOString() : null,
        photoUrl: photoUrl || null,
        custom: customAnswers.reduce<Record<string, string>>((acc, a) => { acc[a.key] = a.value; return acc; }, {}),
      }),
      price: svc.basePrice,
    });

    // ---- audit submission + bump count ----
    await t.insert(schema.intakeSubmissions, {
      formId: form.id,
      bookingId: booking.id,
      payload: JSON.stringify({ name, email, phone, address, notes, serviceId: svcId, preferredAt, photoUrl, custom: customAnswers }),
      ipHash: (await hashApiKey(clientIp(c))).slice(0, 16),
      origin,
    });
    await t.update(
      schema.intakeForms,
      { submitCount: (form.submitCount || 0) + 1 },
      eq(schema.intakeForms.id, form.id),
    );

    // ---- notify the tenant (configurable dispatch) ----
    fireEvent("created", booking.id).catch(() => {});

    // ---- email the form's designated recipient (master "where it's sent") ----
    if (form.recipientEmail) {
      notifyRecipient(form, {
        name, email, phone, address, notes, service: svc.name,
        preferredAt: preferredAt ? preferredAt.toLocaleString() : "",
        photoUrl, custom: customAnswers,
      }).catch((e) => console.error("intake recipient email failed", e));
    }

    return c.json({ ok: true, message: form.successMessage }, 201);
  });

/** Email the configured recipient a clean summary of an intake submission. */
async function notifyRecipient(
  form: typeof schema.intakeForms.$inferSelect,
  d: {
    name: string; email: string; phone: string; address: string; notes: string;
    service: string; preferredAt: string; photoUrl: string;
    custom: Array<{ label: string; value: string }>;
  },
) {
  const esc = (s: string) => String(s || "").replace(/[<>&]/g, (m) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[m]!));
  const rows: Array<[string, string]> = [
    ["Name", d.name],
    ["Email", d.email],
    ["Phone", d.phone],
    ["Address", d.address],
    ["Service", d.service],
    ["Preferred date", d.preferredAt],
    ["Notes", d.notes],
    ...d.custom.filter((c) => c.value).map((c) => [c.label, c.value] as [string, string]),
  ].filter(([, v]) => v);
  if (d.photoUrl) rows.push(["Photo", `<a href="${esc(d.photoUrl)}">${esc(d.photoUrl)}</a>`]);

  const brand = form.brandColor || "#06b6d4";
  const tableRows = rows
    .map(
      ([k, v], i) =>
        `<tr style="background:${i % 2 ? "#f8fafc" : "#ffffff"}"><td style="padding:10px 14px;font-weight:600;color:#475569;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:10px 14px;color:#0f172a">${k === "Photo" ? v : esc(v)}</td></tr>`,
    )
    .join("");
  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto">
    <div style="background:${brand};color:#fff;padding:18px 22px;border-radius:12px 12px 0 0">
      <div style="font-size:13px;opacity:.85">New intake submission</div>
      <div style="font-size:20px;font-weight:700">${esc(form.title)}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-top:0;border-radius:0 0 12px 12px;overflow:hidden">${tableRows}</table>
    <p style="color:#94a3b8;font-size:12px;margin-top:14px">A pending lead was also created in your pipeline.</p>
  </div>`;

  const { sendEmail } = await import("../../services/email");
  await sendEmail({
    to: form.recipientName ? `${form.recipientName} <${form.recipientEmail}>` : form.recipientEmail,
    subject: `New ${form.title} submission${d.name ? ` from ${d.name}` : ""}`,
    html,
    replyTo: d.email || undefined,
  });
}

/**
 * Employee work-order submission (PIN-gated, no login). Creates a REAL,
 * priced booking with the same optionality as the admin work-order modal:
 * find-or-create client, optional technician + schedule, catalog line items
 * (products/services/assemblies) plus ad-hoc lines, priority, notes.
 * Mirrors POST /api/bookings/admin — kept as a separate handler since the
 * request shape (JSON, PIN-gated, unauthenticated) differs from the admin
 * session-authenticated route.
 */
async function submitWorkOrder(c: any, companyId: string, form: typeof schema.intakeForms.$inferSelect, origin: string) {
  const body = await parseBody(c, WorkOrderSubmit);
  const t = tdb(companyId);

  // ---- resolve or create the client ----
  let customerId: string = body.customerId ?? "";
  if (!customerId) {
    const name = body.clientName ?? "";
    const email = (body.clientEmail ?? "").toLowerCase();
    const phone = body.clientPhone ?? "";
    const address = body.clientAddress ?? "";
    if (!name) return c.json({ message: "Client name is required (or pick an existing client)" }, 400);

    let customer = email
      ? ((await findCompanyUserByEmail(email, companyId)) ?? undefined)
      : undefined;
    if (!customer) {
      const uid = crypto.randomUUID();
      const safeEmail = email || `client-${uid.slice(0, 8)}@${companyId}.workorder.local`;
      const ins = await db.insert(schema.user).values({
        id: uid, name, email: safeEmail, role: "customer", companyId,
        phone: phone || null, address: address || null,
      }).returning().catch(async () => {
        const uid2 = crypto.randomUUID();
        return db.insert(schema.user).values({
          id: uid2, name, email: `client-${uid2.slice(0, 8)}+${companyId}@workorder.local`,
          role: "customer", companyId, phone: phone || null, address: address || null,
        }).returning();
      });
      customer = ins[0];
      // Without a membership the new client would not show on this company's
      // client list, which is membership-scoped now.
      if (customer) await attachMembership({ userId: customer.id, companyId, role: "customer", status: "active" });
    }
    customerId = customer.id;
  }
  const [cu] = await db.select().from(schema.user).where(eq(schema.user.id, customerId));
  if (!cu) return c.json({ message: "Client not found" }, 404);

  // ---- service ----
  const svc = body.serviceId
    ? await t.selectOne(schema.services, eq(schema.services.id, body.serviceId))
    : undefined;
  if (!svc) return c.json({ message: "Service is required" }, 400);

  // ---- optional technician (only if the form allows it) ----
  let riderId: string | null = null;
  if (form.allowTechAssign && body.riderId) {
    const rider = await t.selectOne(schema.riders, eq(schema.riders.id, body.riderId));
    if (rider) riderId = rider.id;
  }

  // ---- zone enforcement, shared with both booking-create paths ----
  // `!= null`, not truthiness: lat 0 is a real coordinate and the old check
  // let a submission at the equator skip zone enforcement entirely.
  if (body.lat != null && body.lng != null) {
    const zone = await checkServiceZone(t.companyId, body.lat, body.lng);
    if (!zone.ok) {
      return c.json({ message: "Address is outside all active service zones." }, 422);
    }
  }

  // ---- custom fields the office configured on this form (if any) ----
  const fieldData = body.fieldData ? JSON.stringify(body.fieldData) : "{}";

  // ---- schedule: optional, default to next business day like the lead path ----
  const scheduledAt = body.scheduledAt ?? new Date(Date.now() + 86400_000);

  const lineItems = body.lineItems ?? [];

  const [b] = await t.insert(schema.bookings, {
    customerId,
    serviceId: svc.id,
    riderId,
    title: body.title || svc.name,
    priority: body.priority ?? "normal",
    status: riderId ? "assigned" : "confirmed",
    scheduledAt,
    address: body.address || cu.address || "(no address provided)",
    lat: body.lat ?? 43.6532,
    lng: body.lng ?? -79.3832,
    notes: body.notes || "",
    staffNotes: body.staffNotes || "",
    fieldData,
    customerPhone: body.clientPhone || cu.phone || "",
    region: body.region || "",
    // hourly charges from the form's ChargesEditor are carried as a rate
    // model (mirrors how the admin work-order modal persists them) so
    // recomputeBooking() bills the tiered hourly rate once the job's actual
    // on-site time is recorded.
    rateModel: body.rateModel ? JSON.stringify(body.rateModel) : "",
    lineItems: JSON.stringify(lineItems),
    price: svc.basePrice,
  });

  const bill = await recomputeBooking(companyId, b.id);

  const num = `INV-${Date.now().toString().slice(-6)}`;
  const amount = bill?.subtotal ?? svc.basePrice;
  const tax = bill?.taxAmount ?? +(svc.basePrice * 0.13).toFixed(2);
  await t.insert(schema.invoices, {
    bookingId: b.id, customerId, number: num, amount, tax,
    total: bill?.total ?? +(amount + tax).toFixed(2),
  });

  if (riderId) {
    await t.update(schema.bookings, { assignStatus: "offered", assignedAt: new Date() }, eq(schema.bookings.id, b.id));
    await reconcileRiderStatus(companyId, riderId);
  }

  await t.insert(schema.intakeSubmissions, {
    formId: form.id,
    bookingId: b.id,
    payload: JSON.stringify({ customerId, serviceId: svc.id, riderId, lineItems, submittedBy: body.submittedBy || "" }),
    ipHash: (await hashApiKey(clientIp(c))).slice(0, 16),
    origin,
  });
  await t.update(schema.intakeForms, { submitCount: (form.submitCount || 0) + 1 }, eq(schema.intakeForms.id, form.id));

  fireEvent("created", b.id).catch(() => {});
  if (riderId) fireEvent("assigned", b.id).catch(() => {});
  incr("bookings_created_total");
  capture("booking.created", companyId, { bookingId: b.id, serviceId: svc.id, source: "public_work_order_form" });

  if (form.recipientEmail) {
    notifyWorkOrderRecipient(form, { clientName: cu.name, service: svc.name, total: bill?.total ?? amount, submittedBy: body.submittedBy || "" })
      .catch((e) => console.error("work order recipient email failed", e));
  }

  return c.json({ ok: true, message: form.successMessage, bookingId: b.id, publicToken: b.publicToken }, 201);
}

/** Email the configured recipient a summary of a new employee-submitted work order. */
async function notifyWorkOrderRecipient(
  form: typeof schema.intakeForms.$inferSelect,
  d: { clientName: string; service: string; total: number; submittedBy: string },
) {
  const esc = (s: string) => String(s || "").replace(/[<>&]/g, (m) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[m]!));
  const brand = form.brandColor || "#06b6d4";
  const rows: Array<[string, string]> = [
    ["Client", d.clientName],
    ["Service", d.service],
    ["Total", `$${d.total.toFixed(2)}`],
    ["Submitted by", d.submittedBy || "—"],
  ];
  const tableRows = rows.map(([k, v], i) =>
    `<tr style="background:${i % 2 ? "#f8fafc" : "#ffffff"}"><td style="padding:10px 14px;font-weight:600;color:#475569;white-space:nowrap">${esc(k)}</td><td style="padding:10px 14px;color:#0f172a">${esc(v)}</td></tr>`
  ).join("");
  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto">
    <div style="background:${brand};color:#fff;padding:18px 22px;border-radius:12px 12px 0 0">
      <div style="font-size:13px;opacity:.85">New employee work order</div>
      <div style="font-size:20px;font-weight:700">${esc(form.title)}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-top:0;border-radius:0 0 12px 12px;overflow:hidden">${tableRows}</table>
  </div>`;
  const { sendEmail } = await import("../../services/email");
  await sendEmail({
    to: form.recipientName ? `${form.recipientName} <${form.recipientEmail}>` : form.recipientEmail,
    subject: `New work order: ${d.clientName} — ${d.service}`,
    html,
  });
}
