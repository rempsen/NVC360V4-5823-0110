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

## IN FLIGHT — customer change requests (reschedule / cancel)
Dan's decision (Aug 14): reschedule = self-serve outside cutoff; cancel = ALWAYS a request the
office approves. Per-tenant toggles. Default cutoff 12h. Notify office (in-app+email), assigned
tech, and the customer.
- [x] schema: company_settings.allowCustomerReschedule / allowCustomerCancelRequest /
      customerChangeCutoffHours + new `booking_change_requests` table (db:generate → db:migrate)
- [x] `src/shared/change-policy.ts` pure evaluator + 11 tests (failed first, then green)
- [x] events: `rescheduled` / `change_requested` / `change_declined` in dispatch NvcEvent +
      EVENT_META + defaultMessage + seed matrix + job-events kinds + backfill for existing tenants
- [x] API: GET /api/bookings/:id/change-policy, POST /:id/reschedule, POST /:id/cancel-request;
      HARDEN existing POST /:id/cancel (today a customer can hard-cancel their own job by API)
- [x] API: /api/change-requests list/approve/decline (admin) + pending count
- [x] API tests `src/api/routes/__tests__/change-requests.test.ts` — 29 tests. Caught a REAL gap:
      BASE_RULES had no seeds for the 3 new events, so ensureEventRules backfilled nothing and no
      tenant would have been notified. Fixed (8 seed rows). Sabotage-checked (requestCancel writing
      status=cancelled -> 3 failures -> restored). Suite now 416 pass / 0 fail (was 376).
      release-job.test.ts "still lets the owning customer cancel" intentionally superseded: now
      asserts 409 + useEndpoint.
- [x] admin settings UI toggles (Reschedule / Cancel-request switches + cutoff hours, clamped 0-336)
- [x] admin approval queue `/admin/change-requests` + sidebar badge (polled count, never breaks the shell)
- [x] customer UI on /app/track/:id — `AppointmentChangeCard`, day-grouped slot picker, pending-request state
- [x] full gate set green: 416 tests / tsc 159 / oxlint 0 / vite build ok / crash-sweep ALL CLEAN (26) /
      a11y PASS (26 x 2) / customer-sweep PASS (12 x 2). crash-sweep + a11y-gate now include the new page.
- [x] LIVE verified end-to-end on real Turso with throwaway probe rows (all deleted, deletion verified):
      policy JSON self_serve/request; self-serve reschedule moved scheduled_at; inside-cutoff reschedule
      created a pending row WITHOUT moving the job; customer POST /cancel -> 409 + useEndpoint;
      duplicate request -> 409; admin approve (reschedule -> new time, cancel -> cancelled), double
      approve -> 409, decline left the booking untouched; customer 403 on the admin list; bad status 422;
      settings toggle off -> reschedule "blocked" for the customer; cutoff 9999 clamped to 336.
      Also driven through the real browser: customer sent a cancellation request from /app/track, admin
      saw it (sidebar badge 1) and approved it in the UI -> booking went to cancelled.
- [ ] needs a web Publish from the Runable UI (Dan)

## IN FLIGHT — running-late notices
Product shape (Dan, Aug 2026): auto-DETECT always, dispatcher gets first refusal,
auto-send after a grace period if nobody acts. Threshold default 15 min (per tenant).
Triggers: tech hasn't started the drive by the promised time, OR enroute with a live ETA
landing past it. Customer told by SMS + in-app + tracking-page banner. NO email.
Inform only — no reschedule link.

- [x] shared/delay-policy.ts pure evaluator + 21 tests (failed first, then green)
- [x] schema + migration 0011 applied to live Turso (5 booking cols, 3 settings cols)
- [x] dispatch.ts `delayed` event, copy, template vars, seed rules (client = in-app + SMS only)
- [x] BUG FIXED en route: dispatch context() `when` formatted on the SERVER's clock, so every
      outgoing SMS/email quoted appointment times in the wrong timezone. Now uses companyTimeZone().
- [x] services/delay-watch.ts sweep (flag / clear / notify), 60s interval in server.ts
- [x] api/routes/delays.ts (list, count, notify, mute) — re-evaluates server-side so a stale tab
      can't text about a job that's fine
- [x] settings PUT allow-list + normalisation (threshold 5-240, auto-send 0-240)
- [x] 27 route/sweep tests green; 9-mutation sabotage battery — every behaviour caught by a
      named test (same-pass notify, mute, quiet gap, growth check, arrived, lookback, stale tab,
      admin guard, guessing a promised time)
- [x] admin settings card (enable / threshold / auto-send after)
- [x] dispatcher board on the admin dashboard (Send now / Mute, hides itself when nothing is late)
- [x] customer banners: public /t/:token and portal /app/track/:id — only after the notice was
      actually sent, and never once the tech is on site
- [x] LIVE verified on real Turso with throwaway probe rows (all deleted, deletion verified; the
      tenant's `delayed` rules were forced disabled first so nothing could actually text anyone):
      19/19 — flag without notifying, on-time/arrived/no-schedule/yesterday untouched, ETA overrun
      caught before the slot passed, grace held then auto-sent, job event written, no notification
      rows, no nagging on the next pass, mute respected, flag cleared on catch-up, board + count.
      HTTP: Send now 200, not-late 409, unknown/cross-tenant 404, unauthenticated 401, mute 200.
      Browser: dashboard board renders with slip/Muted/Send update, settings card + both inputs,
      tracking page banner quotes the revised time in the company's zone with no reschedule link,
      un-notified job shows no banner, zero console errors.
- [x] full gate set green: 464 tests / tsc 159 / oxlint 0 / vite build ok / crash-sweep ALL CLEAN (26)
      / a11y PASS (26 x 2) / customer-sweep PASS (12 x 2)
- [ ] needs a web Publish from the Runable UI (Dan)

## Backlog (next)
1. Customer-facing email/SMS copy review + per-tenant send-from domain test.

## Dan's manual items
- separate `nvc360-web` Sentry project + `VITE_SENTRY_DSN` in Runable publish settings
- resolve/ignore Sentry `REACT-NATIVE-9`; revoke old key ending …744457c
- test Accept and Decline on a TestFlight build (untested since build 13)
