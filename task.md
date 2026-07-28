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

## Round 2 (both scopes)
- [x] catalog-presets.ts reconciled to real 17-ICP slugs; retired 9 no-counterpart ids;
      added 9 new starter catalogs; caught+fixed unquoted-hyphenated-key syntax bug via
      runtime parse check (tsc --noEmit alone missed it); tsc clean now. COMMITTED.
- [x] Options/Tier Quote Engine backend: schema (option_categories,
      option_category_items, booking_option_selections) migrated to live Turso;
      routes/option-catalog.ts (admin CRUD + attach-rate report);
      routes/option-selections.ts (public token-based via bookings.publicToken,
      reuses buildUnitLineItem + recomputeBooking for pricing — no new pricing math);
      wired into api/index.ts. Verified via live server boot + curl smoke test
      (not just tsc, which has proven unreliable this session). COMMITTED.
- [x] Admin frontend: pages/admin/options-catalog.tsx (category/tier CRUD + attach-rate
      table), wired into admin/index.tsx route + admin/shell.tsx nav ("Options & Tiers").
      COMMITTED (see below).
- [x] Public customer-facing selections page: pages/selections-public.tsx at /s/:token
      (wouter route in app.tsx), mirrors track-public.tsx visual style. Tier cards per
      category, running total, typed-name e-sign, locked/confirmed state after submit.
- [x] "Copy customer selections link" button added to work-order-modal.tsx (only shows
      when editing an existing booking with a publicToken) — copies /s/:token to clipboard.
- [x] Full verification done properly this time: `bun run build` (tsc --noEmit && vite
      build, the REAL gate — see lesson below) passes clean, all new chunks
      (options-catalog, selections-public) built. Booted actual dev server against live
      Turso DB + Redis, curled every new endpoint: public 404 on bad token (GET+POST),
      admin 401 without auth, SPA serves /s/:token via client-side routing (200 + React
      handles it). DB/redis both report healthy in /api/ready.
- [x] Committed: schema+migration, backend routes, catalog-presets.ts reconciliation.
      Frontend pieces (options-catalog.tsx, selections-public.tsx, app.tsx route,
      admin/index.tsx route, admin/shell.tsx nav, work-order-modal.tsx link button)
      committed in this round too.

### Follow-up: did the recommended full authenticated E2E walkthrough
Logged in as admin@nvc360.app, ran the real flow end to end against the live Turso DB:
create category -> add Good/Better tiers -> pick a real booking -> hit its /s/:token
selections page -> submit as "customer" with e-sign -> confirmed booking subtotal/total
recomputed correctly ($45 -> $1,545 subtotal reflecting a $1,500 LVP upgrade, tax
recalculated) -> confirmed the page shows a locked/confirmed state on reload -> confirmed
admin per-booking selections view and attach-rate report both showed correct data (100%
attach rate, $1,500 incremental revenue).
FOUND AND FIXED A REAL BUG: POST /api/selections/:token was throwing 500 — passed
`Date.now()` (a number) to a drizzle `timestamp_ms` column, which needs a JS `Date`
object on insert (confirmed by checking the rest of the codebase's convention, e.g.
bookings.ts always uses `new Date()`). This is exactly the kind of bug that only a real
authenticated run — not a build check, not tsc, not a bare 401/404 smoke test — catches.
Fixed, rebuilt, re-ran the entire flow successfully, cleaned up all test data from the
live DB afterward. Committed.


## Round 3 (both remaining follow-ups completed)
- [x] Per-ICP option-catalog seeding: new services/option-catalog-presets.ts with
      research-grounded starter categories/tiers for 13 industries (Wave 1: home-builder-
      developer, painting-decorating, design-build, renovation-contractor; Wave 2:
      electrical, exteriors, hvac-plumbing, garage-door, flooring, concrete-foundation-
      repair, tree-care, landscaping-grounds-snow, restoration; thin Wave 3:
      commercial-building-maintenance SLA tier). Wired into superadmin.ts company-create
      flow (step 2g, seedOptionCatalogForCompany, same pattern as seedCatalogForCompany).
      Outlier ICPs (equipment-rental, property-management-maintenance, sports-organization)
      intentionally left unseeded — matches their own "hold" research verdict.
- [x] Employee PIN-gated work-order-form.tsx: success screen now shows "Copy customer
      selections link" using the newly-created booking's publicToken (public-forms.ts
      submit response now returns `publicToken` alongside `bookingId`).
- [x] Full E2E verification via superadmin API (not just code review): created a real
      test company "e2e-option-seed-test" (industry home-builder-developer) via
      POST /api/superadmin/companies as dan@nvc360.com, confirmed server logs showed
      "seeded 3 option categories", then logged in AS THAT TENANT'S OWN ADMIN and hit
      GET /api/option-catalog/categories — got back all 3 real categories (Flooring,
      Kitchen Countertops, Electrical Upgrade Package) with correct tiers/price deltas
      exactly as authored. Cleaned up all test rows (company, user, categories, catalog
      items, services, templates, forms, company_settings) from the live Turso DB after.
- [x] bun run build (real gate) passes clean after all changes.
- [x] Committed.

### Still open (not asked for, noted for completeness)
- Outlier ICPs (equipment-rental, property-management-maintenance, sports-organization)
  have no option-catalog preset — deliberate, matches their "hold"/"conditional" research
  verdict, not an oversight.
- Public intake-form flow (public-forms.ts, the OTHER c.json success response around
  line 557, a different code path from the work-order form) was not touched — out of
  scope, that's a separate customer-facing intake form feature, not the PIN-gated
  employee work-order form the user referenced.

### IMPORTANT LESSON THIS SESSION
tsc --noEmit in this repo's root tsconfig.json has `"files": []` and uses project
references — running plain `tsc --noEmit` from packages/web checks NOTHING (always exits
0 regardless of real errors). This is why it missed a real hyphenated-object-key syntax
error earlier. Running `tsc --noEmit -p tsconfig.app.json` directly DOES check files, but
this repo has ~dozens of PRE-EXISTING, unrelated type errors (better-auth `c.get("user")`
overload issues, AWS SDK version mismatches, etc.) that predate this session's changes —
so that invocation isn't a useful signal either without a way to diff against a known-good
baseline. The REAL gate the team relies on is `bun run build` (= tsc --noEmit && vite
build) from packages/web — vite's own transform catches real syntax/type errors that
matter for the bundle, and it passing is what "the code actually works" means here. Going
forward: verify with `bun run build` + booting the dev server + curling changed endpoints,
never tsc alone.


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

## Round 4 — deep ICP research for remaining 13 + notification defaults + noun wiring + mobile + scrape depth
User request (verbatim priorities):
1. Complete deep trade research for remaining 13 ICPs (icp_knowledge_base) — same quality as Wave 1.
2. Fix customerNoun/jobNoun dead code — wire into frontend like workerNoun (18 pages), confirm scrape+ICP fallback already populates them correctly (it does, per superadmin.ts:472-478 — this is a FRONTEND-ONLY fix).
3. ICP-aware notification defaults (currently one flat 15-row matrix for every tenant regardless of industry) — research-grounded per-ICP notification profile, seeded at company create.
4. Mobile driver app (Expo) — zero ICP/terminology customization today — bring it to parity with web (workerNoun etc.)
5. Deepen website-scrape usage beyond brand+forms/templates (currently dead-ends after email footer + form/template prompt context) — test against bmdmaterials.com as the working model, propose + implement a global standard.

Plan of attack (in this order):
A. Fetch remaining 13 ICP Drive folders (01/03/04 docs) — folder IDs already known from earlier session:
   04-electrical 1q34KR_C9PRQ2gBdP1kBR3VsdAfANs-Bw, 05-exteriors 10_RMHHCz81ayExOZKWTCzn7YIoYMJhCZ,
   06-hvac-plumbing 1bMD9PJ2tlos9zpjgoVIV_AEVr6dj2B90, 07-landscaping-grounds-snow 1rXSj2nAcOaIFC-J7qs59lzS5V5VVhKP1,
   09-commercial-building-maintenance 1mWdG_0ezFzLgYGldX74oUigXe0ZQz0yN, 10-flooring 1cTZPUJNoQrGdfFEttc83yGtZUTgjIVqn,
   11-garage-door 1WRQQX0ZXZc1aFLGfpCNPESOToDV6qbhz, 12-tree-care 1tOEawZ7J1DiNciKJuK4pHWnAI81Ydhdf,
   13-concrete-foundation-repair 1VeSwI5fQY6HyiwurUP0U8VWrw1ouvx7n, 14-equipment-rental 1oabI52mRwvTkyRRevpzehoQoU1Ee4gHQ,
   15-property-management-maintenance 1R6mzTc9pqRkt3SknKqre-_basm3EShrN, 16-restoration 1I7t0w0v1MiprgbMqiiSs1xAMQ9shFK5W,
   17-sports-organization 10IAFn6XOuw_gdjWkWZm5J5BnLkB6Fn5d
B. Seed icp_knowledge_base for all 13 (extend scripts/seed-icp-knowledge-base.ts pattern).
C. Build notification-presets.ts (per-ICP T1-T8 trigger profile from Phase3 synthesis + per-ICP docs), wire into
   superadmin.ts to replace/extend seedNotificationRules with an ICP-aware version.
D. Wire useCustomerNoun/useJobNoun into the same ~18 files that already use useWorkerNoun.
E. Mobile app: add brand/terminology fetching parity with web.
F. Deepen website-scrape -> seeding pipeline (e.g. feed scraped services into catalog/options), test with bmdmaterials.com.

### Phase A DONE: fetched + read all 13 remaining ICPs' research
- All 39 files (01/03/04 per industry) downloaded to /home/user/icp-research/<slug>/, verified titles match
  (caught + fixed a download-tool race bug: requesting multiple fileIds sharing the same base filename
  e.g. "01-Industry-Overview.md" from TWO different folders in one call caused silent content overwrite —
  5 of 13 industries got the WRONG industry's content on first pass. Re-downloaded those 5 one file at a
  time and verified each by title before trusting it: electrical, hvac-plumbing,
  commercial-building-maintenance, garage-door, concrete-foundation-repair all reconfirmed correct.)
- Read summary + best-practices + notifications tables for all 13. Also noted: concrete-foundation-repair
  was RE-SCORED from provisional 6.3 to 7.3 (core, non-provisional) on 2026-07-27 per its own doc header —
  industry-presets.ts still shows the old 6.3/provisional value, should update fitScore/rationale there too.
- NEXT: write seed script (extend scripts/seed-icp-knowledge-base.ts pattern) with all 13 new rows, run
  against live Turso DB, verify via SELECT.
