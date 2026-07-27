/**
 * Template Scout — generates 2-3 industry-appropriate WORK-ORDER templates for
 * a brand-new tenant during provisioning ("Grab Brand Assets" onboarding).
 *
 * These are the drag-and-drop Form Builder outputs (task_templates), NOT the
 * public intake forms (see form-scout.ts). Each template captures how that
 * industry actually runs a job on site: the fields a worker fills in, an
 * on-site checklist, an estimated duration, and a sensible pricing/rate model.
 *
 * Per the product rule, every company gets a spread covering the three core
 * workflows wherever they apply:
 *   - a RESIDENTIAL workflow template
 *   - a COMMERCIAL workflow template
 *   - a SERVICE / maintenance workflow template
 * The model adapts the names + fields to the specific trade (e.g. a building-
 * materials supplier gets delivery/quote/bulk-order flavored templates).
 *
 * Everything degrades gracefully: if the model is unavailable or returns junk,
 * we fall back to three generic templates so provisioning never blocks.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { gateway, MODELS } from "../api/agent/gateway";
import { log } from "../api/lib/logger";
import { EMPTY_RATE_MODEL, type RateModel } from "../shared/pricing";
import { getIndustryPreset } from "./industry-presets";

/** Field types supported by the builder canvas (mirror builder.tsx PALETTE). */
const FIELD_TYPES = [
  "text",
  "number",
  "checkbox",
  "select",
  "photo",
  "signature",
  "date",
] as const;
type FieldType = (typeof FIELD_TYPES)[number];

export interface TemplateField {
  type: FieldType;
  label: string;
  required: boolean;
}
export interface StarterTemplate {
  name: string;
  category: string; // Residential | Commercial | Service | <trade-specific>
  icon: string;
  color: string;
  description: string;
  fields: TemplateField[];
  checklist: { id: string; label: string }[];
  estimatedMins: number;
  rateModel: RateModel;
}

export interface TemplateScoutInput {
  name: string;
  industry?: string | null; // ICP preset id — primary driver of template intent
  industryOther?: string | null; // free-text business type when industry === "other"
  services?: string[];
  description?: string | null;
  website?: string | null;
  workerNoun?: string | null;
  customerNoun?: string | null;
  brandColor?: string | null;
}

const uid = () => Math.random().toString(36).slice(2);

const RateSchema = z.object({
  flatRate: z.number().min(0).default(0).describe("Fixed $ base charge that includes the included minutes/km"),
  includedMinutes: z.number().min(0).default(0).describe("Minutes covered by the flat rate"),
  includedKm: z.number().min(0).default(0).describe("Km covered by the flat rate"),
  timeRate: z.number().min(0).default(0).describe("$ per timeUnit billed beyond included minutes"),
  timeUnit: z.enum(["minute", "hour"]).default("hour"),
  kmRate: z.number().min(0).default(0).describe("$ per km billed beyond included km"),
  minCharge: z.number().min(0).default(0).describe("Optional minimum charge floor; 0 = none"),
});

const TemplateSchema = z.object({
  templates: z
    .array(
      z.object({
        name: z
          .string()
          .describe("Short work-order template name, e.g. 'Residential Service Call' or 'Commercial Delivery'"),
        category: z
          .string()
          .describe(
            "One of: Residential, Commercial, Service. Use these unless a trade-specific bucket fits much better.",
          ),
        description: z.string().describe("One sentence describing when a worker uses this template"),
        estimatedMins: z.number().int().min(15).max(600).describe("Typical on-site duration in minutes"),
        fields: z
          .array(
            z.object({
              type: z.enum(FIELD_TYPES),
              label: z.string().describe("Field label the worker sees, e.g. 'Equipment model #'"),
              required: z.boolean().default(false),
            }),
          )
          .min(3)
          .max(12)
          .describe(
            "The on-site fields the worker fills in. Mix types sensibly: text for notes/IDs, number for readings/quantities, select for options, photo for before/after, signature for sign-off, date for follow-ups, checkbox for yes/no.",
          ),
        checklist: z
          .array(z.string())
          .min(2)
          .max(8)
          .describe("Short on-site checklist items (verbs), e.g. 'Confirm site access', 'Photograph completed work'"),
        rateModel: RateSchema.describe("A realistic pricing/rate model for this template in this industry"),
      }),
    )
    .min(2)
    .max(3)
    .describe("2-3 distinct work-order templates covering residential, commercial and service workflows"),
});

function normFields(fields: { type: FieldType; label: string; required?: boolean }[]): TemplateField[] {
  return (fields || [])
    .filter((f) => f && f.label && FIELD_TYPES.includes(f.type))
    .map((f) => ({ type: f.type, label: String(f.label).trim().slice(0, 80), required: !!f.required }))
    .slice(0, 12);
}

const ICON_BY_CATEGORY: Record<string, string> = {
  residential: "home",
  commercial: "building-2",
  service: "wrench",
};
function iconFor(category: string): string {
  return ICON_BY_CATEGORY[category.toLowerCase()] ?? "clipboard-list";
}

/** Three generic templates so provisioning never fails. */
export function fallbackStarterTemplates(input: TemplateScoutInput): StarterTemplate[] {
  const color = input.brandColor || "#0ea5e9";
  const mk = (
    name: string,
    category: string,
    description: string,
    estimatedMins: number,
    fields: TemplateField[],
    checklist: string[],
    rateModel: RateModel,
  ): StarterTemplate => ({
    name,
    category,
    icon: iconFor(category),
    color,
    description,
    fields,
    checklist: checklist.map((label) => ({ id: uid(), label })),
    estimatedMins,
    rateModel,
  });
  const contact: TemplateField[] = [
    { type: "text", label: "Site contact name", required: true },
    { type: "text", label: "On-site notes", required: false },
    { type: "photo", label: "Photos (before / after)", required: false },
    { type: "signature", label: "Customer sign-off", required: true },
  ];
  return [
    mk(
      "Residential Visit",
      "Residential",
      "Standard residential job at a customer's home.",
      90,
      [{ type: "text", label: "Job description", required: true }, ...contact],
      ["Confirm site access", "Complete the work", "Photograph completed work", "Get customer sign-off"],
      { ...EMPTY_RATE_MODEL, flatRate: 120, includedMinutes: 60, timeRate: 90, timeUnit: "hour" },
    ),
    mk(
      "Commercial Job",
      "Commercial",
      "Commercial/contract job at a business or job site.",
      180,
      [
        { type: "text", label: "Purchase order / reference #", required: false },
        { type: "text", label: "Scope of work", required: true },
        ...contact,
      ],
      ["Check in with site manager", "Review scope & safety", "Complete the work", "Document with photos", "Obtain sign-off"],
      { ...EMPTY_RATE_MODEL, timeRate: 125, timeUnit: "hour", kmRate: 0.75, minCharge: 250 },
    ),
    mk(
      "Service / Maintenance",
      "Service",
      "Recurring service, inspection or maintenance call.",
      60,
      [
        { type: "select", label: "Service type", required: true },
        { type: "number", label: "Readings / measurements", required: false },
        { type: "checkbox", label: "Follow-up required", required: false },
        ...contact,
      ],
      ["Inspect equipment", "Perform service", "Record readings", "Note any follow-ups", "Get sign-off"],
      { ...EMPTY_RATE_MODEL, flatRate: 95, includedMinutes: 45, timeRate: 85, timeUnit: "hour" },
    ),
  ];
}

/**
 * Generate 2-3 tailored work-order templates. Never throws — returns the
 * fallback set on any failure so tenant provisioning continues.
 */
export async function scoutStarterTemplates(input: TemplateScoutInput): Promise<StarterTemplate[]> {
  const servicesLine =
    input.services && input.services.length
      ? input.services.join(", ")
      : "(unknown — infer from the company name / description)";
  const noun = input.workerNoun || "technician";
  const customerNoun = input.customerNoun || "customer";
  const color = input.brandColor || "#0ea5e9";
  const preset = getIndustryPreset(input.industry);
  const industryLine = preset
    ? `${preset.label} — design templates that fit how this industry actually runs jobs.`
    : input.industry === "other" && input.industryOther
      ? `${input.industryOther} (no exact preset — use this description as the primary guide).`
      : "(not specified — infer from the company name / services)";
  const suggestedTemplates = preset
    ? `\nSUGGESTED TEMPLATE INTENTS for this industry (adapt names to ${input.name}; pick the 2-3 most useful, do not force all): ${preset.templates.join(", ")}.`
    : "";
  const toneLine = preset ? `\nTONE FOR THIS INDUSTRY: ${preset.aiTone}` : "";

  try {
    const { object } = await generateObject({
      model: gateway(MODELS.text),
      schema: TemplateSchema,
      prompt: `You are onboarding a field-service / trade business into a dispatch platform and must design its starter WORK-ORDER TEMPLATES — the on-site forms a ${noun} fills out while doing a job (NOT the public lead-capture forms).

PRIMARY INDUSTRY (ICP): ${industryLine}
COMPANY: ${input.name}
WEBSITE: ${input.website || "(unknown)"}
SERVICES OFFERED: ${servicesLine}
DESCRIPTION: ${input.description || "(none)"}
THEY CALL THEIR FIELD WORKERS: ${noun}
THEY CALL THE PEOPLE THEY SERVE: ${customerNoun}${toneLine}${suggestedTemplates}

The PRIMARY INDUSTRY (ICP) above is the main driver — let it shape the template names, fields, checklists, and rate models first; use the services/website only as secondary detail. Match the TONE guidance above in field labels and checklist phrasing where natural.
First, reason about what this company actually does and the industry's best-practice job workflows. Then design 2-3 DISTINCT work-order templates. Wherever it applies to this business, cover the three core workflows:
  1. a RESIDENTIAL workflow (work at a customer's home),
  2. a COMMERCIAL workflow (work at a business / contract job site),
  3. a SERVICE / maintenance workflow (inspection, recurring service, repair).
If a workflow truly doesn't apply to this trade, replace it with a template that does (e.g. a building-materials supplier might use 'Residential Delivery', 'Commercial / Bulk Delivery', 'Will-Call Pickup & Loadout').

For EACH template:
- Give it a clear name and set category to Residential, Commercial, or Service.
- Choose 3-12 on-site fields with sensible types (text, number, checkbox, select, photo, signature, date). Include a photo field for jobs needing proof of work, a signature for customer sign-off, and number fields for readings/quantities where relevant.
- Write a 2-8 item on-site checklist of action steps.
- Set a realistic estimatedMins.
- Provide a realistic rateModel for this industry (use flatRate + includedMinutes for call-out style jobs, timeRate/timeUnit for hourly trades, kmRate for delivery/travel, minCharge as a floor where appropriate). Use plausible North-American pricing.

Tailor everything to ${input.name}'s actual line of work. Each template must serve a different job type — avoid duplicates.`,
    });

    const templates: StarterTemplate[] = (object.templates || [])
      .slice(0, 3)
      .map((t) => {
        const category = (t.category || "Service").trim();
        return {
          name: (t.name || "Work Order").trim().slice(0, 60),
          category,
          icon: iconFor(category),
          color,
          description: (t.description || "").trim(),
          fields: normFields(t.fields as any),
          checklist: (t.checklist || [])
            .filter(Boolean)
            .slice(0, 8)
            .map((label) => ({ id: uid(), label: String(label).trim().slice(0, 80) })),
          estimatedMins: Math.min(600, Math.max(15, Math.round(t.estimatedMins || 60))),
          rateModel: { ...EMPTY_RATE_MODEL, ...(t.rateModel as RateModel) },
        };
      })
      .filter((t) => t.fields.length >= 3);

    if (templates.length < 2) {
      log.warn("template-scout: model returned too few usable templates; using fallback", {
        company: input.name,
        got: templates.length,
      });
      return fallbackStarterTemplates(input);
    }
    return templates;
  } catch (e) {
    log.warn("template-scout: generation failed; using fallback", {
      company: input.name,
      err: String(e),
    });
    return fallbackStarterTemplates(input);
  }
}
