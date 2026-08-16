/**
 * Twilio SMS service — real send via Twilio REST API (no SDK, just fetch).
 * Gracefully no-ops (logs only) when env is not configured.
 */

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const FROM = process.env.TWILIO_FROM_NUMBER;

// API Key auth (preferred): SK SID + Secret for Basic auth, AC Account SID in URL.
const API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;
// Legacy: Auth Token used directly with Account SID for Basic auth.
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

// Username:password pair used for Basic auth.
const BASIC_USER = API_KEY_SID || ACCOUNT_SID;
const BASIC_PASS = API_KEY_SECRET || AUTH_TOKEN;

export const smsConfigured = Boolean(ACCOUNT_SID && FROM && BASIC_USER && BASIC_PASS);

export interface SmsResult {
  ok: boolean;
  sid?: string;
  skipped?: boolean;
  error?: string;
}

/** Normalize a phone number to E.164-ish (very light). */
function normalize(phone: string): string {
  const p = phone.trim();
  if (p.startsWith("+")) return p;
  const digits = p.replace(/[^0-9]/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return "+" + digits;
}

/**
 * Characters that force the whole message out of GSM-7 (and so out of a
 * 160-character segment into a 70-character one) but have a lossless ASCII
 * equivalent. Measured across the built-in copy: "—" appeared in 17 messages
 * and "·" in one, which was enough to make routine 145-character notices cost
 * three segments instead of one.
 *
 * Applied at the send boundary so tenant-authored templates and company names
 * are covered too, not just the strings in dispatch.ts.
 */
const GSM_SUBSTITUTIONS: [RegExp, string][] = [
  [/[—–‒―]/g, "-"], // em/en/figure/horizontal dash
  [/[·•]/g, "|"], // middle dot, bullet — used as separators
  [/[‘’‛′]/g, "'"], // curly single quotes, prime
  [/[“”‟″]/g, '"'], // curly double quotes
  [/…/g, "..."], // ellipsis
  [/[      ]/g, " "], // no-break / thin spaces
  [/→/g, "->"],
  [/«/g, '"'],
  [/»/g, '"'],
];

/**
 * Normalise punctuation that needlessly forces UCS-2 encoding.
 * Emoji and genuinely accented letters are left alone — there is no lossless
 * substitute, and mangling a customer's name to save a segment is not a trade
 * worth making.
 */
export function toGsm7(body: string): string {
  let out = String(body ?? "");
  for (const [re, to] of GSM_SUBSTITUTIONS) out = out.replace(re, to);
  return out;
}

// GSM-7 alphabet. Characters in the extended table cost two septets each.
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€";

/**
 * How many segments a body actually bills as. Used for cost visibility in the
 * copy review; kept here next to the alphabet it depends on.
 */
export function smsSegments(body: string): number {
  const s = String(body ?? "");
  let septets = 0;
  for (const ch of s) {
    if (GSM_BASIC.includes(ch)) septets += 1;
    else if (GSM_EXTENDED.includes(ch)) septets += 2;
    else return s.length <= 70 ? 1 : Math.ceil(s.length / 67); // UCS-2
  }
  return septets <= 160 ? 1 : Math.ceil(septets / 153);
}

export async function sendSms(to: string, body: string): Promise<SmsResult> {
  if (!smsConfigured) {
    console.log(`[sms:skip] would text ${to}: ${toGsm7(body)}`);
    return { ok: false, skipped: true };
  }
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`;
    const params = new URLSearchParams({
      To: normalize(to),
      From: FROM!,
      // Normalised so a stray em dash does not triple the segment count.
      Body: toGsm7(body),
    });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${BASIC_USER}:${BASIC_PASS}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const json: any = await res.json();
    if (!res.ok) {
      console.error("[sms:error]", json?.message ?? res.status);
      return { ok: false, error: json?.message ?? `HTTP ${res.status}` };
    }
    console.log(`[sms:sent] ${to} sid=${json.sid}`);
    return { ok: true, sid: json.sid };
  } catch (e: any) {
    console.error("[sms:exception]", e?.message);
    return { ok: false, error: e?.message };
  }
}

const SITE = (process.env.WEBSITE_URL || process.env.APP_URL || "http://localhost:4200").replace(/\/$/, "");

export function trackingUrl(token: string): string {
  return `${SITE}/t/${token}`;
}

/** "Tech on the way" message with live tracking link. */
export function enrouteSms(opts: {
  techName: string;
  token: string;
  etaMins?: number | null;
  company?: string;
}): string {
  const eta = opts.etaMins ? ` ETA ~${opts.etaMins} min.` : "";
  const co = opts.company || "NVC360";
  return `${co}: Your technician ${opts.techName} is on the way!${eta} Track live, see ETA & message them: ${trackingUrl(opts.token)}`;
}
