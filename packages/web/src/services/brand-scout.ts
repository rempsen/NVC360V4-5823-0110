/**
 * Brand Scout — the AI onboarding engine behind "Grab Brand Assets".
 *
 * Given a company website, it:
 *   1. fetches the homepage HTML
 *   2. captures a full-page screenshot (headless Chrome)
 *   3. runs a vision model over the screenshot for brand COLORS + LOGO presence
 *   4. runs a text model over the HTML for worker-noun, tagline, services,
 *      hours, address, contact info, socials
 *   5. resolves the best logo candidate and hosts it on our own storage
 *
 * Everything degrades gracefully: if the site blocks us, JS-walls its content,
 * or a model call fails, we return whatever partial data we have so the admin
 * can finish by hand on the review screen.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateObject } from "ai";
import { z } from "zod";
import { gateway, MODELS } from "../api/agent/gateway";
import { putObject } from "../api/lib/storage";
import { log } from "../api/lib/logger";
import { INDUSTRY_LABELS } from "./industry-presets";

export interface BrandProposal {
  website: string;
  primaryColor: string | null;
  accentColor: string | null;
  logoUrl: string | null; // hosted on our storage (absolute), ready for emails
  logoSourceUrl: string | null; // where we found it on their site
  workerNoun: string | null;
  workerNounPlural: string | null;
  customerNoun: string | null;
  customerNounPlural: string | null;
  jobNoun: string | null;
  jobNounPlural: string | null;
  tagline: string | null;
  description: string | null;
  services: string[];
  hours: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
  socials: Record<string, string>;
  // AI's best guess at which Primary Industry (ICP) preset fits this
  // business, from the same page-read pass that pulls terminology/services —
  // no extra model call. The admin reviews/overrides on the New Company form.
  suggestedIndustry: string | null; // one of INDUSTRY_LABELS ids, or "other"
  suggestedIndustryOther: string | null; // free-text guess when "other"
  suggestedIndustryRationale: string | null; // one short sentence why
  warnings: string[];
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Normalise a user-typed website into a fetchable absolute URL. */
export function normalizeUrl(raw: string): string {
  let u = (raw || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  try {
    return new URL(u).toString();
  } catch {
    return "";
  }
}

function absolutize(base: string, href: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

async function fetchHtml(
  url: string,
): Promise<{ html: string; finalUrl: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    return { html, finalUrl: res.url || url };
  } catch (e) {
    log.warn("brand-scout: fetch failed", { url, err: String(e) });
    return null;
  }
}

/** Capture a homepage screenshot with headless Chrome. Returns PNG bytes. */
async function screenshot(url: string): Promise<Buffer | null> {
  let dir = "";
  try {
    dir = await mkdtemp(join(tmpdir(), "bscout-"));
    const out = join(dir, "shot.png");
    const bin = process.env.CHROME_BIN || "google-chrome";
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--window-size=1280,1600",
      "--virtual-time-budget=8000",
      `--screenshot=${out}`,
      url,
    ];
    await new Promise<void>((resolve, reject) => {
      const p = spawn(bin, args, { stdio: "ignore" });
      const timer = setTimeout(() => {
        p.kill("SIGKILL");
        reject(new Error("screenshot timeout"));
      }, 30_000);
      p.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      p.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    return await readFile(out);
  } catch (e) {
    log.warn("brand-scout: screenshot failed", { url, err: String(e) });
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Pick logo candidate URLs from the raw HTML, best-first. We look at
 * <link rel="icon">, og:image, apple-touch-icon, and <img> tags whose
 * attributes mention "logo". All resolved to absolute URLs.
 */
function logoCandidates(html: string, base: string): string[] {
  const out: string[] = [];
  const push = (href?: string | null) => {
    if (!href) return;
    const abs = absolutize(base, href);
    if (abs && !out.includes(abs)) out.push(abs);
  };

  // <img ... logo ...>
  const imgRe = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html))) {
    const tag = m[0];
    if (/logo/i.test(tag)) {
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      push(src);
    }
  }
  // og:image
  const og =
    /<meta[^>]+property\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["']/i.exec(
      html,
    )?.[1] ||
    /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:image["']/i.exec(
      html,
    )?.[1];
  push(og);
  // apple-touch-icon + icon links
  const linkRe = /<link\b[^>]*>/gi;
  while ((m = linkRe.exec(html))) {
    const tag = m[0];
    if (/rel\s*=\s*["'][^"']*(apple-touch-icon|icon)[^"']*["']/i.test(tag)) {
      const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      push(href);
    }
  }
  return out;
}

/** Strip tags/scripts to give the text model a clean-ish content sample. */
function textSample(html: string): string {
  const head = html.slice(0, 60_000);
  return head
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12_000);
}

/** Download a remote image and host it on our storage. Returns hosted URL. */
async function hostLogo(
  candidates: string[],
  companyId: string,
): Promise<{ url: string; source: string } | null> {
  for (const src of candidates.slice(0, 6)) {
    try {
      const res = await fetch(src, {
        headers: { "user-agent": UA },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const ct = res.headers.get("content-type") || "";
      if (!/image\//i.test(ct) && !/\.(png|jpe?g|svg|webp|gif)$/i.test(src))
        continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength < 200) continue; // junk / 1px
      if (buf.byteLength > 5_000_000) continue; // too big to embed in email
      const ext =
        ct.includes("svg") || /\.svg/i.test(src)
          ? "svg"
          : ct.includes("png") || /\.png/i.test(src)
            ? "png"
            : ct.includes("webp") || /\.webp/i.test(src)
              ? "webp"
              : "jpg";
      const key = `brand/${companyId}/logo-${Date.now()}.${ext}`;
      const stored = await putObject(
        key,
        buf,
        ct || `image/${ext === "jpg" ? "jpeg" : ext}`,
      );
      return { url: stored.url, source: src };
    } catch {
      // try next candidate
    }
  }
  return null;
}

const VisionSchema = z.object({
  primaryColor: z
    .string()
    .describe("Dominant brand hex color, e.g. #1e3932")
    .nullable(),
  accentColor: z
    .string()
    .describe("Secondary/accent hex color used for buttons or highlights")
    .nullable(),
});

const INDUSTRY_ID_LIST = INDUSTRY_LABELS.map((i) => i.id) as [string, ...string[]];

const TextSchema = z.object({
  companyDescription: z
    .string()
    .describe("One or two sentences on what the business does")
    .nullable(),
  tagline: z.string().describe("Marketing slogan if present").nullable(),
  workerNoun: z
    .string()
    .describe(
      "The SINGULAR job title this company uses for its field staff who go to customers — e.g. Technician, Plumber, Electrician, Driver, Cleaner, Pro, Contractor, Stylist. Infer from their trade if not stated.",
    )
    .nullable(),
  workerNounPlural: z.string().describe("Plural of workerNoun").nullable(),
  customerNoun: z
    .string()
    .describe(
      "The SINGULAR word this business (or its industry) uses for the people it serves — e.g. Customer, Client, Patient, Passenger, Resident, Family, Guest. Infer from their industry if not stated.",
    )
    .nullable(),
  customerNounPlural: z.string().describe("Plural of customerNoun").nullable(),
  jobNoun: z
    .string()
    .describe(
      "The SINGULAR word this business's industry uses for a unit of work — e.g. Job, Visit, Ride, Delivery, Route, Appointment, Order, Ticket, Project. Infer from their trade if not stated.",
    )
    .nullable(),
  jobNounPlural: z.string().describe("Plural of jobNoun").nullable(),
  services: z
    .array(z.string())
    .describe("Up to 8 services they offer")
    .default([]),
  hours: z.string().describe("Business hours as plain text").nullable(),
  address: z.string().describe("Physical address").nullable(),
  email: z.string().describe("Contact email").nullable(),
  phone: z.string().describe("Contact phone").nullable(),
  socials: z
    .object({
      facebook: z.string().nullable(),
      instagram: z.string().nullable(),
      twitter: z.string().nullable(),
      linkedin: z.string().nullable(),
      youtube: z.string().nullable(),
      tiktok: z.string().nullable(),
    })
    .partial()
    .describe("Social profile URLs found on the page"),
  suggestedIndustry: z
    .enum(["other", ...INDUSTRY_ID_LIST])
    .describe(
      "Best-fit Primary Industry (ICP) category id for this business from the allowed list. Use 'other' if none genuinely fit — do not force a bad match.",
    )
    .nullable(),
  suggestedIndustryOther: z
    .string()
    .describe(
      "Only when suggestedIndustry is 'other': a short (2-5 word) label for what kind of business this actually is, e.g. 'Wedding Photography', 'Pest Control'.",
    )
    .nullable(),
  suggestedIndustryRationale: z
    .string()
    .describe("One short sentence explaining the industry guess, shown to the admin for review.")
    .nullable(),
});

/** Main entry — run the full brand-scout pipeline. */
export async function scoutBrand(
  rawWebsite: string,
  companyId: string,
): Promise<BrandProposal> {
  const website = normalizeUrl(rawWebsite);
  const warnings: string[] = [];
  const empty: BrandProposal = {
    website,
    primaryColor: null,
    accentColor: null,
    logoUrl: null,
    logoSourceUrl: null,
    workerNoun: null,
    workerNounPlural: null,
    customerNoun: null,
    customerNounPlural: null,
    jobNoun: null,
    jobNounPlural: null,
    tagline: null,
    description: null,
    services: [],
    hours: null,
    address: null,
    email: null,
    phone: null,
    socials: {},
    suggestedIndustry: null,
    suggestedIndustryOther: null,
    suggestedIndustryRationale: null,
    warnings,
  };
  if (!website) {
    warnings.push("Invalid website URL.");
    return empty;
  }

  const page = await fetchHtml(website);
  if (!page) {
    warnings.push(
      "Couldn't load the website (it may block bots or be offline). Fill in the brand details manually.",
    );
    return empty;
  }
  const { html, finalUrl } = page;

  // run screenshot + text-from-html in parallel
  const [shot, textResult] = await Promise.allSettled([
    screenshot(finalUrl),
    generateObject({
      model: gateway(MODELS.text),
      schema: TextSchema,
      prompt: `You are analysing a field-service / trade / delivery business's website to onboard them into a dispatch & customer-management platform. From the page text below, extract the brand details AND classify their Primary Industry (ICP). Be accurate; use null when unknown. Page URL: ${finalUrl}

ALLOWED INDUSTRY CATEGORIES (pick the single best fit, or "other" if genuinely none fit):
${INDUSTRY_LABELS.map((i) => `- ${i.id}: ${i.label}`).join("\n")}

PAGE TEXT:\n${textSample(html)}`,
    }),
  ]);

  // vision pass on the screenshot for colors
  let vision: z.infer<typeof VisionSchema> | null = null;
  if (shot.status === "fulfilled" && shot.value) {
    try {
      const { object } = await generateObject({
        model: gateway(MODELS.vision),
        schema: VisionSchema,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Analyse this website screenshot. Identify the company's primary brand color and a secondary/accent color (used on buttons, links or highlights). Return hex codes.",
              },
              {
                type: "image",
                image: new Uint8Array(shot.value),
              },
            ],
          },
        ],
      });
      vision = object;
    } catch (e) {
      warnings.push("Couldn't analyse brand colors from the screenshot.");
      log.warn("brand-scout: vision failed", { err: String(e) });
    }
  } else {
    warnings.push(
      "Couldn't screenshot the site — brand colors may be incomplete.",
    );
  }

  let text: z.infer<typeof TextSchema> | null = null;
  if (textResult.status === "fulfilled") {
    text = textResult.value.object;
  } else {
    warnings.push("Couldn't read company details from the page.");
    log.warn("brand-scout: text failed", { err: String(textResult.reason) });
  }

  // logo: gather candidates from HTML, host the best one
  const candidates = logoCandidates(html, finalUrl);
  const hosted = candidates.length
    ? await hostLogo(candidates, companyId)
    : null;
  if (!hosted && candidates.length)
    warnings.push("Found logo links but couldn't download one — add it manually.");
  if (!candidates.length)
    warnings.push("No logo detected on the homepage.");

  const normHex = (h: string | null | undefined): string | null => {
    if (!h) return null;
    const v = h.trim();
    return /^#?[0-9a-f]{6}$/i.test(v) ? (v.startsWith("#") ? v : `#${v}`) : null;
  };

  const socials: Record<string, string> = {};
  if (text?.socials) {
    for (const [k, v] of Object.entries(text.socials)) {
      if (v && typeof v === "string") socials[k] = v;
    }
  }

  return {
    website: finalUrl,
    primaryColor: normHex(vision?.primaryColor),
    accentColor: normHex(vision?.accentColor),
    logoUrl: hosted?.url ?? null,
    logoSourceUrl: hosted?.source ?? candidates[0] ?? null,
    workerNoun: text?.workerNoun ?? null,
    workerNounPlural: text?.workerNounPlural ?? null,
    customerNoun: text?.customerNoun ?? null,
    customerNounPlural: text?.customerNounPlural ?? null,
    jobNoun: text?.jobNoun ?? null,
    jobNounPlural: text?.jobNounPlural ?? null,
    tagline: text?.tagline ?? null,
    description: text?.companyDescription ?? null,
    services: text?.services ?? [],
    hours: text?.hours ?? null,
    address: text?.address ?? null,
    email: text?.email ?? null,
    phone: text?.phone ?? null,
    socials,
    suggestedIndustry: text?.suggestedIndustry ?? null,
    suggestedIndustryOther: text?.suggestedIndustryOther ?? null,
    suggestedIndustryRationale: text?.suggestedIndustryRationale ?? null,
    warnings,
  };
}
