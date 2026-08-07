# NVC360 web/admin platform fixes (from the 6.4/10 expert review)

## Fix 1 — silent mutation failures  ✅ DONE, committed `e06c5cd`
`bun verify-fix1.ts` → 19/19 PASS. Throwing `apiFetch` + `ApiError` + toast system +
single shared QueryClient with a global `MutationCache.onError`.

## Fix 2 — N+1 + pagination on GET /api/bookings  ✅ DONE, committed `e542c72`
`bun verify-fix2.ts` → 15/15 PASS. 4 queries total regardless of row count.
37→547ms, 87→550ms, 162→555ms (1.02x growth for 4.4x data; old model projected ~9.5s).
Pagination opt-in via `?page`/`?pageSize`; unpaginated capped at MAX_LIST=2000 + `truncated`.

## Fix 3 — zod validation on write endpoints  ✅ DONE, committed `8b39e94`
`bun verify-fix3.ts` → 35/35 PASS. Original probe (empty name, -99999 price, -5 mins,
50k description) now 400 with a field map (was 201). `PUT /api/zones/<unknown>` now 404 (was 500).

---

## Fix 4 — crash reporting + error boundaries  ✅ IMPLEMENTED
- `src/web/lib/sentry.ts` — env-gated on `VITE_SENTRY_DSN`, disabled in dev, no PII,
  no Session Replay, `beforeSend` drops expected <500 ApiErrors.
- `src/web/lib/global-errors.ts` — `unhandledrejection` + `window.error` net,
  stale-chunk-after-deploy detection, de-duped toast.
- `src/web/components/error-boundary.tsx` — `RootErrorBoundary` (full screen) +
  `RouteErrorBoundary` (per role area; auto-resets on navigation, keeps shell alive).
- `provider.tsx` attaches user id + role to reports.
- query-client reports 5xx/unexpected only.
- VERIFIED: with no DSN, Sentry is fully tree-shaken (0 bytes in dist). With a DSN in
  the root `.env`, the DSN + SDK land in the bundle. **DSN is build-time, not runtime.**

## Fix 6 — modal accessibility  ✅ IMPLEMENTED
- `src/web/hooks/use-dialog.ts` — role/aria-modal/labelling, focus in + restore,
  Tab trap, topmost-only Escape, scroll lock. onClose held in a ref so an inline
  arrow at the call site can't re-run the effect and steal focus mid-typing.
- `components/modal.tsx` rebuilt on the hook; backdrop is a div, not a button.
- `components/dialog-panel.tsx` — `<DialogPanel>` drop-in for the 12 hand-rolled
  overlays: services, catalog, stripe-pay, bookings (assign), rider/active (decline),
  automation, maintenance, email-editor (x2), users drawer, riders drawer,
  notifications (drawer + edit-message).

## Fix 5 — replace 12 native confirm()/alert()  ⬜ IN PROGRESS
job-report.tsx:46 · scheduler.tsx:124 · options-catalog.tsx:90,106,232 ·
settings.tsx:54 · services.tsx:79 · bookings.tsx:446,795 · catalog.tsx:205 ·
intake-forms.tsx:320

## Fix 8 — extend validate.ts to remaining raw c.req.json() sites  ⬜ TODO
~91 across 42 route files. Priority by count: notif-config(12), bookings(11),
team/option-catalog/messages/catalog/admin(4 each), tags/superadmin/riders/
public-forms/integrations/custom-fields(3 each).

## Mobile / responsive viewport pass  ✅ DONE (commit 8b840a5)
Audited with `packages/web/audit-responsive.py` (Playwright, real 390px + 768px
viewports over 8 admin pages). 134 issues -> 0. Fixed:
- sr-only escape in bookings.tsx / users.tsx action <th> caused whole-page
  horizontal scroll (doc scrollWidth 524 vs 390 viewport)
- dashboard revenue KPI clipped ("$15,04"): missing min-w-0 on grid items
- catalog / options-catalog / services / inbox had ZERO page padding
- tap targets: scheduler card actions were 16px tall; pills 20-28px; icon
  buttons 36px; leaflet zoom 30x30. Now 44px min below lg (styles.css block)
- /admin/reports raw-export rows overflowed at 768px
Score for the responsive criterion: 7.5/10 (was unscored). Layout and touch
targets are now correct; still no dedicated mobile navigation pattern for the
data tables, which fall back to horizontal scroll.

## Fix 5 note
`bunx tsc --noEmit -p tsconfig.app.json` baseline is 247 errors (all known
false positives). Build with `bunx vite build`, never `bun run build`.
