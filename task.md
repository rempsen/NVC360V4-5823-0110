# NVC360 — hardening pass scratchpad

## Gate baselines (run from packages/web unless noted)
- `bun test src` (do NOT source root .env) → **357 pass / 0 fail**
- `bunx tsc --noEmit -p tsconfig.app.json` → non-TS2769 errors == **159** (TS2769 Hono chain = known false positive)
- `bunx oxlint packages/web packages/mobile --deny-warnings --no-error-on-unmatched-pattern` (repo root) → **0**
- `bunx vite build` (NEVER `bun run build`) → ok
- `python3 crash-sweep.py` → ALL CLEAN (25 real admin routes)
- `python3 a11y-gate.py` → PASS 25 pages × 2 widths
- mobile: `bunx tsc --noEmit` filtered `^(app|lib|components)/` → empty; `npx expo export --platform ios` succeeds

## Done
- `774a0f1` cross-company driver earnings, every row labelled with its company
- `2feceda` phone layouts for work orders + directory; both gates were auditing 404 phantom routes — fixed, added hscroll check
- rate limiter no longer fails open when Redis is down → falls back to bounded in-process MemoryStore + debounced infra alert

## Batched for the next EAS iOS build
- cross-company Earnings screen (`774a0f1`)

## Backlog (next)
1. Public intake hardening leftovers: no honeypot/CAPTCHA on `POST /api/public-forms/:companyId/:slug/submit` (IP-keyed rate limit only); hand-typed addresses can bypass zone enforcement.
2. Score the booking/customer flow, append to `admin-review.report/content.md`.
3. Customer-facing email/SMS copy review + per-tenant send-from domain test.

## Dan's manual items
- separate `nvc360-web` Sentry project + `VITE_SENTRY_DSN` in Runable publish settings
- resolve/ignore Sentry `REACT-NATIVE-9`; revoke old key ending …744457c
- test Accept and Decline on a TestFlight build (untested since build 13)
