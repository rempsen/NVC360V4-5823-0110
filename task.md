# ICP reconciliation — task tracker

## Goal
Replace ad-hoc 26-industry list with real 17-ICP taxonomy (Notion/Supabase/Drive
research program), and wire full per-ICP knowledge base for Wave 1 beta cohort
(home-builder-developer, painting-decorating, design-build, renovation-contractor).
Retire old pilot ICPs entirely.

## Done
- [x] Pulled full Phase1 ranking + Phase3 synthesis docs from Drive (`Claude Projects/NVC360-Hub/ICPs/`)
- [x] Pulled 01/02/03/04 docs for all 4 Wave-1 ICPs into /home/user/icp-research/<slug>/
- [x] Rewrote packages/web/src/services/industry-presets.ts — 17 ICPs (13 core + 4 outlier)
      + 6 alias rows (Windows&Doors, Eavestrough&Gutters -> exteriors; Snow Removal,
      Irrigation, Fence&Deck -> landscaping-grounds-snow; Solar&EV -> electrical).
      Old 26 ids (hvac, plumbing, courier, limousine, florist, nanny, home_health_aide,
      it_pro, pharmacy_delivery, etc.) fully removed.
      getIndustryPreset() updated to prefer non-alias row when id collides.

## Done (cont.)
- [x] Deleted stale icp_knowledge_base rows (flooring, home_health_aide, hvac) via
      scripts/seed-icp-knowledge-base.ts against live Turso DB
- [x] Inserted 4 rich icp_knowledge_base rows (home-builder-developer, painting-decorating,
      design-build, renovation-contractor) — verified via SELECT, all 4 present
- [x] tsc --noEmit on packages/web passes clean after the preset rewrite
- [x] Confirmed no other file hardcodes the removed old industry ids (only test fixtures
      use "hvac" as an unrelated services.category string — harmless)

## Known gaps (not done this round — flag to Dan)
- packages/web/src/services/catalog-presets.ts (CATALOG_PRESETS) is still keyed by the OLD
  industry ids (hvac, plumbing, etc.) for pricing-catalog seeding (schema.catalogItems).
  Not type-coupled (Record<string,...>), so it doesn't break the build, but new-company
  catalog seeding will silently insert 0 items for any of the 17 real ICPs until this is
  reconciled too. Separate follow-up task.
- Deeper Wave-1 app customization (actual Selections Studio / Selections Board / Change
  Orders UI, notification engine primitives, menu modules from Phase 3 synthesis section
  E) was NOT built — only the industry list + icp_knowledge_base research content. That's
  the "generalized options/tier quote engine" (#1 build priority) and is real feature work,
  not data reconciliation.
- Did not touch template-scout.ts / form-scout.ts logic — they already consume
  icp_knowledge_base + IndustryPreset generically, so richer KB content should already
  flow into AI-generated templates/forms without code changes, but not manually verified
  end-to-end this round.

## Key facts / IDs (don't re-fetch)
- Supabase project: nvc360-icp-intelligence, ref baqduvribxicrzalwycb (still unverified via
  Pipedream connection — all select/count queries returned empty for both real & fake table
  names, connection likely misconfigured/RLS-blocked; not blocking since Drive has full data)
- Google Drive ICPs folder id: 1m-vCNj2FupShQKeFeR9AZoYyQ05Ub6UQ
- 17 ICP slugs (rank/fit): home-builder-developer(1/9.3), painting-decorating(2/8.2),
  design-build(3/8.0), electrical(4/7.6), exteriors(5/7.3), hvac-plumbing(6/7.2),
  landscaping-grounds-snow(7/7.1), renovation-contractor(8/6.9),
  commercial-building-maintenance(9/6.8), flooring(10/6.7), garage-door(11/6.6),
  tree-care(12/6.5), concrete-foundation-repair(13/6.3, provisional) — all core.
  Outliers: equipment-rental(14/6.4), property-management-maintenance(15/6.2),
  restoration(16/5.7), sports-organization(17/4.4).
- icp_knowledge_base schema (packages/web/src/api/database/schema.ts ~L945): industry (PK),
  summary, bestPractices (JSON string[]), workflowNotes, terminologyNotes, toneRefinement,
  notificationRefinement, complianceNotes, sources (JSON {title,url}[]), researchedBy,
  researchedAt, updatedAt, createdAt. No write route exists in the app — prior pilot rows
  were seeded via raw SQL directly against Turso (DATABASE_URL + DATABASE_AUTH_TOKEN in
  /home/user/nvc360-v4/.env). Same approach needed for the 4 new rows.
