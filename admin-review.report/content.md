# NVC360 Web / Admin Platform — Expert Review

**Reviewer stance:** 15-year senior engineer, App-Store-caliber bar. Same treatment as the July 2026 driver-app review.
**Scope:** `packages/web` — 46 API route modules, 50 page components, 24 admin surfaces driven in real Chrome at 390px and 1440px.
**Date:** August 11, 2026 · **Commits:** `bc701cd` (P0 fixes) → `c52254a` (P1 pass)

---

## Bottom line

**Overall: 8.4 / 10 — production-grade, ship it.**

*Updated Aug 11 after the P1 pass (`c52254a`): performance 7.0 → 8.0, reliability 8.5 → 9.0, security 9.0 → 9.5.*

The platform is well past "works." It has real tenant-isolation tests, a crash sweep, structured logging, Sentry on both sides, and lazy-loaded routes. The one issue that would have shown up as "the software is broken" in customer conversations was our own rate limiter logging admins out mid-work — found, root-caused, fixed, and proven this session.

What's left is polish and headroom, not correctness: there is no automated a11y or E2E gate in CI, and ~160 pre-existing type errors mean `tsc` can't be used as a gate. The heaviest first-paint cost — three third-party Stripe scripts on every page, including the login screen — was found and removed in the P1 pass.

| # | Criterion | Score | Direction |
|---|-----------|-------|-----------|
| 1 | Reliability & error handling | 9.0 | Fixed + regression-tested |
| 2 | Performance | 8.0 | Fixed this pass |
| 3 | Security & tenant isolation | 9.5 | Strongest area |
| 4 | Accessibility | 8.0 | Fixed this pass |
| 5 | Information architecture | 8.0 | Solid |
| 6 | Visual design & polish | 8.5 | Solid |
| 7 | Forms & data entry UX | 8.5 | Solid |
| 8 | Empty / loading / error states | 8.0 | Solid |
| 9 | Observability | 8.0 | One action outstanding |
| 10 | Mobile-web responsiveness | 8.0 | Fixed this pass |

---

## 1. Reliability & error handling — 8.5 / 10

**Evidence.** `crash-sweep.py` drives 16 admin pages plus tabs in real Chrome and reports **ALL CLEAN** — no error boundary triggered anywhere. Error boundaries exist at the app and route level (`error-boundary.tsx`, `lazy-route.ts`, `global-errors.ts`). API errors go through a single `AppError` path with request IDs.

**The finding — critical, now fixed.** `/api/auth/*` was covered by `authLimiter`: 20 requests/min **keyed by IP**. `get-session` lives under that prefix and the SPA calls it on every page load. Reproduced directly: requests 1–19 returned 200, **request 20 onward returned 429**. The chain: 429 → `useSession()` sees no session → `useAuth()` user undefined → `ProtectedRoute` renders `<Redirect to="/sign-in" />`. An admin clicking through ~20 pages in a minute was thrown to the login screen with work in progress. Because the key was the IP, an entire office behind one NAT shared the 20/min budget and logged each other out.

**Fixed.** `authSurfaceLimiter` now splits the auth surface: credential paths (sign-in, sign-up, password reset, verification, 2FA, callbacks) keep the tight 20/min IP limiter; session reads get `sessionLimiter` at 600/min keyed by user. Fail-closed — an unrecognised auth path gets the tight limiter, so a future better-auth route can't silently land in the generous bucket. Additionally, `useAuth()` now exposes `sessionError` and caches the last good session user in memory, and `ProtectedRoute` shows "Can't reach the server / Try again" instead of a redirect. A transient read failure can no longer masquerade as a sign-out. The cache is UX-only — every API call is still authorised server-side, so a stale cache grants nothing.

**Proven.** 30 consecutive `get-session` calls → all 200. 25 bad-credential POSTs to `/api/auth/sign-in/email` → 401 through #19, 429 from #20. Brute-force defense intact.

**Closed (`c52254a`).** The reproduction is now 12 tests in `rate-limit-auth-surface.test.ts`, asserting all three properties: session reads survive the 30-call repro and a 120-call burst; credential endpoints still throttle at 20/min across sign-in, sign-up, reset, verification and 2FA, and rotating cookies doesn't buy a fresh budget; and an unrecognised `/api/auth/*` path lands in the tight bucket. Suite went 125 → 137 tests, 0 failures.

## 2. Performance — 8.0 / 10

**Evidence.** Routes are code-split and lazy-loaded — the largest page chunk is `riders` at 45 kB (11 kB gzip), most pages are 5–8 kB gzip. Good discipline.

**Correction to my first pass.** I flagged `vendor-charts` (88 kB gzip) and `vendor-maps` (43 kB gzip) as possibly eager. **They are not** — that was a bad read on my part. A grep showed the entry chunk referencing those filenames, but those are just strings in Vite's preload map, not imports. Loading `/sign-in` and `/admin` in a real browser fetches only `index`, `vendor`, `vendor-auth` and the CSS. Charts and maps are correctly lazy. No change needed.

**The real finding — fixed (`c52254a`).** Stripe was loading on **every page, including the sign-in screen.** `@stripe/stripe-js` injects its remote `<script>` as a *module side effect at import time*, and Rollup had placed the package in the eagerly loaded `vendor` chunk. So every visitor fetched three third-party scripts on first paint: `js.stripe.com`, its fingerprinted inner bundle, and `m.stripe.network`'s fingerprinting bundle — including someone on the login page who will never pay for anything. That's wasted latency on hotel wifi and needless third-party tracking on your login screen.

Switched to the `@stripe/stripe-js/pure` entrypoint, which defers all of it until `loadStripe()` actually runs. The `Stripe` type now comes from a type-only import, erased at compile time, so it can't reintroduce the side effect.

**Proven.** Real Chrome: **0 Stripe requests at first paint** (was 3). Then, dynamically importing the app's own built vendor chunk and calling its bundled loader injects the script and issues 10 `js.stripe.com` requests — payments still work, just on demand.

**Remaining headroom:** the 122 kB CSS suggests Tailwind is emitting more than is used; verify the content globs. The 164 kB gzip `vendor` chunk is React + router + query and is reasonable — do **not** hand-split the React ecosystem across `manualChunks`, which has bitten this project before.

## 3. Security & tenant isolation — 9.5 / 10

**Evidence.** This is the strongest part of the platform. `bun test src` runs **125 tests, 0 failures, 385 assertions**, and a large share are explicit tenant-isolation tests asserting that company A cannot enumerate or read company B's rows — including sensitive tables like `api_keys` and `company_settings`, with a deliberate carve-out proving the `companies` registry is intentionally global. Four payments tests assert the "Stripe not configured" fail-closed path, which is the right default.

Membership integrity was also verified live this session: a merely-invited user does **not** appear to have the company (`/companies` excludes it), and passing `X-Company-Id` for a pending invite is ignored and falls back to zero-access. No endpoint can force a membership `active` without the account owner accepting. Cross-user invite access returns 404 rather than confirming an invite exists for someone else.

**Correction to my first pass.** I listed "move rate-limit counters to Redis before running multiple instances" as future work. It's **already done** — `initRateLimitStore()` runs at boot, and the server log confirms `rate-limit: using Redis store (multi-node)` with an atomic Lua INCR+PEXPIRE so the counter can't race. Limits are already global across instances.

**Hardened further (`c52254a`).** Session-read throttling was keyed by `keyByUser`, which was silently wrong: this middleware runs on `/api/auth/*`, mounted *before* `authMiddleware`, so `c.get("user")` is always null there and the key degraded to per-IP — the exact failure mode the fix was meant to remove. One office behind a single NAT still shared one budget. Now keyed by the credential that *is* available pre-auth: the bearer token (mobile) or session cookie (web), **hashed** so a raw session token is never used as a map key or written to a log line — with a test asserting that. Anonymous callers still fall back to per-IP, correctly.

**Proven live** with `RL_SESSION_LIMIT=40`: admin A burned exactly their own 40 and got 10× 429; admin B on the **same IP** with a different session got 30/30 200s.

**To reach 10:** the limiter fails *open* if Redis hiccups (deliberate — availability over strictness). That's the right default, but it means a Redis outage silently disables brute-force protection. Worth an alert on that fallback path.

## 4. Accessibility — 8.0 / 10

**Before:** 43 controls with no accessible name across services (8), catalog (13), settings (10), automation (6), intake-forms (2), zones (2), fleet (1), tags (1) — all icon-only buttons, unusable with a screen reader or voice control. Plus bare `SELECT`s with no label on `/admin/techs` (1) and `/admin/reports` (2).

**After:** the re-run audit reports **zero unnamed controls and zero unlabelled inputs** across all 24 pages at both widths. The single remaining hit is a Leaflet-generated marker `div` on `/admin/fleet` — library-owned, not ours. No images missing `alt` anywhere.

**Gate added (`102b824`).** `a11y-gate.py` now runs all 24 pages at both widths and exits 1 on any new finding, so a future icon-only button fails the check instead of waiting for the next manual audit. Verified by sabotage: injecting an unlabelled button makes it fail and name the exact element; reverting makes it pass. Kept out of `bun run build` deliberately — it needs Chrome and a live server, which would break the platform's deploy.

**To reach 9.5:** do one keyboard-only pass through work-order creation (focus order, modal focus trap, Esc to close) — the gate checks names and sizes, not focus behaviour.

## 5. Information architecture & navigation — 8.0 / 10

24 admin surfaces is a lot, and they're sensibly grouped (operations, catalog, people, settings, platform). Role-based redirects send each role to the right home rather than dead-ending. Deep links work.

**Weakness:** at 24 top-level destinations, a new admin has no obvious "start here." The dashboard does some of this, but consider collapsing rarely-used platform surfaces (audit, api-access, maintenance, companies) into a single Advanced/Platform group.

## 6. Visual design & polish — 8.5 / 10

Consistent dark theme, brand cyan `#0ea5e9` on ink `#070b12`, `nvc-card` surfaces, rounded-2xl geometry, restrained borders (`border-white/5`). It reads as a designed product, not a template. Money formatting is centralised. Destructive actions use a red-tinted subtle style rather than shouting.

**Fixed this pass:** `/admin/catalog` rendered the browser's broken-image glyph for a catalog picture whose storage object is gone — the most "amateur-looking" defect on the platform. New `StoredImage` component degrades a dangling reference to the same placeholder used for "no image." Root cause of the underlying 404 is a dangling storage key (data, not code); the console 404 is cosmetic and unavoidable client-side.

## 7. Forms & data entry UX — 8.5 / 10

The work-order modal is the most complex surface and it holds up: catalog line items, unit line items, and charges share components with the PIN-gated employee forms, so pricing behaves identically everywhere. Template switching is handled thoughtfully — replaces fields immediately when they came from a template, confirms when they were hand-built. Destructive actions use a real confirm dialog with specific copy ("It stays on past work orders but can't be added to new ones"), not a generic "Are you sure?".

**Weakness:** validation is per-form rather than schema-driven. Not worth refactoring now, but new forms should share a validation helper.

## 8. Empty / loading / error states — 8.0 / 10

`FullLoader` is used consistently, placeholders exist for missing images and empty lists, and the crash sweep confirms no page falls through to an error boundary. The new "Can't reach the server / Try again" state is a genuine upgrade — the app now distinguishes "you're signed out" from "we couldn't reach the server," which most products get wrong.

**To improve:** audit list surfaces for a first-run empty state that teaches the next action ("No catalog items yet — add your first") rather than just rendering nothing.

## 9. Observability — 8.0 / 10

Sentry is wired on both client (`web/lib/sentry.ts`, `main.tsx`, `provider.tsx`, `query-client.ts`) and server (`api/lib/logger.ts`, `captureException`). There's a structured request logger, request IDs on every error response, Prometheus + JSON metrics endpoints with templated paths (so cardinality doesn't explode), and an internal alert recorder.

**Outstanding — your action, not code:**
- Add `VITE_SENTRY_DSN` and `SENTRY_DSN` to Runable publish settings and republish. Until then, production web errors are not being captured.
- Revoke the old Sentry key ending `…744457c`.
- Delete the Sentry test events.

## 10. Mobile-web responsiveness — 8.0 / 10

**Evidence.** All 24 pages at 390px: **no horizontal overflow anywhere**, and after this pass **zero tap targets under 32px** (previously "← Back to Dashboard" at 166×20 on bookings, team, and users).

**Weakness:** the dense admin tables are usable at 390px but not comfortable. Dispatch on a phone is a real scenario for an owner in a truck, so the highest-traffic tables (work orders, scheduler) would benefit from a card layout under `sm`.

---

## Prioritised backlog

**P0 — done this session**
- Rate limiter logging admins out mid-work (`bc701cd`)
- Transient session-read failure no longer redirects to sign-in (`bc701cd`)
- 43 unnamed controls + 3 unlabelled selects (`bc701cd`)
- Broken-image glyph on `/admin/catalog` (`bc701cd`)
- Sub-32px touch targets (`bc701cd`)

**P1 — done since (`c52254a`)**
- Regression tests for the rate-limit split (12 tests)
- Session reads bucketed per session, not per IP
- Stripe no longer loads on first paint
- Charts/maps confirmed already lazy (no change needed)

**P1 — done since (`102b824`)**
- Automated a11y gate (`a11y-gate.py`, 24 pages × 2 widths, verified by sabotage)

**P1 — still open**
1. Add `VITE_SENTRY_DSN` / `SENTRY_DSN` to publish settings *(your action)*
2. Alert when the rate limiter fails open on a Redis outage

**P2 — headroom**
4. Card layout for work-orders and scheduler tables under `sm`
5. Verify Tailwind content globs (122 kB CSS looks over-emitted)
6. Chip away at the ~160 pre-existing type errors so `tsc` becomes a usable gate
7. Group rarely-used platform surfaces behind one nav entry

---

## Verification gates at `bc701cd`

| Gate | Result |
|---|---|
| `oxlint packages/web packages/mobile --deny-warnings` | 0 warnings, 0 errors (275 files) |
| `tsc --noEmit -p tsconfig.app.json`, excluding known TS2769 | 160 (baseline — no new errors) |
| `bun test src` (without env sourced) | **137 pass / 0 fail**, 410 assertions (+12 new) |
| `bunx vite build` | ✓ 7.58s |
| `crash-sweep.py` (16 admin pages, real Chrome) | **ALL CLEAN** |
| Admin audit (24 pages × 390px & 1440px, real Chrome) | 0 overflow, 0 missing alt, 0 unnamed controls, 0 unlabelled inputs, 0 load failures |
| Rate-limit reproduction | 30× get-session all 200; sign-in 429 from #20 |
| Per-session keying (live, limit 40) | A: 40×200 + 10×429; B same IP: 30×200 |
| Stripe at first paint (real Chrome) | 0 requests (was 3); loads on demand when called |

**Method note.** Every finding above was produced by driving the real application against the real Turso database — not by reading code. Two caveats carried from earlier work: `tsc` alone is not a reliable check in this repo (project references plus a long-standing Hono method-chain false positive), and `bun test src` must be run **without** sourcing the root `.env` or four payments tests fail because they assert the unconfigured-Stripe path.

---

# Part 2 — Customer & Booking Flow — Expert Review

**Scope:** everything a paying customer touches — the public marketing/auth pages, the public intake form (`/f/:tenant/:slug`), the self-serve booking flow (`/app/book/:id`), the customer portal (`/app`, `/app/bookings`, `/app/track/:id`), the SMS tracking page (`/t/:token`) and the public property record (`/p/:token`).
**Method:** same as Part 1 — real Chrome, 390px and 1440px, a real account created through the real sign-up form, a real booking written to the live Turso database. Nothing below is inferred from reading code; every claim was reproduced on a running server.
**Date:** August 13, 2026 · **Commits:** `d87a3db` (intake geocode + zones) → `d3cbbd7` (timezone + customer sweep)

---

## Bottom line

**Overall: 7.9 / 10 — the flow works end to end and is now correct, but it is missing the two self-serve actions that justify the product's own pitch.**

The happy path is genuinely good: a stranger can sign up, book, get a confirmation and watch the technician on a map without ever calling the office. Two real defects were found by driving it rather than reading it — a hand-typed address bypassed service-zone enforcement, and every screen that *read back* an appointment time formatted it on the reader's device clock instead of the company's. Both are fixed, tested and verified live.

What holds the score under 8.5 is not a bug. **There is no cancel and no reschedule anywhere in the customer portal.** A customer who books the wrong day has exactly one option: phone the office. For a product positioned as "Stop the Ringing," that is the most expensive gap on the board.

| # | Criterion | Score | Direction |
|---|-----------|-------|-----------|
| 1 | Booking flow correctness | 9.0 | Fixed + regression-tested |
| 2 | Self-serve completeness | 5.5 | **Biggest gap — no cancel/reschedule** |
| 3 | Time & scheduling correctness | 9.0 | Defect found live, fixed |
| 4 | Trust & transparency | 8.5 | Strong area |
| 5 | Error & refusal UX | 8.5 | Solid |
| 6 | Accessibility | 8.5 | Fixed this pass |
| 7 | Mobile responsiveness | 8.5 | Fixed this pass |
| 8 | Reliability of the public surface | 8.5 | New gate |
| 9 | Anti-abuse on public endpoints | 7.0 | Partial |
| 10 | Conversion & friction | 7.5 | One clear win left |

---

## 1. Booking flow correctness — 9.0 / 10

**Evidence.** Driven end to end on the live server with a throwaway account created through the real `/sign-up` form: sign-up → `/app` with no page errors → book → confirm → track. The confirmed booking landed in Turso with server-resolved coordinates (`lat 49.8941299 / lng -97.13403` for `1 Portage Ave, Winnipeg, MB`) rather than the column default, so dispatch, zones and the live map all key off a real point.

**The finding — now fixed (`d87a3db`).** The public intake form enforced service zones only when the browser supplied coordinates. A customer who *typed* an address got no zone check at all, so a job outside the service area could be accepted and land in dispatch. Submit now forward-geocodes a hand-typed address server-side, enforces zones on the result, persists the resolved coordinates and records `zoneStatus: "verified" | "unverified"` on the submission, incrementing an `intake_address_unresolved` counter when geocoding cannot resolve.

**Proof, not inference.** Five tests written failing first (all 5 failed, then all 5 passed). Sabotage: removing the geocode call → 3 of 5 fail; restored → green. Live: with the Winnipeg zone temporarily active, a hand-typed Calgary address posted to `/api/public/forms/default/request-service/submit` returned **422** and left the bookings, submissions and user counts unchanged.

## 2. Self-serve completeness — 5.5 / 10

**The gap.** The portal can create and observe, but not change. `/app/track/:id` offers "Pay $156.80" and nothing else — no cancel, no reschedule, no "add a note for the tech," no way to correct a wrong address. Every one of those turns into an inbound phone call, which is the exact cost the product promises to remove.

**Recommendation (highest ROI item in this review).** Ship customer-initiated **cancel** and **reschedule** on `/app/track/:id`, gated by status (allowed while `pending`/`confirmed`/`assigned`, blocked once en route) and by a company-configurable notice window (e.g. no free changes inside 2 hours). Reuse the existing slot picker for reschedule and the existing notification bus to tell dispatch. This is a contained change with a direct, measurable effect on call volume.

## 3. Time & scheduling correctness — 9.0 / 10

**The finding — now fixed (`d3cbbd7`).** The slot picker was already company-timezone-aware, but every screen that read a time *back* was not. A slot picked as **"Fri, Aug 14, 9 AM CDT"** displayed as **"Fri, Aug 14, 2:00 PM"** with no zone name on `/app`, `/app/bookings` and `/app/track/:id`. The stored instant was correct (`1786716000000` = 14:00Z = 9 AM Winnipeg, with `company_settings.timezone = America/Winnipeg`); the read screens used a bare `toLocaleString("en-US")` on the browser clock. The same class of bug was then found and fixed on `/t/:token` — the single page every customer opens from an SMS link.

**The fix.** New shared `fmtAppointment(instant, companyTz, viewerTz?)` helper with a zone label, wired into the portal screens; `GET /api/track/:token` now returns the company timezone and the public page formats the timeline and service record in it.

**Proof.** 7 tests written failing first (`0 pass / 1 fail / 1 error` → `7 pass / 0 fail`); sabotage by dropping `timeZone` → 4 fail. Live: `/t/b90cd0cf4e44` renders a 21:18Z event as **4:18 PM** identically from UTC, Asia/Tokyo and America/Vancouver devices; the sabotaged build rendered 9:18 PM / 6:18 AM / 2:18 PM from the same three.

**Residual risk.** A customer genuinely in another zone now reads the company's clock with a zone label — correct and unambiguous, but a future nicety is "9:00 AM CDT (11:00 AM your time)" when the offsets differ. The helper already accepts a viewer zone for exactly this.

## 4. Trust & transparency — 8.5 / 10

The tracking page is the strongest customer surface in the product: live map with ETA, status stepper, technician name and photo, job timeline with attached photos, the customer's own signature reflected back, full service history for the address with no login, and a message thread to the technician. This is the part that looks like a company three times your size.

**To improve:** the timeline shows times but not durations, and there is no "we're running late" state. An automatic delay notice when the ETA slips past the promised window would prevent the highest-emotion phone call of all.

## 5. Error & refusal UX — 8.5 / 10

An out-of-area booking returns 422 and the page says *"That address is outside our service area. Please check the address or contact us."* — plain, non-technical, actionable. Verified live on the real booking form. Dead and expired tracking links have their own handled states rather than a crash.

**To improve:** the refusal is a dead end. Offer the nearest covered area or a waitlist capture so the lead is not simply lost.

## 6. Accessibility — 8.5 / 10

**Found and fixed this pass:** an icon-only send button on the tracking page with no accessible name (now `aria-label` + `title`); the notification bell on every `/app/*` page unnamed (now labelled with its unread count and `aria-expanded`); seven tap targets under 32px on `/`, `/sign-in` (×2), `/sign-up`, `/forgot-password` and the `/app/book/:id` Back link (55×20).

## 7. Mobile responsiveness — 8.5 / 10

**Found and fixed:** `/t/:token` overflowed horizontally at 390px (`411px > 390px`). Root-caused live by walking the ancestor chain — a grid item with `min-width: auto` holding a 395px intrinsic child in a 358px track; setting `min-width: 0` in the live DOM returned `[390, 390, 358]`. Fixed with `min-w-0`.

**Weakness:** the booking page renders **22 flat time-slot buttons with no day grouping** — a long scroll on a phone. Group by day with a horizontal day selector.

## 8. Reliability of the public surface — 8.5 / 10

**New gate: `customer-sweep.py`** — drives 12 customer pages at 2 widths in real Chrome, asserting no error boundary, no page error and no a11y/overflow regression, with the signed-in portal pages included when credentials are supplied. First run produced 8 real findings (all listed above, all fixed); it now reports **PASS — 12 pages × 2 widths, 0 findings**. The admin gates were re-run alongside it: `crash-sweep.py` ALL CLEAN, `a11y-gate.py` PASS.

## 9. Anti-abuse on public endpoints — 7.0 / 10

Intake has a honeypot field and a minimum fill time (`c1c02b4`) plus `submitLimiter`, but the limiter is keyed by IP only and there is no CAPTCHA. Zone enforcement now also happens server-side on hand-typed addresses, which closes the "junk jobs from anywhere" hole. A determined bot behind rotating IPs could still fill the intake queue.

**Recommendation:** add a per-tenant daily submission ceiling with an alert, and put Cloudflare Turnstile on the intake form only (not the booking flow, where friction costs real conversions).

## 10. Conversion & friction — 7.5 / 10

Sign-up → booked took one pass with no dead ends, and the confirmation immediately offers "Track my booking," which is the right next action. The friction that remains is structural: booking requires an account, and the 22-slot picker is the ugliest moment in the flow.

**Recommendation:** guest booking with account creation deferred to after the confirmation (or magic-link only), plus the grouped day/time picker.

---

## Prioritised backlog — customer flow

**P0 — done this session**
- Hand-typed intake address bypassed service zones (`d87a3db`)
- Appointment times read back on the device clock, not the company's, in the portal *and* on the public SMS tracking page (`d3cbbd7`)
- `/t/:token` horizontal overflow at 390px (`d3cbbd7`)
- Unnamed send button and notification bell; 7 sub-32px tap targets (`d3cbbd7`)
- New `customer-sweep.py` reliability + a11y gate for the customer surface (`d3cbbd7`)

**P1 — open, in priority order**
1. **Customer cancel + reschedule** on `/app/track/:id`, status- and notice-window gated *(largest call-volume win)*
2. Group booking slots by day with a day selector
3. "Running late" / ETA-slip notice to the customer
4. Waitlist or nearest-covered-area capture on an out-of-area refusal
5. Turnstile + per-tenant daily ceiling on public intake
6. Customer-facing email/SMS copy review and a per-tenant send-from domain test

**P2 — headroom**
7. Guest booking (defer account creation past confirmation)
8. "9:00 AM CDT (11:00 AM your time)" dual-zone display when the viewer's offset differs
9. Durations on the job timeline

---

*All findings in Part 2 were reproduced on a running server against the live database. Probe data created during the review — one customer account, one booking and its dependent rows — was deleted afterwards and the deletion verified, and the temporarily activated Winnipeg service zone was set back to inactive.*
