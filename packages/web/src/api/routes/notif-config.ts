import type { AppEnv } from "../env";
import { Hono } from "hono";
import * as schema from "../database/schema";
import { eq } from "drizzle-orm";
import { requireAdmin, tx, tenantId } from "../middleware/auth";
import { fireEvent, seedNotificationRules, EVENT_META, defaultTemplateFor, interpolateSample, TEMPLATE_VARS, renderDesignPreview, sendDesignTest, type NvcEvent } from "../../services/dispatch";
import { starterDesigns, type EmailBlock } from "../../services/email-render";
import { putObject } from "../lib/storage";
import { resendAvailable, triggerVerify, removeDomain } from "../../services/email-domains";
import { z } from "zod";
import { jsonBody,
  parseBody,
  shortText,
  longText,
  optText,
  email,
  id,
  jsonBlob,
  hhmm,
  bool,
  hexColor,
  outboundUrl,
} from "../lib/validate";

const EVENTS = Object.keys(EVENT_META) as NvcEvent[];
const RECIPIENTS = ["client", "tech", "office"] as const;
const CHANNELS = ["inApp", "email", "sms", "webhook"] as const;

/* -------------------------------------------------------------------------- */
/*  Request bodies                                                            */
/*                                                                            */
/*  Every body on this file was a raw c.req.json() copied field-by-field into  */
/*  an update. Reproduced live before this pass:                              */
/*                                                                            */
/*   - PATCH /rules/:id { email: "yes" } -> 200, writing a string into a       */
/*     boolean column; { enabled: {} } was accepted too. And a bogus rule id   */
/*     returned 200 with an empty body instead of 404, so the UI showed a      */
/*     successful toggle that had updated nothing.                             */
/*   - PATCH /rules/:id { emailSubject: 50_000 chars } -> 200.                 */
/*   - POST /rules/bulk { event: "made.up", value: "yes" } -> 200 ok:true, a   */
/*     silent no-op against an event that doesn't exist.                       */
/*   - POST /preview { template: {} } -> bare 500 (interpolate on a non-string)*/
/*   - POST /email/test { to: "not an email" } -> 200 and a real Resend call   */
/*     that bounced against the tenant's own verified sending domain.          */
/*   - POST /email/templates with a 20,000-character name -> 201.              */
/*   - PATCH /channels { emailFromAddress: "totally not an email" } -> 200.    */
/*     That is the tenant's sending identity: every notification email from    */
/*     that company then fails at the provider. quietStart: "99:99" and        */
/*     emailEnabled: "no" were accepted the same way.                          */
/*   - POST /webhooks with no url -> bare 500 (NOT NULL); with                 */
/*     "javascript:alert(1)" -> 201 (stored XSS); with                         */
/*     "http://localhost:4200/..." -> 201, and /webhooks/:id/test then fetched */
/*     it, turning our own test-ping into an SSRF probe of the host network.   */
/* -------------------------------------------------------------------------- */

const RulePatch = z
  .object({
    inApp: bool("In-app"),
    email: bool("Email"),
    sms: bool("SMS"),
    webhook: bool("Webhook"),
    enabled: bool("Enabled"),
    template: longText(10_000),
    emailSubject: shortText("Subject", 200),
    emailDesign: z.union([z.string().max(200_000), jsonBlob()]),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { error: "Nothing to update" });

const BulkBody = z.object({
  event: z.enum(EVENTS as [NvcEvent, ...NvcEvent[]], { error: "Unknown event" }),
  channel: z.enum(CHANNELS, { error: "Channel must be one of: inApp, email, sms, webhook" }),
  value: z.boolean({ error: "Value must be true or false" }),
});

const PreviewBody = z.object({ template: longText(20_000).optional() });

const RenderBody = z.object({
  design: z.array(jsonBlob(50_000), { error: "Design must be a list of blocks" }).max(200).optional(),
  footer: optText(2_000),
});

const TestEmailBody = z.object({
  to: email("Recipient"),
  subject: shortText("Subject", 200).optional(),
  design: z.array(jsonBlob(50_000), { error: "Design must be a list of blocks" }).max(200).optional(),
});

const TemplateFields = {
  name: shortText("Name", 120),
  description: optText(500),
  subject: shortText("Subject", 200).optional(),
  design: z.union([z.string().max(200_000), jsonBlob()]).optional(),
};
const TemplateCreate = z.object(TemplateFields);
const TemplatePatch = z
  .object(TemplateFields)
  .partial()
  .refine((b) => Object.keys(b).length > 0, { error: "Nothing to update" });

const ChannelsPatch = z
  .object({
    inAppEnabled: bool("In-app notifications"),
    emailEnabled: bool("Email notifications"),
    smsEnabled: bool("SMS notifications"),
    webhookEnabled: bool("Webhooks"),
    // These are all legitimately blank in live data (the sender name falls back
    // to the company name, SMS sender id is Twilio-optional), and the Channels
    // tab PATCHes the WHOLE row on save — so a min-length rule here would 400
    // the entire Save button. Length-capped only.
    emailFromName: longText(120),
    // Allowed to be cleared (falls back to the platform default sender), but
    // never allowed to be a non-address.
    emailFromAddress: z.union([email("Sender address"), z.literal("")]),
    emailReplyTo: z.union([email("Reply-to address"), z.literal("")]),
    emailFooter: longText(2_000),
    emailBodyTemplate: longText(20_000),
    smsBodyTemplate: longText(2_000),
    smsFromNumber: longText(32),
    smsSenderId: longText(32),
    quietHoursEnabled: bool("Quiet hours"),
    quietStart: hhmm("Quiet hours start"),
    quietEnd: hhmm("Quiet hours end"),
    quietChannels: z.string().trim().max(120),
    emailLogoUrl: z.string().trim().max(2_000),
    emailBrandColor: z.union([hexColor("Brand colour"), z.literal("")]),
    emailHeaderStyle: z.enum(["gradient", "solid", "plain", "logo"], {
      error: "Header style must be gradient, solid, plain or logo",
    }),
    emailBgColor: z.union([hexColor("Background colour"), z.literal("")]),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { error: "Nothing to update" });

const WebhookFields = {
  label: shortText("Label", 120).optional(),
  url: outboundUrl("Webhook URL"),
  secret: shortText("Secret", 200).optional(),
  events: z.string().trim().max(2_000).optional(),
  active: bool("Active").optional(),
};
const WebhookCreate = z.object(WebhookFields);
const WebhookPatch = z
  .object({ ...WebhookFields, url: outboundUrl("Webhook URL").optional() })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { error: "Nothing to update" });

const TestEventBody = z.object({ bookingId: id("Work order id").optional() });

/**
 * Resolve (creating if needed) the single notification_channels row for the
 * active company. Tenancy: one row per company, keyed by companyId. The legacy
 * `id="default"` singleton no longer exists.
 */
async function getOrCreateChannels(c: any) {
  const t = tx(c);
  let row = await t.selectOne(schema.notificationChannels);
  if (!row) {
    const co = await t.selectOne(schema.companySettings);
    [row] = await t.insert(schema.notificationChannels, {
      emailFromName: co?.name || "NVC 360",
      emailFromAddress: co?.email || "",
    });
  }
  return row;
}

export const notifConfigRoutes = new Hono<AppEnv>()
  // full rule matrix (seeds defaults on first call)
  .get("/rules", requireAdmin, async (c) => {
    await seedNotificationRules(tenantId(c));
    const t = tx(c);
    const rules = await t.select(schema.notificationRules);
    // ensure a row exists for every event×recipient so the UI grid is complete
    const have = new Set(rules.map((r) => `${r.event}:${r.recipient}`));
    const toAdd: any[] = [];
    for (const event of EVENTS)
      for (const recipient of RECIPIENTS)
        if (!have.has(`${event}:${recipient}`))
          toAdd.push({ event, recipient, inApp: false, email: false, sms: false, webhook: false, enabled: true });
    if (toAdd.length) {
      await t.insert(schema.notificationRules, toAdd);
    }
    const all = await t.select(schema.notificationRules);
    const meta = EVENTS.map((e) => ({ event: e, label: EVENT_META[e].label }));
    return c.json({ rules: all, events: meta, recipients: RECIPIENTS }, 200);
  })
  // update one rule (toggle a channel etc.)
  .patch("/rules/:id", requireAdmin, jsonBody(RulePatch), async (c) => {
    const ruleId = c.req.param("id");
    const body = c.req.valid("json");
    const t = tx(c);
    const existing = await t.selectOne(schema.notificationRules, eq(schema.notificationRules.id, ruleId));
    if (!existing) return c.json({ message: "Notification rule not found" }, 404);
    const patch: Record<string, unknown> = { ...body, updatedAt: new Date() };
    if (body.emailDesign !== undefined)
      patch.emailDesign = typeof body.emailDesign === "string" ? body.emailDesign : JSON.stringify(body.emailDesign);
    const [r] = await t.update(schema.notificationRules, patch as any, eq(schema.notificationRules.id, ruleId));
    return c.json({ rule: r }, 200);
  })
  // bulk set a whole column for an event row (convenience)
  .post("/rules/bulk", requireAdmin, jsonBody(BulkBody), async (c) => {
    const { event, channel, value } = c.req.valid("json");
    await tx(c).update(
      schema.notificationRules,
      { [channel]: value, updatedAt: new Date() } as any,
      eq(schema.notificationRules.event, event),
    );
    return c.json({ ok: true }, 200);
  })

  // ---- single event detail (all 3 recipient rows + meta + sample template vars) ----
  .get("/events/:event", requireAdmin, async (c) => {
    await seedNotificationRules(tenantId(c));
    const event = c.req.param("event") as NvcEvent;
    if (!EVENT_META[event]) return c.json({ message: "unknown event" }, 404);
    const t = tx(c);
    const rows = await t.select(schema.notificationRules, eq(schema.notificationRules.event, event));
    // make sure all 3 recipient rows exist
    const have = new Set(rows.map((r) => r.recipient));
    const toAdd = RECIPIENTS.filter((r) => !have.has(r)).map((recipient) => ({ event, recipient, inApp: false, email: false, sms: false, webhook: false, enabled: true }));
    if (toAdd.length) await t.insert(schema.notificationRules, toAdd);
    const all = await t.select(schema.notificationRules, eq(schema.notificationRules.event, event));
    return c.json({
      event,
      meta: EVENT_META[event],
      rules: all,
      defaults: Object.fromEntries(RECIPIENTS.map((r) => [r, defaultTemplateFor(event, r as any)])),
      vars: TEMPLATE_VARS,
    }, 200);
  })

  // ---- template preview (interpolate {{vars}} against sample data) ----
  .post("/preview", requireAdmin, jsonBody(PreviewBody), async (c) => {
    const { template } = c.req.valid("json");
    const channels = await tx(c).selectOne(schema.notificationChannels);
    return c.json({ rendered: interpolateSample(template || "", channels?.emailFromName) }, 200);
  })

  // ---- render a full branded HTML email from a block design (live editor preview) ----
  .post("/email/render", requireAdmin, jsonBody(RenderBody), async (c) => {
    const { design, footer } = c.req.valid("json");
    const origin = new URL(c.req.url).origin;
    const html = await renderDesignPreview(tenantId(c), Array.isArray(design) ? (design as EmailBlock[]) : [], { footer, origin });
    return c.json({ html }, 200);
  })

  // ---- send a test email rendered from a block design ----
  .post("/email/test", requireAdmin, jsonBody(TestEmailBody), async (c) => {
    const { to, subject, design } = c.req.valid("json");
    const origin = new URL(c.req.url).origin;
    const r = await sendDesignTest(tenantId(c), to, subject || "", Array.isArray(design) ? (design as EmailBlock[]) : [], origin);
    return c.json(r, 200);
  })

  // ---- reusable email templates library ----
  .get("/email/templates", requireAdmin, async (c) => {
    const t = tx(c);
    // seed builtin starters once (per company)
    const existing = await t.select(schema.emailTemplates, eq(schema.emailTemplates.isBuiltin, true));
    if (existing.length === 0) {
      for (const s of starterDesigns()) {
        await t.insert(schema.emailTemplates, { name: s.name, description: s.description, subject: s.subject, design: JSON.stringify(s.design), isBuiltin: true });
      }
    }
    const rows = await t.select(schema.emailTemplates);
    rows.sort((a, b) =>
      (Number(b.isBuiltin) - Number(a.isBuiltin)) ||
      (new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    );
    return c.json({ templates: rows }, 200);
  })
  .post("/email/templates", requireAdmin, jsonBody(TemplateCreate), async (c) => {
    const b = c.req.valid("json");
    const [t] = await tx(c).insert(schema.emailTemplates, {
      name: b.name || "Untitled template",
      description: b.description || "",
      subject: b.subject || "",
      design: typeof b.design === "string" ? b.design : JSON.stringify(b.design || []),
      isBuiltin: false,
    });
    return c.json({ template: t }, 201);
  })
  .patch("/email/templates/:id", requireAdmin, jsonBody(TemplatePatch), async (c) => {
    const templateId = c.req.param("id");
    const b = c.req.valid("json");
    const t = tx(c);
    const existing = await t.selectOne(schema.emailTemplates, eq(schema.emailTemplates.id, templateId));
    if (!existing) return c.json({ message: "Template not found" }, 404);
    if (existing.isBuiltin) return c.json({ message: "Builtin templates can't be edited — duplicate it first" }, 400);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ["name", "description", "subject"] as const) if (b[k] !== undefined) patch[k] = b[k];
    if (b.design !== undefined)
      patch.design = typeof b.design === "string" ? b.design : JSON.stringify(b.design);
    const [row] = await t.update(schema.emailTemplates, patch as any, eq(schema.emailTemplates.id, templateId));
    return c.json({ template: row }, 200);
  })
  .delete("/email/templates/:id", requireAdmin, async (c) => {
    const t = tx(c);
    const row = await t.selectOne(schema.emailTemplates, eq(schema.emailTemplates.id, c.req.param("id")));
    if (row?.isBuiltin) return c.json({ message: "cannot delete a builtin template" }, 400);
    await t.delete(schema.emailTemplates, eq(schema.emailTemplates.id, c.req.param("id")));
    return c.json({ ok: true }, 200);
  })

  // ---- logo upload for email header (stored under /uploads, returns its URL) ----
  .post("/email/logo", requireAdmin, async (c) => {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ message: "No file" }, 400);
    if (file.size > 4 * 1024 * 1024) return c.json({ message: "Logo too large (max 4MB)" }, 400);
    if (file.type && !["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"].includes(file.type))
      return c.json({ message: `Unsupported type ${file.type}` }, 400);
    const ext = (file.name.split(".").pop() || "png").toLowerCase().slice(0, 8);
    const key = `email-logos/${crypto.randomUUID()}.${ext}`;
    const stored = await putObject(
      key,
      Buffer.from(await file.arrayBuffer()),
      file.type || "image/png",
    );
    // persist on this company's channel config
    const existing = await getOrCreateChannels(c);
    await tx(c).update(schema.notificationChannels, { emailLogoUrl: stored.url, updatedAt: new Date() }, eq(schema.notificationChannels.id, existing.id));
    return c.json({ url: stored.url }, 200);
  })

  // ---- per-company channel settings (sender identity, quiet hours, master switches) ----
  .get("/channels", requireAdmin, async (c) => {
    const row = await getOrCreateChannels(c);
    return c.json({ channels: row }, 200);
  })
  .patch("/channels", requireAdmin, jsonBody(ChannelsPatch), async (c) => {
    const b = c.req.valid("json");
    const patch: Record<string, unknown> = { ...b, updatedAt: new Date() };
    const existing = await getOrCreateChannels(c);
    const [row] = await tx(c).update(schema.notificationChannels, patch as any, eq(schema.notificationChannels.id, existing.id));
    return c.json({ channels: row }, 200);
  })

  // ---- webhooks ----
  .get("/webhooks", requireAdmin, async (c) => {
    const rows = await tx(c).select(schema.webhookEndpoints);
    rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return c.json({ webhooks: rows }, 200);
  })
  .post("/webhooks", requireAdmin, jsonBody(WebhookCreate), async (c) => {
    const b = c.req.valid("json");
    const [w] = await tx(c).insert(schema.webhookEndpoints, {
      label: b.label || "",
      url: b.url,
      secret: b.secret || "",
      events: b.events || "*",
      active: b.active ?? true,
    });
    return c.json({ webhook: w }, 201);
  })
  .patch("/webhooks/:id", requireAdmin, jsonBody(WebhookPatch), async (c) => {
    const hookId = c.req.param("id");
    const b = c.req.valid("json");
    const t = tx(c);
    const existing = await t.selectOne(schema.webhookEndpoints, eq(schema.webhookEndpoints.id, hookId));
    if (!existing) return c.json({ message: "Webhook not found" }, 404);
    const [w] = await t.update(schema.webhookEndpoints, b as any, eq(schema.webhookEndpoints.id, hookId));
    return c.json({ webhook: w }, 200);
  })
  .delete("/webhooks/:id", requireAdmin, async (c) => {
    await tx(c).delete(schema.webhookEndpoints, eq(schema.webhookEndpoints.id, c.req.param("id")));
    return c.json({ ok: true }, 200);
  })
  // test-ping a webhook
  .post("/webhooks/:id/test", requireAdmin, async (c) => {
    const w = await tx(c).selectOne(schema.webhookEndpoints, eq(schema.webhookEndpoints.id, c.req.param("id")));
    if (!w) return c.json({ message: "not found" }, 404);
    try {
      const res = await fetch(w.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(w.secret ? { "X-Webhook-Secret": w.secret } : {}) },
        body: JSON.stringify({ event: "test", message: "NVC360 webhook test", at: new Date().toISOString() }),
      });
      return c.json({ ok: res.ok, status: res.status }, 200);
    } catch (e: any) {
      return c.json({ ok: false, error: e?.message }, 200);
    }
  })

  // ---- delivery log ----
  .get("/deliveries", requireAdmin, async (c) => {
    const event = c.req.query("event");
    const t = tx(c);
    const rows = event
      ? await t.select(schema.notificationDeliveries, eq(schema.notificationDeliveries.event, event))
      : await t.select(schema.notificationDeliveries);
    rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return c.json({ deliveries: rows.slice(0, 200) }, 200);
  })

  // ---- fire a test event against a real booking ----
  .post("/test/:event", requireAdmin, jsonBody(TestEventBody), async (c) => {
    const event = c.req.param("event") as NvcEvent;
    if (!EVENT_META[event]) return c.json({ message: "unknown event" }, 404);
    const { bookingId } = c.req.valid("json");
    let bid: string | undefined = bookingId;
    if (!bid) {
      const rows = await tx(c).select(schema.bookings);
      rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      bid = rows[0]?.id;
    }
    if (!bid) return c.json({ message: "no booking to test with" }, 400);
    await fireEvent(event, bid);
    return c.json({ ok: true, event, bookingId: bid }, 200);
  })

  // ---- email sending domains (tenant self-serve) ----
  // List the active company's submitted domains (+ parsed DNS records).
  .get("/email-domains", requireAdmin, async (c) => {
    const rows = await tx(c).select(schema.tenantEmailDomains);
    const domains = rows.map((r) => ({
      ...r,
      records: safeParse(r.records),
    }));
    domains.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return c.json({ domains, resendAvailable: resendAvailable() }, 200);
  })

  // Submit a new domain for approval (status starts "pending").
  .post("/email-domains", requireAdmin, async (c) => {
    const body = await parseBody(c, z.object({ domain: shortText("Domain", 253) }));
    const raw = body.domain.toLowerCase();
    // strip scheme / path / leading "www." and any from-address local part
    const domain = raw
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/^.*@/, "")
      .replace(/^www\./, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain))
      return c.json({ message: "Enter a valid domain, e.g. mail.acme.com" }, 400);
    const existing = await tx(c).selectOne(
      schema.tenantEmailDomains,
      eq(schema.tenantEmailDomains.domain, domain),
    );
    if (existing) return c.json({ message: "Domain already submitted" }, 409);
    const user = c.get("user") as { id?: string } | undefined;
    const [row] = await tx(c).insert(schema.tenantEmailDomains, {
      domain,
      status: "pending",
      createdBy: user?.id || "",
    });
    return c.json({ domain: { ...row, records: [] } }, 201);
  })

  // Re-check verification with Resend (tenant "Check verification" button).
  .post("/email-domains/:id/check", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const row = await tx(c).selectOne(
      schema.tenantEmailDomains,
      eq(schema.tenantEmailDomains.id, id),
    );
    if (!row) return c.json({ message: "not found" }, 404);
    if (!row.resendDomainId)
      return c.json({ message: "Awaiting approval — not yet created in Resend." }, 409);
    const updated = await triggerVerify(id);
    return c.json({ domain: { ...updated, records: safeParse(updated.records) } }, 200);
  })

  // Remove a domain (tenant-scoped; also removes it from Resend).
  .delete("/email-domains/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const row = await tx(c).selectOne(
      schema.tenantEmailDomains,
      eq(schema.tenantEmailDomains.id, id),
    );
    if (!row) return c.json({ message: "not found" }, 404);
    await removeDomain(id);
    return c.json({ ok: true }, 200);
  });

function safeParse(s: string | null | undefined) {
  try {
    return JSON.parse(s || "[]");
  } catch {
    return [];
  }
}
