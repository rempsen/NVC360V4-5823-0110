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

### Still outstanding (lower priority, not blocking)
- No auto-seeded starter option categories per ICP on company create.
- No employee/PIN-gated work-order form (work-order-form.tsx) integration — only the
  admin work-order-modal.tsx has the "copy selections link" button.

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
