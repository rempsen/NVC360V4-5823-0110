# ICP expansion + AI auto-suggest + deeper customization — Jul 27, 2026

## Scope (Phase 1 — building now)
1. Expand industry-presets.ts:
   - New fields per preset: group (dropdown section), workerNounPlural,
     customerNoun/customerNounPlural, jobNoun/jobNounPlural, aiTone,
     notificationGuidance.
   - Add 11 new ICPs: flooring, limousine, food_delivery, home_health_aide,
     florist, nanny, housekeeping, pool_service, it_pro, home_automation,
     pharmacy_delivery.
   - Keep + backfill new fields on existing 15.
2. "Other/custom" ICP path (UI-only value "other", not in presets array) +
   new companies.industryOther column for a free-text description, threaded
   into template-scout/form-scout as context when no preset matches.
3. AI-suggest ICP: extend brand-scout TextSchema with suggestedIndustry (enum
   of preset ids + "other"), suggestedIndustryOther, suggestedIndustryRationale,
   customerNoun/Plural, jobNoun/Plural. Wire into companies.tsx to pre-select
   the ICP dropdown (still overridable) + show AI rationale.
4. Schema: add companySettings.customerNoun/customerNounPlural/jobNoun/
   jobNounPlural + companies.industryOther. Migration via db:generate (NOT
   raw SQL/push — per the Jul 3 baseline convention).
5. Wire terminology + tone into:
   - superadmin.ts provisioning (fallback to preset noun, not hardcoded
     "Technician")
   - use-brand.ts (useBrand/useWorkerNoun -> add useCustomerNoun/useJobNoun)
   - template-scout.ts + form-scout.ts prompts (aiTone, customerNoun, jobNoun,
     notificationGuidance as generation context). form-scout currently gets
     ZERO industry context at all today — real gap, fix it.
   - admin/notifications.tsx: surface preset.notificationGuidance as a hint.
6. companies.tsx UI: grouped ICP dropdown (optgroup by `group`), "Other"
   option + free-text field, AI-suggested-industry badge/rationale, customer/
   job noun fields in BrandReview.

## Explicitly OUT of scope for this pass (proposed as Phase 2, needs pacing
## discussion with user before committing — 16+ industries of REAL research
## is a huge, separate effort):
- Deep per-ICP knowledge base (trade publications, university papers, best
  practices) research + a persisted knowledge store feeding the AI prompts.
- Full app-wide terminology reskin beyond the existing dynamic surfaces
  (useWorkerNoun's current footprint) — extending customerNoun/jobNoun to
  every literal "Customer"/"Job" string across 70+ pages is a much bigger
  follow-on UI pass.

## Files touched
- packages/web/src/services/industry-presets.ts (major rewrite)
- packages/web/src/services/brand-scout.ts (schema + prompt)
- packages/web/src/services/template-scout.ts (prompt context)
- packages/web/src/services/form-scout.ts (add industry input + prompt)
- packages/web/src/api/database/schema.ts (+migration)
- packages/web/src/api/routes/superadmin.ts (persist new fields, fix fallback)
- packages/web/src/api/routes/settings.ts (surface new fields)
- packages/web/src/web/lib/use-brand.ts (customerNoun/jobNoun hooks)
- packages/web/src/web/pages/admin/companies.tsx (UI)
- packages/web/src/web/pages/admin/notifications.tsx (guidance hint, if time)

## Verify
tsc, tests, build, live provision-a-tenant test with a NEW ICP (e.g. Flooring
Supplier) end-to-end including AI-suggest, confirm terminology flows through.
