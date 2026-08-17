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

## IN FLIGHT — audit fixes: server-side timezone leaks + sweep races

Two bugs found in the Aug 16 audit pass.

BUG 1 — the company-timezone fix never reached the rest of the server. dispatch.ts was
fixed last session, but five other places still format on the server's clock (UTC):
  - services/maintenance.ts:134  reminder SMS quotes the WRONG DAY for an evening due date
  - api/routes/public-forms.ts:712  intake email quotes the customer's preferred time 5-6h off
  - api/routes/bookings.ts:1310  voice-note stamps in driver notes are UTC
  - services/ai-dispatch.ts:275  the AI dispatcher is fed the wrong appointment time
  - api/routes/export.ts + job-search.ts  exported job dates roll to the next day after ~6pm

BUG 2 — the running-late notice can text a customer twice.
  a) sendDelayNotice() writes delay_notified_at blind, no compare-and-set: the minute
     sweep and a dispatcher's "Send now" can both read null and both fire.
  b) none of the minute sweeps (sweepDelays, sweepTimeTriggers, pollEmailDomains,
     reconcileAllRiders) are re-entrant-guarded: setInterval does not wait for the
     previous run, so one slow Turso tick over 60s overlaps two passes over the same rows.

- [x] failing tests first (35 new: 8 fmtInZone, 9 oncePerTick, 7 reminder copy, 3 reminder wiring,
      8 delay-notice race) — all confirmed red before implementing
- [x] shared/tz.ts fmtInZone(): the one server-side date formatter, zone always explicit,
      never renders "Invalid Date", normalises the narrow no-break space before AM/PM
- [x] all five timezone call sites now read companyTimeZone(); maintenance reminder copy
      extracted into a pure maintenanceReminderCopy() so the words that go out are testable
- [x] services/tick.ts oncePerTick(): all four minute sweeps in server.ts are now
      re-entrancy guarded (skip, never queue; a throw releases the lock)
- [x] sendDelayNotice() is compare-and-set on delay_notified_at — the loser sends nothing;
      POST /delays/:id/notify passes the state it read and 409s if the customer was already told
- [x] 7-mutation sabotage battery: drop the CAS / sweep opts out of CAS / route drops the
      already-told check / fmtInZone ignores the zone / reminder handler hardcodes UTC /
      oncePerTick stops guarding / oncePerTick leaks the lock on throw — every one caught by a
      named test, all restored
- [x] LIVE on real Turso (probe rows deleted, deletion verified): two simultaneous Send-now
      clicks = one 200 + one 409, exactly one delayed job event, zero notification rows;
      a third click 409s. Export PDF prints 8/17/2026 and "Aug 17, 2026, 8:00 p.m." for a job
      at 2026-08-18T01:00Z (was the next day in UTC). Voice note stamped "Aug 15, 9:37 p.m."
      while the server clock read Aug 16 02:37 UTC. A guarded sweep tick still flags normally.
- [x] full gate set: 499 tests / tsc 159 / oxlint 0 / vite build ok / crash-sweep ALL CLEAN (26)
      / a11y PASS (26 x 2) / customer-sweep PASS (12 x 2)
- [ ] needs a web Publish from the Runable UI (Dan)

NOT live-verified (no safe way without sending real mail): the intake recipient email's
"preferred date" line. Covered by fmtInZone tests + a one-line call site.

---

## IN FLIGHT — customer-facing copy review + per-tenant send-from test

Tenants for the live test (Dan controls both domains, sends authorised by him):
  default       "NVC 360"       contact@nvc360.com        domain nvc360.com     verified
  bmd-materials "BMD Materials" contact@bmdmaterials.com  domain bmdmaterials.com verified
  Control case: allco-electrical has careers@allcoelectrical.com set with NO verified domain row.

Findings from the read-through (to be proven with tests before any fix):
- [x] P0 resolveFromAddress() in services/email.ts skips the verified-domain guard that
      dispatch.ts applies. Its own docblock claims the guard exists. Reachable on the
      Stripe receipt email (notify.ts) and the password-reset email (api/auth.ts), so an
      unverified/unowned tenant domain can be used as the envelope From.
- [x] P0 emailTemplates fmt() has no timeZone — same UTC leak class as fd8d497, missed
      because it lives in email.ts not a route. Also no year.
- [x] P0 Total / Amount rows render the number with no currency symbol ("120.00").
      The receipt SMS says "$149.00"; the receipt EMAIL says "149.00".
- [x] P1 `${appUrl}track/` — WEBSITE_URL only works because the local .env happens to end
      in "/". Production without one yields https://uberize.aitrack/xxx.
- [x] P1 ics attachment description hardcodes "NVC360 service appointment" for every tenant.
- [x] P1 sendEmail's unverified-domain retry compares the global FROM instead of the actual
      sender, and drops replyTo on the retry.
- [x] review-only: no "Reply STOP to opt out" on any client SMS; SMS segment lengths unmeasured.

Found while testing, not from the read-through:
- [x] P0 nvc360.com had gone "failed" in Resend (DKIM TXT drift) while our table still
      said "verified" from a Jul 2026 check. Cause: rowsNeedingPoll() only ever returned
      "pending"/"verifying" rows, so a settled row was NEVER re-checked and a regression was
      permanently invisible. needsPoll() now re-checks verified AND failed rows every
      RECHECK_MS (6h), and syncStatus() logs loudly on a verified -> not-verified regression.
      Live: the poller flipped the row to "failed" and verifiedDomainsForCompany("default")
      went from ["nvc360.com"] to []. DNS repair itself is Dan's action.
- [x] P0 addToCalendar() threw on an unusable scheduledAt (toISOString on Invalid Date),
      which killed the ENTIRE confirmation email instead of dropping the calendar row.
- [x] P0 every client SMS containing an em dash was billed as UCS-2: 160-char segments
      collapse to 70 the moment one character leaves GSM-7. Measured: "—" in 17 of the
      built-in messages, "·" in 1, nothing else. toGsm7() at the send boundary (so
      tenant-authored templates and company names are covered too) takes the default copy
      from 66 segments to 50 across all 45 messages — 24% fewer. Two 145-char notices went
      from 3 segments to 1.
- [x] P1 the unverified-domain retry compared sender STRINGS, so a tenant on nvc360.com with
      EMAIL_FROM also on nvc360.com retried on the same broken domain — a guaranteed second
      failure. pickRetrySender() compares DOMAINS. Verified live: one hop, not two.

- [x] 32 new tests (12 sender/retry, 12 email copy, 8 domain poll, 11 sms encoding), all
      confirmed red first
- [x] 12-mutation sabotage battery, every one caught by a named test, all restored
- [x] LIVE per-tenant send-from test on real Turso + real Resend:
      bmd-materials sent as "BMD Materials <contact@bmdmaterials.com>", reply-to
      contact@bmdmaterials.com, Resend last_event "delivered" to danrosenblat@gmail.com.
      allco-electrical (custom address, NO verified domain) was refused the custom From
      before and after — proven by running the probe with the guard sabotaged, which
      produced "Allco Electrical <careers@allcoelectrical.com>".
- [x] full gate set: 543 tests / tsc 159 / oxlint 0 / vite build ok / crash-sweep ALL CLEAN
      (26) / a11y PASS (26 x 2) / customer-sweep PASS (12 x 2)
- [ ] needs a web Publish from the Runable UI (Dan)
- [ ] DAN'S ACTION: fix the DKIM TXT record for nvc360.com (see the report) — until then the
      NVC360 tenant cannot send email at all.
- [ ] OPEN DECISION for Dan: no client SMS carries "Reply STOP to opt out". Twilio honours
      STOP at the carrier level so opt-out works, but the disclosure is missing.
      NOT live-verified: the SMS normalisation itself (no phone number authorised to text).

## Housekeeping pass (Aug 17, 2026)
Baseline: 264 `error TS` (tsconfig.app.json). TS2769 105, TS2339 58, TS7006 51, TS2353 30.
- HYPOTHESIS REJECTED: Hono chain length / inference blowup. Splitting bookings.ts into 3
  sub-chains changed the count by exactly 0. Reverted.
- REAL ROOT CAUSE (Family A): every sub-router was `new Hono()` with no Variables generic, so
  `c.get("user")` hit the `(key: never)` overload -> 105 bogus TS2769. Fixed by extracting the
  `Variables` type out of api/index.ts into `src/api/env.ts` (+ `AppEnv`) and making all 47
  routers `new Hono<AppEnv>()`. 264 -> 156 errors (all 105 TS2769 gone).
- Remaining: TS2353 30 + TS2339 58 + TS7006 51 = Family B (web call sites, `apiFetch` union).
- CSS backlog item CLOSED as non-issue: 128 kB raw / 19.5 kB gzipped, Tailwind v4 (no content globs).
- Family B fixed too, at the call sites (no `ok()` helper needed in the end).
- Last error (track-public.tsx) fixed by putting `jsonBody` on POST /api/track/:token/messages
  with a permissive `unknown` schema — types the body, leaves readText's wording in charge.
- RESULT: 264 -> 0 errors. `bunx tsc --noEmit -p tsconfig.app.json` is now a real gate.
- Gates at commit 4207c8b: 565 tests pass / 0 fail, oxlint 0, vite build ok,
  crash-sweep.py 50/50 CLEAN (25 admin pages x desktop+mobile).
- crash-sweep.py REBUILT IN-REPO (was in /tmp and got wiped). Uses
  executable_path=/usr/bin/google-chrome, wait_until="load" (networkidle never fires
  on SSE pages), a fresh tab per page (shared tab blamed navigation-aborted requests
  on the next page), and ignores /stream aborts, cartocdn tiles and /api/public/file 404s.
- Pre-existing, not a regression: /admin/catalog 404s one demo catalog image missing
  from local dev storage.
- Mobile layouts DONE. Work orders already had a phone card list (pre-existing); the gap was
  the scheduler CALENDAR: month/week grids were `grid-cols-7` at every width (~44px per day on
  a 390px phone). Now `hidden lg:grid`, with a phone agenda below lg built from the SAME
  calDays range + jobsOn(), so switching widths never changes which jobs you see.
  Out-of-month days in the month agenda are dimmed to match the desktop grid's opacity cue.
- Calendar Work Queue on phones: drag was the only way to schedule and HTML5 drag never fires
  on touch, so the card is now tappable (opens the work order, where the date field works) and
  the grip + "drag a card" hint are lg-only. Page subtitle reworded off "Drag".
- Found + fixed via the new gate: work-orders sort direction toggle was a 32px tap target.
- crash-sweep.py EXTENDED: it now toggles the scheduler into Calendar and cycles
  week/month/day (that whole layout was previously never loaded by the sweep), and asserts no
  interactive element under 40px tall on /admin/scheduler + /admin/work-orders at 390px.
  Both additions sabotage-checked (broke each one, watched the sweep FAIL, restored).
