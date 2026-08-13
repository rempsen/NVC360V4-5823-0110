# NVC360 — hardening pass scratchpad

## Gate baselines (run from packages/web unless noted)
- `bun test src` (do NOT source root .env) → **376 pass / 0 fail**
- `bunx tsc --noEmit -p tsconfig.app.json` → non-TS2769 errors == **159** (TS2769 Hono chain = known false positive)
- `bunx oxlint packages/web packages/mobile --deny-warnings --no-error-on-unmatched-pattern` (repo root) → **0**
- `bunx vite build` (NEVER `bun run build`) → ok
- `python3 crash-sweep.py` → ALL CLEAN (25 real admin routes)
- `python3 a11y-gate.py` → PASS 25 pages × 2 widths
- `python3 customer-sweep.py` → PASS 12 customer pages × 2 widths (set CUSTOMER_EMAIL/CUSTOMER_PW for the 5 signed-in pages, else 7)
- mobile: `bunx tsc --noEmit` filtered `^(app|lib|components)/` → empty; `npx expo export --platform ios` succeeds

## Done
- `d87a3db` intake geocode + zone enforcement on hand-typed addresses (5 tests, sabotage-checked, live 422)
- `d3cbbd7` customer/booking flow pass: new shared `fmtAppointment` (7 tests, sabotage-checked) so portal + public /t/:token read appointment times in the COMPANY tz with a zone label instead of the device clock — verified live identical from UTC / Asia/Tokyo / America/Vancouver (sabotage build differed by device). Also `/t/:token` 390px overflow (min-w-0), send-button + notif-bell accessible names, 7 sub-32px tap targets, and new `customer-sweep.py` gate.
- Part 2 of the review (customer & booking flow, 7.9/10) appended to `admin-review.report/content.md`
- Probe data deleted from live Turso (user zzprobe-cust@example.test + booking 7de0d1e7 + dependents), deletion verified; Winnipeg service zone set back to active=0 (verified)
- `774a0f1` cross-company driver earnings, every row labelled with its company
- `2feceda` phone layouts for work orders + directory; both gates were auditing 404 phantom routes — fixed, added hscroll check
- `3e7203d` rate limiter no longer fails open when Redis is down → bounded in-process MemoryStore + debounced infra alert
- public intake: a hand-typed / pasted address (no autocomplete coords) skipped zone enforcement AND recorded the job at the lat/lng column default (downtown Toronto). Route now calls forwardGeocode() like the other two booking-create paths, enforces on the result, persists it, and flags `zoneStatus: "unverified"` when the address can't be resolved (lead is never lost). Live-verified: hand-typed Calgary address vs an active Winnipeg zone -> 422, zero writes.
- `c1c02b4` public intake bot guard: honeypot (`_hp`) + minimum fill time (`_ts`, 2.5s), fail-quiet with zero writes, `intake_bot_blocked` metric; the page holds its own submit until the window passes so a fast real visitor is never dropped

## Batched for the next EAS iOS build
- cross-company Earnings screen (`774a0f1`)

## Backlog (next)
1. Score the booking/customer flow, append to `admin-review.report/content.md`.
3. Customer-facing email/SMS copy review + per-tenant send-from domain test.

## Dan's manual items
- separate `nvc360-web` Sentry project + `VITE_SENTRY_DSN` in Runable publish settings
- resolve/ignore Sentry `REACT-NATIVE-9`; revoke old key ending …744457c
- test Accept and Decline on a TestFlight build (untested since build 13)
