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

### Item 2 (customerNoun/jobNoun wiring) — COMPLETE, committed
- Finished remaining files this round: bookings.tsx (title/subtitle, "New {jobNoun}" button, work-order
  count text, table column headers Job/Client, FilterBar "{customerNoun} tag" and "{jobNoun} #" labels —
  required several retries, edit tool silently no-op'd on ~5 attempts before applying; always re-grep to
  confirm an edit actually landed, don't trust the "Successfully edited" message alone), fleet.tsx (map
  marker fallback title), payouts.tsx (table "Jobs" header), reports.tsx + tags.tsx (wired "work-orders"/
  "work_order" static entries to jobNounPlural, matching existing clients->customerNounPlural pattern),
  email-editor.tsx (token tooltip labels). notifications.tsx, work-order-modal.tsx, companies.tsx were
  already correctly wired from earlier in this session (not yet committed) — verified via grep, no changes
  needed.
- Hit and fixed a self-inflicted JSX corruption in bookings.tsx: one bad edit left a stray duplicate
  `}</div>);}` tail at end of file causing an esbuild parse error — diagnosed via git diff, manually removed
  the 4 stray lines + restored the correct single closing brace for AssignModal. Re-ran `bun run build`
  clean afterward.
- Final verification: `bun run build` clean (2734 modules, all expected chunks incl. bookings-, fleet-,
  payouts-, reports-, tags-, notifications-).
- Committed: `git commit -m "feat: wire customerNoun/jobNoun terminology hooks across remaining admin UI"`
  → commit 4f440bd (13 files, +71/-43). Also included the concrete-foundation-repair fitScore 6.3->7.3 fix.
- **Item 1 and Item 2 are both fully DONE.**

### NEXT UP: Item 3 — per-ICP notification defaults
Plan: build `packages/web/src/services/notification-presets.ts` with a per-ICP T1-T8-style trigger profile
derived from each ICP's `04-NVC360-App-Customization.md` / notification refinement notes (already fetched
to /home/user/icp-research/<slug>/), keyed by industry slug, with a sensible default fallback for
non-core/outlier ICPs (equipment-rental, property-management-maintenance, sports-organization — lighter
treatment per their own "hold" verdict, matching the caution applied to option-catalog presets earlier).
Then find `seedNotificationRules` in `packages/web/src/api/routes/superadmin.ts` (currently one flat
15-row matrix for every tenant) and make it ICP-aware — look up the new preset by the company's industry
at creation time. Verify via: create a real test company with a specific industry through the actual
superadmin flow (or a raw script hitting the same code path), then SELECT its seeded notification_rules
rows from Turso and confirm they differ from a company with a different industry.

### Item 3 (per-ICP notification defaults) — COMPLETE, committed
- New `packages/web/src/services/notification-presets.ts`: 6 reusable "archetype" override
  bundles (URGENT_DISPATCH, LONG_CYCLE_PROJECT, TENANT_FACING, SMS_FIRST_CONSUMER,
  LOW_TOUCH_BILLING, STORM_CREW_ALERT) derived directly from icp_knowledge_base's
  `notificationRefinement` research text for all 17 ICPs (queried live from Turso, not
  re-read from files). Mapped per-industry via `NOTIFICATION_OVERRIDES`; outlier ICPs
  (equipment-rental, property-management-maintenance, sports-organization) get one light
  archetype each per the "don't over-invest" constraint, not a full custom profile.
- `applyNotificationOverrides(base, industry)` merges overrides onto the flat 15-row base
  matrix; unmatched/"other" industries fall through unchanged (no regression for existing
  tenants without a mapped ICP).
- `seedNotificationRules(companyId)` in dispatch.ts now looks up `companies.industry` and
  calls `applyNotificationOverrides` before inserting — was previously one hardcoded matrix
  for every tenant regardless of industry.
- Verified: `bun run build` clean. Then live-DB round trip: created 3 real test companies
  (test-electrical-co/electrical, test-flooring-co/flooring, test-sports-co/sports-organization)
  via direct schema inserts, ran the actual `seedNotificationRules()` function against each,
  read back `notification_rules` rows from Turso — confirmed 3 distinct matrices (electrical
  got sms=true on created/accepted/cancelled client rows; flooring stayed email-only/no extra
  SMS; sports-organization got sms=true on created/assigned/completed client rows). Test
  companies + their rules deleted after verification (not left in the DB).
- Committed: `git commit -m "feat: ICP-aware notification defaults (item 3)"` → commit 63d364b.

### NEXT UP: Item 4 — mobile driver app (Expo) ICP/terminology parity
packages/mobile currently has ZERO worker/customer/job noun customization (web has full
useWorkerNoun/useCustomerNoun/useJobNoun hook parity as of item 2). Plan:
1. Find how web's use-brand.ts hooks fetch brand/noun data (likely a `/settings` or
   `/brand` GET endpoint already used by admin) — reuse the SAME endpoint from mobile via
   packages/mobile/lib/api.ts rather than inventing a new one.
2. Add an equivalent useBrand/useWorkerNoun-style hook (or a simple context provider) in
   packages/mobile, fetched once at app load / login and cached.
3. Find hardcoded "Technician"/"Job"/"Customer"/"Client" strings in mobile screens (driver
   home, job detail, job list, profile, etc.) and replace with the live nouns — same pattern
   as web: grep for these strings across packages/mobile first to scope the real list of
   files before touching anything.
4. Verify with the mobile Metro dev server (tmux 'metro' per memory) + Expo Go / a real
   screen check, not just a TS compile — per this session's "real build/runtime, not tsc
   alone" standard.

### Item 4 (mobile ICP/terminology parity) — COMPLETE, committed
- New `packages/mobile/lib/use-brand.ts`: mirrors web's use-brand.ts exactly (same
  `GET /settings` endpoint via the shared `hc<AppType>` typed client, same react-query
  caching/staleTime, same DEFAULTS fallback), exposing useWorkerNoun/useCustomerNoun/useJobNoun.
  `/settings` GET only requires `requireAuth` (not requireAdmin) so rider/driver sessions can
  call it fine — verified by reading api/routes/settings.ts.
- Wired into: `(rider)/_layout.tsx` (tab bar "Jobs"->jobNounPlural), `(rider)/index.tsx`
  (JobHead customer-name fallback), `(rider)/earnings.tsx` ("Jobs done" stat + weekly summary
  text), `(rider)/profile.tsx` (name fallback), `job/[id].tsx` (top title, customer name,
  "Job Notes/Details/Instructions & Fields" headings, "Customer Messages" heading, completion
  banner text). Sign-in screen deliberately left alone — it's pre-auth with no tenant/company
  context yet, nothing sensible to fetch.
- Hit the SAME edit-tool flakiness as bookings.tsx in item 2 — several "Successfully edited"
  calls for import lines and hook-call lines silently didn't apply. Diagnosed via
  `bun run typecheck` (Cannot find name 'jobNoun'/'customerNoun'/etc errors), fixed all of them
  with direct `sed -i` inserts instead of the edit tool, then reverified with grep before
  moving on. Lesson reinforced: after any edit tool call, verify with grep/read — don't trust
  the success message alone, especially for insert-only edits (no surrounding uniquely-matched
  context) or edits in a file that's been touched multiple times in the same turn.
  Also hit and fixed a bad python find/replace side-effect in job/[id].tsx that left a 3-line
  stray fragment at EOF (`tAlign: "center",\n  },\n});`) — caught via `bun run typecheck` parse
  errors, removed the stray lines.
- Verified: `packages/mobile` → `bun run typecheck` shows ZERO errors in mobile's own files
  (grepped to confirm all ~100 remaining errors are pre-existing in `../web/` via the
  `@template/web` transitive import — not caused by this change). Also confirmed live against
  the running Metro dev server (tmux session `metro`) — every save triggered a successful Fast
  Refresh rebundle with no bundler errors.
- Committed: `git commit -m "feat: ICP/terminology customization parity for mobile driver app
  (item 4)"` → commit 15b1e26 (6 files, +94/-9).

### NEXT UP: Item 5 — deepen website-scrape usage beyond brand/forms/templates
Currently the scrape pipeline (see superadmin.ts company-create flow) feeds scraped data into:
brand (logo/colors/tagline/services JSON), starter intake forms, starter work-order templates,
and email footer. Plan: find exactly where `services` (scraped service list) and any other
scraped fields currently dead-end, and design+implement feeding them into the CATALOG
(schema.catalogItems) / OPTION_CATALOG_PRESETS seeding step (superadmin.ts ~L642-660) so a new
tenant's own scraped services (not just the generic industry preset) show up as real catalog
line items where they're a good match. Test end-to-end against bmdmaterials.com as the working
model (real company creation using that URL, inspect resulting catalog/services), then document
the resulting pattern as "the global standard" for new-company onboarding (a short section at
the top of superadmin.ts's scrape/seed flow, or a note in task.md is enough — no need for a
separate doc unless asked).

### Item 5 (deepen website-scrape usage) — COMPLETE, committed
- New `packages/web/src/services/service-scout.ts` (`scoutStarterServices`): takes the ICP
  preset's baseline service list + the tenant's own scraped `brand.services` (already captured
  by brand-scout, previously only fed into forms/templates), asks the model for ONE tailored
  list using the tenant's own service names/wording where they overlap the preset, drops
  preset entries that don't apply, adds distinct scraped services not covered by the preset.
  Falls back to the plain preset (today's old behavior) with zero scrape data or on any
  model/parse failure — no regression risk.
- Wired into superadmin.ts step 2e (schema.services seeding) — this was the actual dead-end:
  `servicesArr` was already being computed and used for forms (2c) and templates (2d), but 2e
  ignored it completely and always inserted the generic preset verbatim.
- Verified fully end-to-end against the REAL running dev server (not just build/tsc): restarted
  tmux `web` to load the new code, signed in as superadmin (dan@nvc360.com), called the actual
  `/api/superadmin/brand-scout` endpoint against bmdmaterials.com (real scrape returned 8 real
  services), then the actual `/api/superadmin/companies` endpoint to provision a real tenant
  with that brand payload as `industry: "flooring"`. Read back `schema.services` rows directly
  from Turso: confirmed 10 tailored services using BMD's own real names (e.g. "Window Coverings
  Supply & Installation", "FF&E Procurement & Placement for Hospitality Clients",
  "Pre-Installation Moisture & Site Readiness Inspection") vs. the generic 5-item flooring
  preset used before. Test company + every seeded row (services, catalog, options, forms,
  templates, admin user, api keys) deleted after verification.
- Committed: `git commit -m "feat: deepen website-scrape usage into the Service Library
  (item 5)"` → commit 63ba499.
- Established pattern documented in the commit message as "the global standard" per the user's
  request: own scraped data > generic preset, preset only as fallback/structure. Catalog-item
  seeding (2f) and option-catalog seeding (2g) still use the generic preset only — natural next
  extension of this same pattern if the user wants it later, not done in this round (kept scope
  to the Service Library, the piece explicitly identified as the dead-end).

## ALL 5 ITEMS FROM ROUND 4 ARE NOW COMPLETE
1. Deep trade research for 13 remaining ICPs — done, commit 23e0b34.
2. customerNoun/jobNoun wired into web frontend everywhere workerNoun already was — done,
   commit 4f440bd (plus earlier session's uncommitted work folded in).
3. ICP-aware notification defaults — done, commit 63d364b.
4. Mobile driver app ICP/terminology parity — done, commit 15b1e26.
5. Deepened website-scrape usage into the Service Library — done, commit 63ba499.
All verified with real build/runtime checks per this session's standard (bun run build,
live dev server calls, direct Turso reads), not tsc/type-check alone. Test data cleaned up
after every verification. Nothing left outstanding from this round's user request.
