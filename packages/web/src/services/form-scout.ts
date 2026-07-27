/**
 * Form Scout — generates 2-3 industry-appropriate starter intake forms for a
 * brand-new tenant during provisioning ("Grab Brand Assets" onboarding).
 *
 * Given what we learned about the company (name, services, description,
 * website, worker-noun), it asks the text model to design starter forms that
 * match how THAT industry actually intakes work — picking sensible fields,
 * titles, intros and success messages.
 *
 * Field keys are constrained to the platform's INTAKE_FIELD_CATALOG so every
 * generated field maps to a real, renderable input. Everything degrades
 * gracefully: if the model is unavailable or returns junk, we fall back to a
 * single generic "Request Service" form so provisioning never blocks.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { gateway, MODELS } from "../api/agent/gateway";
import { INTAKE_FIELD_CATALOG } from "../api/routes/forms";
import { log } from "../api/lib/logger";
import { getIndustryPreset } from "./industry-presets";
import type { IcpKnowledge } from "./template-scout";

/** Render an IcpKnowledge block for prompt injection, or "" when empty. */
function knowledgeBlock(k: IcpKnowledge | null | undefined): string {
  if (!k) return "";
  const lines: string[] = [];
  if (k.summary) lines.push(`Industry context: ${k.summary}`);
  if (k.workflowNotes) lines.push(`How this business's intake/lead-capture actually works: ${k.workflowNotes}`);
  if (k.bestPractices?.length) lines.push(`Best practices to reflect in form design:\n${k.bestPractices.map((b) => `  - ${b}`).join("\n")}`);
  if (k.terminologyNotes) lines.push(`Industry terminology to use: ${k.terminologyNotes}`);
  if (k.complianceNotes) lines.push(`Compliance/regulatory considerations: ${k.complianceNotes}`);
  if (k.toneRefinement) lines.push(`Tone refinement: ${k.toneRefinement}`);
  if (!lines.length) return "";
  return `\n\nDEEP INDUSTRY RESEARCH (trade publications / standards bodies — reflect this in form titles, fields, and copy, it is more authoritative than generic assumptions):\n${lines.join("\n")}`;
}

/** Allowed field keys — must mirror INTAKE_FIELD_CATALOG so they render. */
const FIELD_KEYS = INTAKE_FIELD_CATALOG.map((f) => f.key) as string[];
const FIELD_LABEL: Record<string, string> = Object.fromEntries(
  INTAKE_FIELD_CATALOG.map((f) => [f.key, f.label]),
);
// name/email/phone/address are always present & required on every form.
const ALWAYS_REQUIRED = new Set(["name", "email", "phone", "address"]);

export interface StarterFormField {
  key: string;
  label: string;
  enabled: boolean;
  required: boolean;
  fixed?: boolean;
}
export interface StarterForm {
  title: string;
  slug: string;
  intro: string;
  successMessage: string;
  fields: StarterFormField[];
}

export interface FormScoutInput {
  name: string;
  // Primary Industry (ICP) preset id — same driver template-scout uses.
  // Previously this scout got NO industry context at all; now the same
  // preset (services/categories/tone) shapes intake-form design too.
  industry?: string | null;
  industryOther?: string | null; // free-text business type when industry === "other"
  services?: string[];
  description?: string | null;
  website?: string | null;
  workerNoun?: string | null;
  customerNoun?: string | null;
  // Optional deep research (trade publications, standards bodies) curated
  // per ICP — purely additive, forms degrade gracefully without it.
  knowledge?: IcpKnowledge | null;
}

const slugify = (s: string) =>
  (s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "intake";

const FormSchema = z.object({
  forms: z
    .array(
      z.object({
        title: z
          .string()
          .describe("Short, customer-facing form title, e.g. 'Request a Roofing Estimate'"),
        intro: z
          .string()
          .describe("1-2 sentence intro shown atop the form, friendly and on-brand"),
        successMessage: z
          .string()
          .describe("Confirmation message shown after submission"),
        fieldKeys: z
          .array(z.enum(FIELD_KEYS as [string, ...string[]]))
          .describe(
            "Which catalog fields this specific form should collect. Always include name, email, phone, address. Add serviceType, preferredAt, notes, photo only when they make sense for this form's purpose.",
          ),
        requiredKeys: z
          .array(z.enum(FIELD_KEYS as [string, ...string[]]))
          .describe(
            "Subset of fieldKeys that are mandatory. name/email/phone/address are always required.",
          ),
      }),
    )
    .min(2)
    .max(3)
    .describe("2 or 3 distinct starter intake forms tailored to this company's work"),
});

/** Build the platform field array from a model's key picks. */
function toFields(fieldKeys: string[], requiredKeys: string[]): StarterFormField[] {
  const enabled = new Set<string>([...ALWAYS_REQUIRED, ...fieldKeys]);
  const required = new Set<string>([...ALWAYS_REQUIRED, ...requiredKeys]);
  // preserve catalog order; only emit catalog fields
  return INTAKE_FIELD_CATALOG.filter((f) => enabled.has(f.key)).map((f) => ({
    key: f.key,
    label: FIELD_LABEL[f.key] || f.label,
    enabled: true,
    required: required.has(f.key),
    ...(f.key === "name" ? { fixed: true } : {}),
  }));
}

/** A safe single-form fallback so provisioning never fails. */
export function fallbackStarterForms(input: FormScoutInput): StarterForm[] {
  const allKeys = INTAKE_FIELD_CATALOG.map((f) => f.key);
  return [
    {
      title: "Request Service",
      slug: "request-service",
      intro: `Tell us what you need and ${input.name} will reach out shortly.`,
      successMessage:
        "Thanks! We've received your request and will reach out shortly.",
      fields: toFields(allKeys, ["serviceType"]),
    },
    {
      title: "Get a Free Quote",
      slug: "free-quote",
      intro: `Share a few details and we'll prepare a no-obligation quote.`,
      successMessage:
        "Thanks! We'll review your details and send your quote soon.",
      fields: toFields(
        ["name", "email", "phone", "address", "serviceType", "notes", "photo"],
        ["serviceType"],
      ),
    },
  ];
}

/**
 * Generate 2-3 tailored starter forms. Never throws — returns a fallback on
 * any failure so tenant provisioning continues.
 */
export async function scoutStarterForms(
  input: FormScoutInput,
): Promise<StarterForm[]> {
  const servicesLine =
    input.services && input.services.length
      ? input.services.join(", ")
      : "(unknown — infer from the company name / description)";
  const noun = input.workerNoun || "technician";
  const customerNoun = input.customerNoun || "customer";
  const preset = getIndustryPreset(input.industry);
  const industryLine = preset
    ? `${preset.label} — design forms that fit how this industry actually intakes work.`
    : input.industry === "other" && input.industryOther
      ? `${input.industryOther} (no exact preset — use this description as the primary guide).`
      : "(not specified — infer from the company name / services)";
  const toneLine = preset
    ? `\nTONE FOR THIS INDUSTRY: ${preset.aiTone}`
    : "";
  const suggestedCategories = preset
    ? `\nSUGGESTED FORM INTENTS for this industry (adapt names to ${input.name}; pick the 2-3 most useful, do not force all): ${preset.templates.join(", ")}.`
    : "";
  const research = knowledgeBlock(input.knowledge);

  try {
    const { object } = await generateObject({
      model: gateway(MODELS.text),
      schema: FormSchema,
      prompt: `You are onboarding a service business into a dispatch & booking platform and must design its starter customer intake forms (the public web forms prospects fill out to request work).

PRIMARY INDUSTRY (ICP): ${industryLine}
COMPANY: ${input.name}
WEBSITE: ${input.website || "(unknown)"}
SERVICES OFFERED: ${servicesLine}
DESCRIPTION: ${input.description || "(none)"}
THEY CALL THEIR FIELD WORKERS: ${noun}
THEY CALL THE PEOPLE THEY SERVE: ${customerNoun}${toneLine}${suggestedCategories}${research}

The PRIMARY INDUSTRY (ICP) above is the main driver — let it shape form titles, intros, and field choices first; use the services/website only as secondary detail. Match the TONE guidance above in the intro and success message copy.

Design 2 or 3 DISTINCT starter intake forms that reflect how this specific industry actually takes in work and follows best practices for lead capture. Examples of good differentiation:
- A roofing/exterior company: "Request a Free Inspection", "Get a Roof Replacement Quote", "Emergency Leak / Storm Damage".
- A building-materials supplier: "Request a Materials Quote", "Schedule a Delivery", "Contractor / Bulk Order Inquiry".
- An HVAC company: "Book a Tune-Up", "Request Emergency Repair", "New System Estimate".
- A nanny/childcare agency: "Request a Sitter", "New Family Intake", "Recurring Care Inquiry".
- A home health aide agency: "Request Care for a Loved One", "New Client Intake", "Respite Care Inquiry".

For each form:
- Pick a clear, conversion-friendly title and a short friendly intro that matches the tone guidance.
- Choose ONLY fields from this catalog (use the exact keys): ${FIELD_KEYS.join(", ")}.
- name, email, phone, address are ALWAYS included and required. Add serviceType, preferredAt, notes, photo only when they fit that form's purpose (e.g. include photo for damage/inspection forms; include preferredAt for scheduling/delivery forms).
- Write a warm, on-brand success message.

Tailor everything to ${input.name}'s actual line of work. Avoid generic duplicates — each form should serve a different customer intent.`,
    });

    const forms = (object.forms || [])
      .slice(0, 3)
      .map((f) => ({
        title: (f.title || "Request Service").trim(),
        slug: slugify(f.title),
        intro: (f.intro || "").trim(),
        successMessage:
          (f.successMessage || "").trim() ||
          "Thanks! We've received your request and will reach out shortly.",
        fields: toFields(f.fieldKeys || [], f.requiredKeys || []),
      }))
      .filter((f) => f.fields.length >= 4); // sanity: must keep core contact fields

    if (forms.length < 2) {
      log.warn("form-scout: model returned too few usable forms; using fallback", {
        company: input.name,
        got: forms.length,
      });
      return fallbackStarterForms(input);
    }

    // de-dupe slugs within the batch
    const seen = new Set<string>();
    for (const f of forms) {
      let s = f.slug;
      let i = 2;
      while (seen.has(s)) s = `${f.slug}-${i++}`;
      f.slug = s;
      seen.add(s);
    }

    return forms;
  } catch (e) {
    log.warn("form-scout: generation failed; using fallback", {
      company: input.name,
      err: String(e),
    });
    return fallbackStarterForms(input);
  }
}
