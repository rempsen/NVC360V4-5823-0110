/**
 * Central event dispatch engine.
 *
 * fireEvent(event, bookingId) is the single entry point the booking lifecycle
 * calls whenever something happens. It looks up the configurable notification
 * rules (event × recipient × channel), resolves the actual recipients (client /
 * tech / office), and delivers across in-app, email, SMS, and webhook — logging
 * every delivery for the admin Notifications module.
 */
import { db } from "../api/database";
import * as schema from "../api/database/schema";
import { eq, and } from "drizzle-orm";
import { sendEmail } from "./email";
import { renderEmailDesign, designToText, type EmailBlock, type EmailBrand } from "./email-render";
import { verifiedDomainsForCompany } from "./email-domains";
import { sendSms, trackingUrl } from "./sms";
import { sendPush } from "./push";
import { applyNotificationOverrides } from "./notification-presets";
import { logJobEvent, type JobEventKind } from "./job-events";
import { propertyUrl } from "./properties";
import { runAutomations, EVENT_TO_TRIGGER } from "./automation";
import { scheduleReviewRequest } from "./reviews";

export type NvcEvent =
  | "created"
  | "assigned"
  | "accepted"
  | "declined"
  | "enroute"
  | "arrived"
  | "started"
  | "completed"
  | "cancelled"
  | "receipt";

export type Recipient = "client" | "tech" | "office";

export const EVENT_META: Record<
  NvcEvent,
  { label: string; defaultTitle: string; notifType: string }
> = {
  created: { label: "Work order created", defaultTitle: "New work order", notifType: "reminder" },
  assigned: { label: "Tech assigned", defaultTitle: "You've been assigned a job", notifType: "assigned" },
  accepted: { label: "Tech accepts", defaultTitle: "Technician accepted the job", notifType: "assigned" },
  declined: { label: "Tech declines", defaultTitle: "Technician declined the job", notifType: "reminder" },
  enroute: { label: "En route (on the way)", defaultTitle: "Your technician is on the way", notifType: "enroute" },
  arrived: { label: "Arrived", defaultTitle: "Your technician has arrived", notifType: "arrived" },
  started: { label: "Job started", defaultTitle: "Service has started", notifType: "reminder" },
  completed: { label: "Job completed", defaultTitle: "Job completed", notifType: "completed" },
  cancelled: { label: "Cancelled", defaultTitle: "Work order cancelled", notifType: "reminder" },
  receipt: { label: "Payment / receipt", defaultTitle: "Payment receipt", notifType: "receipt" },
};

/** Default SMS / push copy per event+recipient. {{vars}} interpolated. */
function defaultMessage(event: NvcEvent, recipient: Recipient, v: Vars): string {
  const co = v.company;
  switch (event) {
    case "created":
      if (recipient === "client") return `${co}: We've received your request for ${v.service}. We'll confirm a technician shortly.`;
      return `${co}: New work order #${v.shortId} — ${v.service} at ${v.address}.`;
    case "assigned":
      if (recipient === "tech") return `${co}: New job offer — ${v.service} at ${v.address} on ${v.when}. Open the app to accept or decline.`;
      if (recipient === "client") return `${co}: ${v.techName} has been assigned to your ${v.service} appointment.`;
      return `${co}: ${v.techName} assigned to work order #${v.shortId}.`;
    case "accepted":
      if (recipient === "client") return `${co}: ${v.techName} accepted your ${v.service} job and is scheduled for ${v.when}.`;
      return `${co}: ${v.techName} accepted work order #${v.shortId}.`;
    case "declined":
      return `${co}: ${v.techName} declined work order #${v.shortId}. It's back in the dispatch queue.`;
    case "enroute":
      if (recipient === "client")
        return `${co}: Your technician ${v.techName} is on the way!${v.eta ? ` ETA ~${v.eta} min.` : ""} Track live, see ETA & message them: ${v.trackUrl}`;
      return `${co}: ${v.techName} is en route to work order #${v.shortId}.`;
    case "arrived":
      if (recipient === "client") return `${co}: ${v.techName} has arrived at your location.`;
      return `${co}: ${v.techName} arrived on site for #${v.shortId}.`;
    case "started":
      if (recipient === "client") return `${co}: ${v.techName} has started your ${v.service}.`;
      return `${co}: Service started on #${v.shortId}.`;
    case "completed":
      if (recipient === "client")
        return (
          `${co}: Your ${v.service} is complete. Thank you! ` +
          `Your record (photos, work done) + feedback: ${v.trackUrl}` +
          (v.propertyUrl ? ` · Full history for this address: ${v.propertyUrl}` : "")
        );
      return `${co}: #${v.shortId} completed by ${v.techName}.`;
    case "cancelled":
      return `${co}: Work order #${v.shortId} (${v.service}) was cancelled.`;
    case "receipt":
      return `${co}: Receipt for ${v.service} — $${v.price}. Thank you!`;
  }
}

interface Vars {
  company: string;
  service: string;
  jobName: string;
  jobNumber: string;
  firstName: string;
  techName: string;
  address: string;
  when: string;
  eta: number | null;
  price: string;
  shortId: string;
  trackUrl: string;
  bookingUrl: string;
  workerNoun: string;
  /** Permanent, no-login property service-history hub. "" when unlinked. */
  propertyUrl: string;
}

function interpolate(tpl: string, v: Vars): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => String((v as any)[k] ?? ""));
}

/** Variables available to template authors, with descriptions (for the editor UI). */
export const TEMPLATE_VARS: { key: keyof Vars; label: string }[] = [
  { key: "company", label: "Company name" },
  { key: "firstName", label: "Customer first name" },
  { key: "jobName", label: "Job name" },
  { key: "jobNumber", label: "Job number" },
  { key: "service", label: "Service name" },
  { key: "techName", label: "Technician name" },
  { key: "address", label: "Job address" },
  { key: "when", label: "Scheduled date/time" },
  { key: "eta", label: "ETA (minutes)" },
  { key: "price", label: "Price" },
  { key: "shortId", label: "Work order # (short)" },
  { key: "trackUrl", label: "Live tracking link" },
  { key: "bookingUrl", label: "Booking link" },
  { key: "propertyUrl", label: "Property service-history link" },
];

/** Sample values used for live preview in the template editor. */
const SAMPLE_VARS: Vars = {
  company: "NVC 360",
  service: "Furnace Tune-Up",
  jobName: "Furnace Tune-Up",
  jobNumber: "A1B2C3",
  firstName: "Alex",
  techName: "Jordan Lee",
  address: "423 Main Street, Winnipeg",
  when: "Jun 4, 2:30 PM",
  eta: 12,
  price: "149.00",
  shortId: "A1B2C3",
  trackUrl: "https://nvc360.app/t/abc123",
  bookingUrl: "https://nvc360.app/t/abc123",
  workerNoun: "Technician",
  propertyUrl: "https://nvc360.app/p/abc123def456",
};

/** Default copy for a given event+recipient (exposed so the editor can show/restore it). */
export function defaultTemplateFor(event: NvcEvent, recipient: Recipient): string {
  return defaultMessage(event, recipient, SAMPLE_VARS);
}

/** Render a template against sample data for preview. Empty => empty.
 *  `company` overrides SAMPLE_VARS.company so previews reflect the active
 *  tenant (e.g. "BMD Materials") instead of always showing "NVC 360". */
export function interpolateSample(tpl: string, company?: string): string {
  return interpolate(tpl, company ? { ...SAMPLE_VARS, company } : SAMPLE_VARS);
}

/**
 * Resolve the per-company notification channel config row, creating it lazily.
 * Tenancy: notification_channels is one-row-per-company (companyId is the key);
 * the legacy `id="default"` singleton is gone.
 */
async function channelConfig(companyId: string) {
  const [cfg] = await db
    .select()
    .from(schema.notificationChannels)
    .where(eq(schema.notificationChannels.companyId, companyId));
  return cfg;
}

/** Render a full branded email design against sample data — for the live editor preview. */
export async function renderDesignPreview(companyId: string, blocks: EmailBlock[], opts?: { footer?: string; origin?: string }): Promise<string> {
  const cfg = await channelConfig(companyId);
  const companyName = cfg?.emailFromName || SAMPLE_VARS.company;
  // {{company}} inside block text/tokens must reflect the ACTIVE tenant, not the
  // hardcoded sample — otherwise switching tenants (e.g. NVC360 -> BMD Materials)
  // leaves stale copy like "reply to this email, NVC360" in another company's emails.
  const vars: Vars = { ...SAMPLE_VARS, company: companyName };
  const brand: EmailBrand = {
    company: companyName,
    logoUrl: cfg?.emailLogoUrl || "",
    brandColor: cfg?.emailBrandColor || "#06B6D4",
    headerStyle: (cfg?.emailHeaderStyle as any) || "gradient",
    bgColor: cfg?.emailBgColor || "#f1f5f9",
    footer: opts?.footer ?? cfg?.emailFooter ?? "",
    origin: opts?.origin || "",
  };
  return renderEmailDesign(blocks || [], brand, (s) => interpolate(s, vars));
}

/** Send a one-off test email rendered from a block design. */
export async function sendDesignTest(companyId: string, to: string, subject: string, blocks: EmailBlock[], origin?: string): Promise<{ ok: boolean; error?: string; skipped?: boolean }> {
  const cfg = await channelConfig(companyId);
  const companyName = cfg?.emailFromName || SAMPLE_VARS.company;
  const vars: Vars = { ...SAMPLE_VARS, company: companyName };
  const brand: EmailBrand = {
    company: companyName,
    logoUrl: cfg?.emailLogoUrl || "",
    brandColor: cfg?.emailBrandColor || "#06B6D4",
    headerStyle: (cfg?.emailHeaderStyle as any) || "gradient",
    bgColor: cfg?.emailBgColor || "#f1f5f9",
    footer: cfg?.emailFooter || "",
    origin: origin || "",
  };
  const interp = (s: string) => interpolate(s, vars);
  const html = renderEmailDesign(blocks || [], brand, interp);
  const text = designToText(blocks || [], interp);
  let emailFrom: string | undefined;
  if (cfg?.emailFromAddress) {
    const fromDomain = cfg.emailFromAddress.split("@")[1]?.toLowerCase() || "";
    const verified = await verifiedDomainsForCompany(companyId).catch((): string[] => []);
    if (fromDomain && verified.includes(fromDomain))
      emailFrom = `${cfg.emailFromName || SAMPLE_VARS.company} <${cfg.emailFromAddress}>`;
  }
  const subj = interp(subject || `${brand.company}: test email`);
  const r: any = await sendEmail({ to, subject: `[TEST] ${subj}`, html, text, from: emailFrom, replyTo: cfg?.emailReplyTo || undefined }).catch((e) => ({ error: e?.message }));
  if (r?.skipped) return { ok: false, skipped: true };
  if (r?.error) return { ok: false, error: r.error };
  return { ok: true };
}

/** Check whether a channel is globally enabled + outside quiet hours (best-effort). */
export async function channelAllowed(companyId: string, channel: "inApp" | "email" | "sms" | "webhook"): Promise<boolean> {
  const cfg = await channelConfig(companyId);
  if (!cfg) return true;
  const master: Record<string, boolean> = {
    inApp: cfg.inAppEnabled, email: cfg.emailEnabled, sms: cfg.smsEnabled, webhook: cfg.webhookEnabled,
  };
  if (!master[channel]) return false;
  if (cfg.quietHoursEnabled && cfg.quietChannels.split(",").map((s) => s.trim()).includes(channel)) {
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = cfg.quietStart.split(":").map(Number);
    const [eh, em] = cfg.quietEnd.split(":").map(Number);
    const start = sh * 60 + sm, end = eh * 60 + em;
    const inQuiet = start <= end ? cur >= start && cur < end : cur >= start || cur < end;
    if (inQuiet) return false;
  }
  return true;
}

async function logDelivery(row: {
  companyId: string;
  event: string;
  bookingId?: string;
  recipient: Recipient;
  channel: string;
  target?: string;
  status?: string;
  detail?: string;
}) {
  try {
    await db.insert(schema.notificationDeliveries).values({
      companyId: row.companyId,
      event: row.event,
      bookingId: row.bookingId ?? null,
      recipient: row.recipient,
      channel: row.channel,
      target: row.target ?? "",
      status: row.status ?? "sent",
      detail: row.detail ?? "",
    });
  } catch (e) {
    console.error("[dispatch] log failed", e);
  }
}

/** Resolve everything we need to message about a booking. Tenant is the booking's companyId. */
async function context(bookingId: string) {
  const [b] = await db.select().from(schema.bookings).where(eq(schema.bookings.id, bookingId));
  if (!b) return null;
  const companyId = b.companyId;
  const [svc] = await db.select().from(schema.services).where(eq(schema.services.id, b.serviceId));
  const [cust] = await db.select().from(schema.user).where(eq(schema.user.id, b.customerId));
  let rider: any = null;
  let riderUser: any = null;
  if (b.riderId) {
    [rider] = await db.select().from(schema.riders).where(eq(schema.riders.id, b.riderId));
    if (rider) [riderUser] = await db.select().from(schema.user).where(eq(schema.user.id, rider.userId));
  }
  const [co] = await db.select().from(schema.companySettings).where(eq(schema.companySettings.companyId, companyId));
  const when = b.scheduledAt
    ? new Date(b.scheduledAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "TBD";
  // Best-effort: the property hub link is a nice-to-have, never a reason to
  // fail a notification.
  let propToken = "";
  try {
    if (b.propertyId) {
      const [prop] = await db
        .select()
        .from(schema.properties)
        .where(eq(schema.properties.id, b.propertyId));
      propToken = prop?.publicToken ?? "";
    }
  } catch {
    /* ignore */
  }
  const vars: Vars = {
    company: co?.name || "NVC360",
    service: svc?.name || b.title || "service",
    jobName: b.title || svc?.name || "service",
    jobNumber: b.id.slice(0, 6).toUpperCase(),
    firstName: (cust?.name || "").trim().split(/\s+/)[0] || "there",
    techName: riderUser?.name || "your technician",
    address: b.address || "",
    when,
    eta: b.etaMins ?? null,
    price: (b.price ?? 0).toFixed(2),
    shortId: b.id.slice(0, 6).toUpperCase(),
    trackUrl: trackingUrl(b.publicToken),
    bookingUrl: trackingUrl(b.publicToken),
    workerNoun: co?.workerNoun || "Technician",
    propertyUrl: propToken ? propertyUrl(propToken) : "",
  };
  return { b, companyId, svc, cust, rider, riderUser, co, vars };
}

/** Find admin/office users to notify within a company. */
async function officeUsers(companyId: string) {
  return db
    .select()
    .from(schema.user)
    .where(and(eq(schema.user.role, "admin"), eq(schema.user.companyId, companyId)));
}

async function activeWebhooks(companyId: string, event: string) {
  const eps = await db
    .select()
    .from(schema.webhookEndpoints)
    .where(and(eq(schema.webhookEndpoints.active, true), eq(schema.webhookEndpoints.companyId, companyId)));
  return eps.filter((e) => e.events === "*" || e.events.split(",").map((s) => s.trim()).includes(event));
}

/**
 * Fire all configured notifications for an event on a booking.
 * Safe to await; individual channel failures are logged, never thrown.
 */
export async function fireEvent(event: NvcEvent, bookingId: string) {
  try {
    const ctx = await context(bookingId);
    if (!ctx) return;
    const { b, companyId, cust, rider, riderUser, vars } = ctx;

    // Append to the job's permanent timeline. Every lifecycle event in the
    // system funnels through fireEvent, so this single call is what gives the
    // customer-facing timeline and the permanent job record their history.
    // Visibility policy lives in job-events.ts, not here.
    await logJobEvent({
      companyId,
      bookingId: b.id,
      kind: event as JobEventKind,
      actorRole: event === "accepted" || event === "declined" ? "tech" : "system",
      actorName: riderUser?.name || "",
      detail:
        event === "declined" && b.declineReason ? b.declineReason : "",
      meta: { status: b.status, service: vars.service },
    });

    // Automation rules + the post-completion review ask. Both are strictly
    // best-effort side effects: a failure here must never stop the real
    // notifications below from going out.
    try {
      const trigger = EVENT_TO_TRIGGER[event];
      if (trigger) {
        await runAutomations(trigger, {
          companyId,
          bookingId: b.id,
          vars: {
            ...(vars as unknown as Record<string, string | number | null>),
            customerName: cust?.name ?? "",
            customerPhone: b.customerPhone || cust?.phone || "",
            token: b.publicToken,
          },
          facts: {
            priority: b.priority,
            service: vars.service,
            status: b.status,
            region: b.region,
          },
        });
      }
      if (event === "completed") await scheduleReviewRequest(b.id);
    } catch (e) {
      console.error("[dispatch] automation/review hook failed", e);
    }

    const rules = await db
      .select()
      .from(schema.notificationRules)
      .where(and(
        eq(schema.notificationRules.companyId, companyId),
        eq(schema.notificationRules.event, event),
        eq(schema.notificationRules.enabled, true),
      ));

    // per-company channel gates (master switches + quiet hours)
    const [allowInApp, allowEmail, allowSms, allowWebhook] = await Promise.all([
      channelAllowed(companyId, "inApp"), channelAllowed(companyId, "email"), channelAllowed(companyId, "sms"), channelAllowed(companyId, "webhook"),
    ]);
    // sender identity from channel config
    const chanCfg = await channelConfig(companyId);
    // Only honor a tenant's custom from-address if its domain is verified in
    // Resend. Otherwise fall through to undefined so email.ts uses its safe
    // shared sender (onboarding@resend.dev) and mail still goes out.
    let emailFrom: string | undefined;
    if (chanCfg?.emailFromAddress) {
      const fromDomain = chanCfg.emailFromAddress.split("@")[1]?.toLowerCase() || "";
      const verified = await verifiedDomainsForCompany(companyId).catch((): string[] => []);
      if (fromDomain && verified.includes(fromDomain)) {
        emailFrom = `${chanCfg.emailFromName || vars.company} <${chanCfg.emailFromAddress}>`;
      }
    }
    const emailReplyTo = chanCfg?.emailReplyTo || undefined;
    const emailFooter = chanCfg?.emailFooter || "";
    const emailBrand: EmailBrand = {
      company: vars.company,
      logoUrl: chanCfg?.emailLogoUrl || "",
      brandColor: chanCfg?.emailBrandColor || "#06B6D4",
      headerStyle: (chanCfg?.emailHeaderStyle as any) || "gradient",
      bgColor: chanCfg?.emailBgColor || "#f1f5f9",
      footer: emailFooter,
      origin: process.env.WEBSITE_URL || process.env.APP_URL || process.env.PUBLIC_URL || "",
    };
    const interp = (s: string) => interpolate(s, vars);

    for (const rule of rules) {
      const recipient = rule.recipient as Recipient;
      const msg = rule.template ? interpolate(rule.template, vars) : defaultMessage(event, recipient, vars);
      const meta = EVENT_META[event];

      // resolve targets per recipient
      let targets: { userId?: string; email?: string; phone?: string; name: string }[] = [];
      if (recipient === "client" && cust) {
        targets = [{ userId: cust.id, email: cust.email, phone: b.customerPhone || (cust as any).phone || "", name: cust.name }];
      } else if (recipient === "tech" && rider && riderUser) {
        targets = [{ userId: riderUser.id, email: riderUser.email, phone: rider.phone || (riderUser as any).phone || "", name: riderUser.name }];
      } else if (recipient === "office") {
        const admins = await officeUsers(companyId);
        targets = admins.map((a) => ({ userId: a.id, email: a.email, phone: (a as any).phone || "", name: a.name }));
      }

      for (const t of targets) {
        // in-app
        if (rule.inApp && allowInApp && t.userId) {
          await db.insert(schema.notifications).values({
            companyId,
            userId: t.userId,
            bookingId: b.id,
            type: meta.notifType,
            title: meta.defaultTitle,
            body: msg,
          });
          // Push to the recipient's devices (fire-and-forget). The tech app
          // relies on this for job assignment / enroute alerts when backgrounded.
          sendPush(t.userId, meta.defaultTitle, msg, {
            type: meta.notifType,
            event,
            bookingId: b.id,
          }).catch(() => {});
          await logDelivery({ companyId, event, bookingId: b.id, recipient, channel: "in_app", target: t.userId, status: "sent" });
        }
        // email — use the rich block design when present, else the legacy text template
        if (rule.email && allowEmail && t.email) {
          let html: string;
          let text: string | undefined;
          let design: EmailBlock[] | null = null;
          if (rule.emailDesign) {
            try { design = JSON.parse(rule.emailDesign); } catch { design = null; }
          }
          if (design && Array.isArray(design) && design.length) {
            html = renderEmailDesign(design, emailBrand, interp);
            text = designToText(design, interp);
          } else {
            html = emailHtml(meta.defaultTitle, msg, vars, emailFooter, emailBrand);
            text = msg;
          }
          const subject = rule.emailSubject ? interp(rule.emailSubject) : `${vars.company}: ${meta.label}`;
          const r = await sendEmail({ to: t.email, subject, html, text, from: emailFrom, replyTo: emailReplyTo }).catch((e) => ({ ok: false, error: e?.message }));
          await logDelivery({ companyId, event, bookingId: b.id, recipient, channel: "email", target: t.email, status: (r as any)?.ok === false ? "failed" : "sent", detail: (r as any)?.error || "" });
        }
        // sms
        if (rule.sms && allowSms && t.phone) {
          const r = await sendSms(t.phone, msg);
          await logDelivery({ companyId, event, bookingId: b.id, recipient, channel: "sms", target: t.phone, status: r.ok ? "sent" : r.skipped ? "skipped" : "failed", detail: r.error || (r.skipped ? "sms not configured" : r.sid || "") });
        }
      }

      // webhook (fire once per rule that enables it)
      if (rule.webhook && allowWebhook) {
        const eps = await activeWebhooks(companyId, event);
        for (const ep of eps) {
          const payload = {
            event,
            recipient,
            bookingId: b.id,
            shortId: vars.shortId,
            status: b.status,
            service: vars.service,
            tech: vars.techName,
            address: b.address,
            scheduledAt: b.scheduledAt,
            trackUrl: vars.trackUrl,
            message: msg,
            at: new Date().toISOString(),
          };
          try {
            const res = await fetch(ep.url, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...(ep.secret ? { "X-Webhook-Secret": ep.secret } : {}) },
              body: JSON.stringify(payload),
            });
            await logDelivery({ companyId, event, bookingId: b.id, recipient, channel: "webhook", target: ep.url, status: res.ok ? "sent" : "failed", detail: `HTTP ${res.status}` });
          } catch (e: any) {
            await logDelivery({ companyId, event, bookingId: b.id, recipient, channel: "webhook", target: ep.url, status: "failed", detail: e?.message || "error" });
          }
        }
      }
    }
  } catch (e) {
    console.error("[dispatch] fireEvent failed", event, e);
  }
}

/** Make a stored/relative logo URL absolute so email clients can load it. */
function absUrl(url: string): string {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  const base = (process.env.APP_URL || process.env.WEBSITE_URL || "").replace(/\/$/, "");
  return base ? `${base}${url.startsWith("/") ? "" : "/"}${url}` : url;
}

function emailHtml(
  title: string,
  msg: string,
  v: Vars,
  footer = "",
  brand?: EmailBrand,
): string {
  const color = brand?.brandColor || "#06B6D4";
  const logo = absUrl(brand?.logoUrl || "");
  // Header: tenant logo when we have one, else the company name wordmark.
  const header = logo
    ? `<img src="${logo}" alt="${v.company}" style="max-height:40px;max-width:200px;display:block" />`
    : `<div style="color:#fff;font-size:18px;font-weight:800">${v.company}</div>`;
  const headerBg = logo
    ? "#ffffff"
    : `linear-gradient(135deg,${color},${color})`;
  const headerBorder = logo ? `border-bottom:3px solid ${color};` : "";
  return `<div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#fff">
    <div style="background:${headerBg};${headerBorder}border-radius:16px 16px 0 0;padding:20px 24px">
      ${header}
    </div>
    <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 16px 16px;padding:24px">
      <h2 style="margin:0 0 12px;font-size:18px;color:#0f172a">${title}</h2>
      <p style="font-size:14px;line-height:1.6;color:#334155;margin:0">${msg}</p>
      <a href="${v.trackUrl}" style="display:inline-block;margin-top:18px;background:${color};color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 20px;border-radius:10px">View details</a>
      <p style="margin-top:20px;font-size:12px;color:#94a3b8">${v.service} · ${v.when}${v.address ? ` · ${v.address}` : ""}</p>
      ${footer ? `<div style="margin-top:16px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:12px;line-height:1.5;color:#94a3b8">${footer}</div>` : ""}
    </div>
  </div>`;
}

/**
 * Build a branded email footer (HTML) from a company's contact details.
 * Goes at the bottom of every outgoing email: legal/business name, address,
 * phone, email — so clients always know who's contacting them and how to reach
 * the tenant company back.
 */
export function buildEmailFooter(input: {
  name?: string;
  legalName?: string;
  address?: string;
  phone?: string;
  email?: string;
  website?: string;
}): string {
  const who = (input.legalName || input.name || "").trim();
  const lines: string[] = [];
  if (who) lines.push(`<strong style="color:#475569">${who}</strong>`);
  const contact: string[] = [];
  if (input.address?.trim()) contact.push(input.address.trim());
  if (input.phone?.trim()) contact.push(input.phone.trim());
  if (input.email?.trim())
    contact.push(
      `<a href="mailto:${input.email.trim()}" style="color:inherit">${input.email.trim()}</a>`,
    );
  if (contact.length) lines.push(contact.join(" &nbsp;·&nbsp; "));
  if (input.website?.trim()) {
    const w = input.website.trim();
    const href = /^https?:\/\//i.test(w) ? w : `https://${w}`;
    const label = w.replace(/^https?:\/\//i, "").replace(/\/$/, "");
    lines.push(`<a href="${href}" style="color:inherit">${label}</a>`);
  }
  return lines.join("<br/>");
}

/**
 * Auto-provision a tenant's notification channel identity from its (possibly
 * AI-scraped) brand. This is what makes outgoing email + SMS instantly feel
 * like *their* company: logo in the header, brand color theming, a footer with
 * their address/phone/email, and a sender name = their company name.
 *
 * Idempotent: only writes the row if one doesn't already exist for the tenant.
 */
export async function provisionNotificationBranding(input: {
  companyId: string;
  name: string;
  logoUrl?: string;
  brandColor?: string;
  legalName?: string;
  address?: string;
  phone?: string;
  email?: string;
  website?: string;
}) {
  const [existing] = await db
    .select()
    .from(schema.notificationChannels)
    .where(eq(schema.notificationChannels.companyId, input.companyId));
  const footer = buildEmailFooter(input);
  const values = {
    emailFromName: input.name || "NVC 360",
    emailReplyTo: input.email?.trim() || "",
    emailFooter: footer,
    emailLogoUrl: input.logoUrl?.trim() || "",
    emailBrandColor: input.brandColor?.trim() || "#06B6D4",
    updatedAt: new Date(),
  };
  if (existing) {
    await db
      .update(schema.notificationChannels)
      .set(values)
      .where(eq(schema.notificationChannels.id, existing.id));
  } else {
    await db.insert(schema.notificationChannels).values({
      id: input.companyId,
      companyId: input.companyId,
      ...values,
    });
  }
}

/** Seed the default rule matrix on first run for a company (idempotent). */
export async function seedNotificationRules(companyId: string) {
  const existing = await db
    .select()
    .from(schema.notificationRules)
    .where(eq(schema.notificationRules.companyId, companyId))
    .limit(1);
  if (existing.length) return;
  // sensible defaults, then adjusted per-ICP (see notification-presets.ts)
  const base: { event: NvcEvent; recipient: Recipient; inApp: boolean; email: boolean; sms: boolean; webhook: boolean }[] = [
    { event: "created", recipient: "office", inApp: true, email: false, sms: false, webhook: false },
    { event: "created", recipient: "client", inApp: true, email: true, sms: false, webhook: false },
    { event: "assigned", recipient: "tech", inApp: true, email: true, sms: true, webhook: false },
    { event: "assigned", recipient: "client", inApp: true, email: true, sms: false, webhook: false },
    { event: "accepted", recipient: "office", inApp: true, email: false, sms: false, webhook: false },
    { event: "accepted", recipient: "client", inApp: true, email: false, sms: false, webhook: false },
    { event: "declined", recipient: "office", inApp: true, email: true, sms: false, webhook: false },
    { event: "enroute", recipient: "client", inApp: true, email: true, sms: true, webhook: false },
    { event: "arrived", recipient: "client", inApp: true, email: true, sms: true, webhook: false },
    { event: "started", recipient: "client", inApp: true, email: false, sms: false, webhook: false },
    { event: "completed", recipient: "client", inApp: true, email: true, sms: false, webhook: false },
    { event: "completed", recipient: "office", inApp: true, email: false, sms: false, webhook: false },
    { event: "cancelled", recipient: "office", inApp: true, email: false, sms: false, webhook: false },
    { event: "cancelled", recipient: "client", inApp: true, email: true, sms: false, webhook: false },
    { event: "receipt", recipient: "client", inApp: true, email: true, sms: false, webhook: false },
  ];
  const [company] = await db
    .select({ industry: schema.companies.industry })
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId))
    .limit(1);
  const defaults = applyNotificationOverrides(base, company?.industry);
  for (const d of defaults) {
    await db.insert(schema.notificationRules).values({ ...d, companyId });
  }
  console.log("[dispatch] seeded", defaults.length, "notification rules for", companyId, "(industry:", company?.industry || "none", ")");
}
