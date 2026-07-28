/**
 * Service Scout — tailors the SERVICE LIBRARY (schema.services) seeded for a
 * brand-new tenant to what THAT business actually offers, instead of just
 * copying the generic industry-preset service list verbatim.
 *
 * Item 5 of the ICP-customization work: the website scrape already captures
 * a real `services` list (Brand Scout reads it off the homepage/services
 * page), and forms/templates already use it as secondary context — but the
 * one place a new tenant's own services should show up verbatim, the
 * Service Library itself, was dead-ending straight into the generic ICP
 * preset and ignoring the scrape entirely. This closes that gap: given the
 * preset's baseline services (proven categories/durations for the trade)
 * plus the tenant's own scraped service names, ask the model to produce one
 * tailored list — keep the preset's structure (category/duration
 * conventions) but rename/add/drop entries so the result reads like it was
 * built specifically for this business.
 *
 * Degrades gracefully: with no scrape data at all, or on any model failure,
 * falls straight back to the preset's services unchanged (today's behavior)
 * so provisioning never blocks or regresses for a business with a thin or
 * unreachable website.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { gateway, MODELS } from "../api/agent/gateway";
import { log } from "../api/lib/logger";
import { getIndustryPreset } from "./industry-presets";
import type { IcpKnowledge } from "./template-scout";

export interface ScoutedService {
  name: string;
  category: string;
  durationMins: number;
}

export interface ServiceScoutInput {
  name: string;
  industry?: string | null;
  industryOther?: string | null;
  services?: string[]; // scraped from the tenant's own website
  description?: string | null;
  website?: string | null;
  knowledge?: IcpKnowledge | null;
}

const ServiceSchema = z.object({
  services: z
    .array(
      z.object({
        name: z.string(),
        category: z.string(),
        durationMins: z.number().int().min(15).max(600),
      }),
    )
    .min(4)
    .max(16),
});

function knowledgeBlock(k: IcpKnowledge | null | undefined): string {
  if (!k) return "";
  const lines: string[] = [];
  if (k.summary) lines.push(`Industry context: ${k.summary}`);
  if (k.bestPractices?.length)
    lines.push(`Best practices for this trade's service menu:\n${k.bestPractices.map((b) => `  - ${b}`).join("\n")}`);
  if (k.terminologyNotes) lines.push(`Industry terminology to use: ${k.terminologyNotes}`);
  if (!lines.length) return "";
  return `\n\nDEEP INDUSTRY RESEARCH:\n${lines.join("\n")}`;
}

/**
 * Produce a tailored service list for a new tenant. Never throws — falls
 * back to the plain industry-preset list (or an empty array if there's no
 * preset AND no scrape data) so provisioning always succeeds.
 */
export async function scoutStarterServices(
  input: ServiceScoutInput,
): Promise<ScoutedService[]> {
  const preset = getIndustryPreset(input.industry);
  const presetServices = preset?.services ?? [];
  const scraped = (input.services ?? []).map((s) => s.trim()).filter(Boolean);

  // No scrape signal at all -> nothing to tailor with, use the preset as-is
  // (unchanged from prior behavior) or bail with an empty list.
  if (scraped.length === 0) return presetServices;

  const presetLine = presetServices.length
    ? presetServices.map((s) => `${s.name} (${s.category}, ${s.durationMins}min)`).join("; ")
    : "(no preset — infer sensible categories/durations from the trade)";
  const research = knowledgeBlock(input.knowledge);

  try {
    const { object } = await generateObject({
      model: gateway(MODELS.text),
      schema: ServiceSchema,
      prompt: `You are onboarding a service business into a field-service dispatch platform and must build its SERVICE LIBRARY — the list of bookable services customers can request.

COMPANY: ${input.name}
WEBSITE: ${input.website || "(unknown)"}
DESCRIPTION: ${input.description || "(none)"}
GENERIC BASELINE for this industry (proven categories/durations — use these as a structural template, not literal names to keep): ${presetLine}
SERVICES ACTUALLY LISTED ON THIS COMPANY'S OWN WEBSITE (ground truth for what THEY offer — use their real names/wording): ${scraped.join(", ")}${research}

Produce ONE tailored service list for ${input.name} specifically:
- Prefer the company's own service names/wording from their website over generic baseline names, when they describe the same thing.
- Keep the baseline's category groupings and realistic duration estimates (in minutes) where a scraped service matches a baseline one.
- Add any distinctly different service from the website that the baseline doesn't cover, with a sensible category and duration estimate for that kind of trade work.
- Drop baseline services that clearly don't apply to this specific business (e.g. don't keep "New Construction" work if the site only advertises repair/service calls).
- Return between 6 and 14 services total — enough to populate a real service catalog, not a token handful, but don't pad with near-duplicates.
- Categories should be short (1-3 words) and reusable across several services (e.g. "Repair", "Installation", "Maintenance"), not one-off per service.`,
    });

    const out = (object.services || [])
      .map((s) => ({
        name: (s.name || "").trim(),
        category: (s.category || "General").trim(),
        durationMins: s.durationMins || 60,
      }))
      .filter((s) => s.name);

    if (out.length < 4) {
      log.warn("service-scout: model returned too few usable services; using preset fallback", {
        company: input.name,
      });
      return presetServices;
    }
    return out;
  } catch (e) {
    log.warn("service-scout: model call failed; using preset fallback", {
      company: input.name,
      error: e instanceof Error ? e.message : String(e),
    });
    return presetServices;
  }
}
