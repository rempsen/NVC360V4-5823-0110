import { Resend } from "resend";
import { db } from "../api/database";
import * as schema from "../api/database/schema";
import { eq } from "drizzle-orm";
import { fmtInZone } from "../shared/tz";
import { pickSender, pickRetrySender, type SenderIdentity } from "./sender";
import { verifiedDomainsForCompany } from "./email-domains";

const apiKey = process.env.RESEND_API_KEY;
const resend = apiKey ? new Resend(apiKey) : null;
const FALLBACK_FROM = "NVC360 <onboarding@resend.dev>";
const FROM = process.env.EMAIL_FROM || FALLBACK_FROM;

export interface EmailAttachment {
  filename: string;
  content: string; // utf-8 string or base64
  contentType?: string;
}

interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
}

export async function sendEmail({ to, subject, html, text, from, replyTo, attachments }: SendEmailOptions) {
  if (!resend) {
    console.log(`[email:skipped no RESEND_API_KEY] to=${to} subject="${subject}"`);
    return { ok: false, skipped: true };
  }
  try {
    const recipients = Array.isArray(to) ? to : [to];
    const sender = from || FROM;
    const att = attachments?.map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.content, "utf-8"),
      contentType: a.contentType,
    }));
    const { data, error } = await resend.emails.send({
      from: sender,
      to: recipients,
      subject,
      html,
      text: text || subject,
      ...(replyTo ? { replyTo } : {}),
      ...(att?.length ? { attachments: att } : {}),
    });
    if (error) {
      // If the custom domain isn't verified yet, fall back to Resend's
      // shared test sender so notifications still go out.
      // Compare the sender we ACTUALLY used, not the global default — a tenant
      // override could be the unverified one while EMAIL_FROM is fine.
      // Prefer the platform's own verified address over Resend's shared test
      // sender; only drop to resend.dev if that is all we have.
      const retryFrom = pickRetrySender(sender, FROM, FALLBACK_FROM);
      if (/not verified/i.test(error.message) && retryFrom) {
        console.warn(`Email domain unverified for "${sender}", retrying via ${retryFrom}`);
        const retry = await resend.emails.send({
          from: retryFrom,
          to: recipients,
          subject,
          html,
          text: text || subject,
          // replyTo must survive the retry, otherwise a customer hitting Reply
          // on the fallback lands on Resend's unmonitored test inbox.
          ...(replyTo ? { replyTo } : {}),
          ...(att?.length ? { attachments: att } : {}),
        });
        if (retry.error) {
          console.error("Email error (fallback):", retry.error.message);
          return { ok: false, error: retry.error.message };
        }
        return { ok: true, id: retry.data?.id, fallback: true };
      }
      console.error("Email error:", error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true, id: data?.id };
  } catch (e) {
    console.error("Email send failed:", e);
    return { ok: false, error: String(e) };
  }
}

// ---------- Branded HTML template ----------
const BRAND = "#06B6D4";
const INK = "#0B1120";

/**
 * Per-tenant brand identity applied to EVERY system email (password reset,
 * booking confirmations, receipts, …). The logo + name come from the company's
 * "Grab Brand Assets" data, stored on company_settings (logo, brandColor) and
 * notification_channels (emailLogoUrl, emailBrandColor). Every tenant uses the
 * same rule: their own logo sits just above their name in the email header.
 */
export interface TenantEmailBrand {
  company: string; // display name shown under the logo
  logoUrl?: string; // header logo (uploaded path like /uploads/x.png or absolute URL)
  brandColor?: string; // header gradient + button color
}

const FALLBACK_BRAND: TenantEmailBrand = { company: "NVC360", logoUrl: "", brandColor: BRAND };

export function resolveLogo(url?: string): string {
  if (!url) return "";
  if (/^https?:\/\//i.test(url) || /^data:/i.test(url)) return url;
  const origin = (process.env.WEBSITE_URL || process.env.PUBLIC_URL || "").replace(/\/$/, "");
  if (origin && url.startsWith("/")) return origin + url;
  return url;
}

/**
 * Resolve the outbound "from" address for a tenant.
 * Reads emailFromName + emailFromAddress from notification_channels (the
 * canonical per-tenant sender identity, configurable in Notifications settings).
 * Falls back to the global EMAIL_FROM env var if not configured.
 *
 * The custom address is only honoured once the tenant has VERIFIED that domain
 * (tenant_email_domains.status === "verified") — the same guard dispatch.ts
 * applies, now shared via pickSender(). Without it a tenant could type any
 * domain, including one they do not own, and have it used as the envelope From
 * on the receipt and password-reset emails.
 *
 * Returns an empty object to let sendEmail use its own default when no
 * override is allowed.
 */
export async function resolveFromAddress(companyId: string): Promise<SenderIdentity> {
  try {
    const [[chan], verified] = await Promise.all([
      db
        .select({
          emailFromName: schema.notificationChannels.emailFromName,
          emailFromAddress: schema.notificationChannels.emailFromAddress,
          emailReplyTo: schema.notificationChannels.emailReplyTo,
        })
        .from(schema.notificationChannels)
        .where(eq(schema.notificationChannels.companyId, companyId))
        .limit(1),
      verifiedDomainsForCompany(companyId).catch((): string[] => []),
    ]);
    if (!chan) return {};
    return pickSender(chan, verified);
  } catch (e) {
    console.error("resolveFromAddress failed", e);
    return {};
  }
}

/**
 * Resolve a tenant's email brand by companyId. Prefers the notification-channel
 * email identity (logo/color), falling back to the company_settings brand, then
 * to the NVC360 default. Safe to call with undefined — returns the default.
 */
export async function loadEmailBrand(companyId?: string): Promise<TenantEmailBrand> {
  if (!companyId) return FALLBACK_BRAND;
  try {
    const [chan] = await db
      .select()
      .from(schema.notificationChannels)
      .where(eq(schema.notificationChannels.companyId, companyId))
      .limit(1);
    const [cs] = await db
      .select()
      .from(schema.companySettings)
      .where(eq(schema.companySettings.companyId, companyId))
      .limit(1);
    const company = (cs?.name || "").trim() || FALLBACK_BRAND.company;
    const logoUrl = (chan?.emailLogoUrl || cs?.logo || "").trim();
    const brandColor = (chan?.emailBrandColor || cs?.brandColor || BRAND).trim();
    return { company, logoUrl, brandColor };
  } catch (e) {
    console.error("loadEmailBrand failed", e);
    return FALLBACK_BRAND;
  }
}

/** darken a hex ~30% for the gradient end-stop */
function darken(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim());
  if (!m) return "#0e7490";
  const n = parseInt(m[1], 16);
  const r = (((n >> 16) & 255) * 0.7) | 0;
  const g = (((n >> 8) & 255) * 0.7) | 0;
  const b = ((n & 255) * 0.7) | 0;
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function esc(s: string) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Branded email shell. The tenant logo (from Grab Brand Assets) is rendered at
 * the very top, just above the company name. If no logo is available we fall
 * back to the company name as styled text so the header is never empty.
 */
function shell(title: string, bodyHtml: string, cta?: { label: string; url: string }, brand: TenantEmailBrand = FALLBACK_BRAND) {
  const accent = brand.brandColor || BRAND;
  const company = brand.company || FALLBACK_BRAND.company;
  const logo = resolveLogo(brand.logoUrl);

  // Logo always sits above the name. With a logo: image + name underneath.
  // Without a logo: name only (styled), preserving the NVC360 look as fallback.
  const header = logo
    ? `<div style="text-align:center;margin-bottom:20px">
        <img src="${logo}" alt="${esc(company)}" style="height:46px;max-width:240px;display:block;margin:0 auto 8px"/>
        <div style="font-size:15px;font-weight:700;color:#fff;letter-spacing:-0.2px">${esc(company)}</div>
      </div>`
    : `<div style="text-align:center;margin-bottom:20px">
        <span style="font-size:22px;font-weight:800;color:#fff;letter-spacing:-0.5px">${esc(company)}</span>
      </div>`;

  return `<!DOCTYPE html><html><body style="margin:0;background:${INK};font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:#e2e8f0">
  <div style="max-width:560px;margin:0 auto;padding:32px 16px">
    ${header}
    <div style="background:#111a2e;border:1px solid #1e293b;border-radius:18px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.4)">
      <div style="background:linear-gradient(135deg,${accent},${darken(accent)});padding:28px 32px">
        <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700">${title}</h1>
      </div>
      <div style="padding:28px 32px;font-size:15px;line-height:1.65;color:#cbd5e1">
        ${bodyHtml}
        ${
          cta
            ? `<div style="margin-top:24px"><a href="${cta.url}" style="display:inline-block;background:${accent};color:#06121a;text-decoration:none;padding:12px 26px;border-radius:10px;font-weight:700;font-size:14px">${cta.label}</a></div>`
            : ""
        }
      </div>
    </div>
    <p style="text-align:center;color:#64748b;font-size:12px;margin-top:20px">© ${esc(company)}</p>
  </div></body></html>`;
}

function detailRow(label: string, value: string) {
  return `<tr><td style="padding:6px 0;color:#94a3b8;width:130px">${label}</td><td style="padding:6px 0;font-weight:600;color:#f1f5f9">${value}</td></tr>`;
}

interface BookingEmailData {
  customerName: string;
  serviceName: string;
  scheduledAt: Date;
  address: string;
  price: number;
  bookingId: string;
  riderName?: string;
  invoiceNumber?: string;
}

/**
 * Appointment times in email render on the COMPANY's clock, never the server's.
 * This used to be a bare toLocaleString: on a UTC host, a Winnipeg tenant's
 * 8pm job printed as the next calendar day. Unlike the in-app screens we cannot
 * know the reader's zone here, so the zone name is always shown, and so is the
 * year — an email outlives the day it was sent.
 */
const fmt = (d: Date, tz?: string | null) =>
  fmtInZone(d, tz, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

/**
 * Currency, with the symbol. The Total and Amount rows were interpolating a
 * bare `price.toFixed(2)`, so a receipt read "Amount 149.00" while the matching
 * SMS read "$149.00".
 */
export function money(n: number, currency = "USD"): string {
  const v = Number.isFinite(n) ? n : 0;
  try {
    return v.toLocaleString("en-US", { style: "currency", currency });
  } catch {
    return "$" + v.toFixed(2);
  }
}

/**
 * Join an origin and a path with exactly one slash. The old code did
 * `${appUrl}track/${id}`, which only produced a valid URL because the local
 * .env happened to end WEBSITE_URL in a slash — in an environment without one
 * every CTA button in every email pointed at "https://uberize.aitrack/...".
 */
export function emailLink(origin: string, path: string): string {
  const base = (origin || "").replace(/\/+$/, "");
  const rest = String(path || "").replace(/^\/+/, "");
  if (!base || base === "#") return "#";
  return rest ? `${base}/${rest}` : base;
}

const appUrl = process.env.WEBSITE_URL || "#";
const link = (path: string) => emailLink(appUrl, path);

/** Build an "Add to calendar" row with Google + Outlook + .ics links. */
function addToCalendar(d: BookingEmailData, brand: TenantEmailBrand = FALLBACK_BRAND, durationMins = 60) {
  const start = new Date(d.scheduledAt);
  // An unusable scheduledAt used to throw here (toISOString on Invalid Date),
  // which took the whole confirmation email down rather than just dropping the
  // calendar row. Degrade instead: no buttons, email still sends.
  if (Number.isNaN(start.getTime())) return "";
  const end = new Date(start.getTime() + durationMins * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const z = (dt: Date) =>
    dt.getUTCFullYear() + pad(dt.getUTCMonth() + 1) + pad(dt.getUTCDate()) +
    "T" + pad(dt.getUTCHours()) + pad(dt.getUTCMinutes()) + pad(dt.getUTCSeconds()) + "Z";
  const title = `${d.serviceName} appointment`;
  const details = `${brand.company || "NVC360"} service appointment${d.riderName ? ` with ${d.riderName}` : ""}.`;
  const g = `https://calendar.google.com/calendar/render?` + new URLSearchParams({
    action: "TEMPLATE", text: title, dates: `${z(start)}/${z(end)}`, details, location: d.address,
  }).toString();
  const o = `https://outlook.office.com/calendar/0/deeplink/compose?` + new URLSearchParams({
    path: "/calendar/action/compose", rru: "addevent", subject: title,
    startdt: start.toISOString(), enddt: end.toISOString(), body: details, location: d.address,
  }).toString();
  const btn = (label: string, url: string) =>
    `<a href="${url}" style="display:inline-block;background:#1e293b;border:1px solid #334155;color:#e2e8f0;text-decoration:none;padding:9px 16px;border-radius:9px;font-weight:600;font-size:13px;margin:4px 6px 4px 0">${label}</a>`;
  return `<div style="margin-top:20px;padding-top:16px;border-top:1px solid #1e293b">
      <p style="margin:0 0 8px;color:#94a3b8;font-size:13px;font-weight:600">📅 Add this appointment to your calendar</p>
      ${btn("Google Calendar", g)}${btn("Outlook", o)}
      <p style="margin:8px 0 0;color:#64748b;font-size:12px">An .ics file is also attached — open it to add to Apple Calendar or any app.</p>
    </div>`;
}

/**
 * System email templates. Every template accepts an optional tenant `brand`
 * (company name + logo from Grab Brand Assets + brand color). The brand is
 * applied uniformly via shell(), so the tenant's logo always appears at the top
 * of the email, just above their name. When no brand is passed it falls back to
 * the NVC360 default — but callers should always pass one (see loadEmailBrand).
 */
export const emailTemplates = {
  passwordReset(d: { name?: string; url: string }, brand: TenantEmailBrand = FALLBACK_BRAND, _tz?: string | null) {
    const co = brand.company || "your";
    const body = `<p>Hi ${d.name || "there"}, we received a request to reset the password for your ${esc(co)} account.</p>
      <p style="margin-top:12px">Click the button below to choose a new password. This link expires in <b>1 hour</b>.</p>
      <p style="margin-top:16px;color:#94a3b8;font-size:13px">If you didn't request this, you can safely ignore this email — your password won't change.</p>`;
    return {
      subject: `Reset your ${co} password`,
      html: shell("Password Reset", body, { label: "Reset password", url: d.url }, brand),
    };
  },
  bookingConfirmed(d: BookingEmailData, brand: TenantEmailBrand = FALLBACK_BRAND, tz?: string | null) {
    const body = `<p>Hi ${d.customerName}, your booking is <b style="color:#16a34a">confirmed</b>! 🎉</p>
      <table style="width:100%;border-collapse:collapse;margin-top:14px;font-size:14px">
        ${detailRow("Service", d.serviceName)}
        ${detailRow("When", fmt(d.scheduledAt, tz))}
        ${detailRow("Address", d.address)}
        ${detailRow("Total", money(d.price))}
      </table>
      <p style="margin-top:16px">We'll notify you the moment a professional is on the way.</p>
      ${addToCalendar(d, brand)}`;
    return {
      subject: `Booking confirmed — ${d.serviceName}`,
      html: shell("Booking Confirmed", body, { label: "View booking", url: link(`track/${d.bookingId}`) }, brand),
    };
  },
  riderAssigned(d: BookingEmailData, brand: TenantEmailBrand = FALLBACK_BRAND, tz?: string | null) {
    const body = `<p>Hi ${d.customerName}, <b>${d.riderName}</b> has been assigned to your ${d.serviceName} appointment and is on the way.</p>
      <table style="width:100%;border-collapse:collapse;margin-top:14px;font-size:14px">
        ${detailRow("Professional", d.riderName || "")}
        ${detailRow("Service", d.serviceName)}
        ${detailRow("When", fmt(d.scheduledAt, tz))}
      </table>
      <p style="margin-top:16px">Track their arrival live on the map.</p>`;
    return {
      subject: `${d.riderName} is on the way`,
      html: shell("Your Pro is On the Way", body, { label: "Track live", url: link(`track/${d.bookingId}`) }, brand),
    };
  },
  riderArrived(d: BookingEmailData, brand: TenantEmailBrand = FALLBACK_BRAND, _tz?: string | null) {
    const body = `<p>Hi ${d.customerName}, <b>${d.riderName}</b> has <b style="color:#0ea5e9">arrived</b> at your location for your ${d.serviceName} appointment.</p>`;
    return {
      subject: `${d.riderName} has arrived`,
      html: shell("Your Pro Has Arrived", body, { label: "View booking", url: link(`track/${d.bookingId}`) }, brand),
    };
  },
  jobCompleted(d: BookingEmailData, brand: TenantEmailBrand = FALLBACK_BRAND, _tz?: string | null) {
    const co = brand.company || "NVC360";
    const body = `<p>Hi ${d.customerName}, your ${d.serviceName} appointment is <b style="color:#16a34a">complete</b>. Thank you for choosing ${esc(co)}!</p>
      <p style="margin-top:12px">We'd love your feedback — rate your experience in the app.</p>`;
    return {
      subject: `Job completed — ${d.serviceName}`,
      html: shell("Service Completed", body, { label: "Leave a review", url: link("bookings") }, brand),
    };
  },
  reminder(d: BookingEmailData, brand: TenantEmailBrand = FALLBACK_BRAND, tz?: string | null) {
    const body = `<p>Hi ${d.customerName}, this is a friendly reminder about your upcoming appointment.</p>
      <table style="width:100%;border-collapse:collapse;margin-top:14px;font-size:14px">
        ${detailRow("Service", d.serviceName)}
        ${detailRow("When", fmt(d.scheduledAt, tz))}
        ${detailRow("Address", d.address)}
      </table>
      ${addToCalendar(d, brand)}`;
    return {
      subject: `Reminder: ${d.serviceName} appointment`,
      html: shell("Upcoming Appointment", body, { label: "View details", url: link(`track/${d.bookingId}`) }, brand),
    };
  },
  receipt(d: BookingEmailData, brand: TenantEmailBrand = FALLBACK_BRAND, _tz?: string | null) {
    const co = brand.company || "NVC360";
    const body = `<p>Hi ${d.customerName}, here's your receipt for ${d.serviceName}.</p>
      <table style="width:100%;border-collapse:collapse;margin-top:14px;font-size:14px">
        ${detailRow("Invoice", d.invoiceNumber || "")}
        ${detailRow("Service", d.serviceName)}
        ${detailRow("Amount", money(d.price))}
        ${detailRow("Status", "PAID ✓")}
      </table>
      <p style="margin-top:16px;color:#16a34a;font-weight:600">Payment received. Thank you!</p>`;
    return {
      subject: `Receipt ${d.invoiceNumber} — ${co}`,
      html: shell("Payment Receipt", body, { label: "View invoice", url: link("bookings") }, brand),
    };
  },
};
