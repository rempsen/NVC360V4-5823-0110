# NVC360 dispatcher / admin platform — expert audit

Reviewed 2026-08-18 against the eight areas you picked: fleet & live map, work order
creation and pricing, scheduler & calendar, dispatch board, inbox & messaging,
reports & dashboard, customers/team/permissions, and invoices/payouts/tech pay.

This pass looked at **functional correctness** — money, races, and who can see what.
The user-experience side (accessibility, empty states, performance, mobile widths,
Sentry) was already reviewed and fixed in `admin-review.report/content.md`, so it is
not repeated here.

Everything below was reproduced before it was fixed, and every fix is covered by a
test that was confirmed to fail first, then sabotage-checked (break the fix → the
named test fails → restore → green).

---

## Score

| # | Criterion | Before | After |
|---|-----------|--------|-------|
| 1 | Dispatch correctness under concurrency | 5.5 | 8.5 |
| 2 | Money integrity (pricing, tax, tech pay) | 4.5 | 8.5 |
| 3 | Access control on financial data | 6.0 | 9.0 |
| 4 | Appointment / schedule integrity | 5.5 | 8.5 |
| 5 | Failure feedback to the dispatcher | 8.5 | 8.5 |
| 6 | Reporting arithmetic | 8.0 | 8.0 |
| 7 | Fleet & live map reliability | 8.0 | 8.0 |
| 8 | One number per fact (data-model coherence) | 5.5 | 7.5 |
| 9 | Auditability of office actions | 7.0 | 8.0 |
| 10 | Multi-tenant isolation | 9.0 | 9.0 |

**Overall: 6.7 → 8.4 / 10.**

Two criteria scored well and needed no work, which is worth saying plainly:

- **Failure feedback (8.5).** `MutationCache.onError` in `web/lib/query-client.ts`
  already toasts every rejected write app-wide, and `apiFetch` throws on every
  non-2xx. I checked the four dispatch pages that have mutations with no local
  `onError` (bookings, scheduler, fleet, payouts — 16 mutations between them) and
  confirmed a 403/409/expired session is surfaced by the global handler. That is a
  real strength; most products in this category fail silently here.
- **Multi-tenant isolation (9.0).** `tdb` fails closed on an empty company id and
  the isolation tests cover invoices, messages and API keys. Nothing to add.

---

## Findings

### P0-1 — Any job on the board could be re-dispatched, including live and finished ones ✅ fixed

`POST /bookings/:id/assign` had **no guard of any kind**. `/accept`, `/decline` and
`/release` all compare-and-set; `/assign` unconditionally wrote
`status="assigned"`, `assignStatus="offered"`, `acceptedAt=null` on whatever id it
was given.

What that cost in practice:

- Assigning a job a tech was **driving to or standing on site at** took it off his
  phone mid-visit and reset the offer, while his drive time and running on-site
  clock stayed attached to the record.
- One mis-click on a **completed** job put it back on the board as an un-accepted
  offer and re-sent the dispatch notification on billed work.
- Two dispatchers acting at once (or an assign racing a tech's Accept) silently
  clobbered whichever change landed second.
- A stale booking id reached `enrich(undefined)` — a bare 500.
- The route was `requireAuth`, not admin, so a **technician could dispatch work to
  himself**.

Now: office-only; 404 on an unknown work order; 409 on completed or cancelled; 409
on a job someone is actively working — flagged `forceable` so the dispatch UI
offers a **"Reassign"** confirmation instead of an unexplained failure; 409 on
re-offering a job to the tech who already accepted it; and a compare-and-set on the
status that was checked, so a job that moves underneath the click is refused rather
than overwritten. A confirmed reassignment clears the previous visit's drive time,
arrival and clock so the new tech starts clean, and frees the old tech's "busy"
status.

### P0-2 — Technicians were paid a percentage of the sales tax ✅ fixed

Payout gross summed `booking.price`. `billing.ts` sets `price = total = subtotal +
tax`. So the payout was taken on the tax-inclusive invoice.

On a $1,000 Ontario job at 13% HST, gross came out as $1,130 and the tech's 80% as
**$904 instead of $800** — $104 of collected HST, money owed to the government,
went out as pay on every $1,000 invoiced.

Now: gross is the pre-tax value of the work (`subtotal`, falling back to
`price - taxAmount` for old rows written before the tax columns existed).

### P0-3 — The same jobs could be paid out twice ✅ fixed

`POST /payouts/generate` selected completed+paid jobs by date window and nothing
recorded that a job had already been paid. Re-running a period — or running two
overlapping periods, which is the normal thing to do after a late invoice lands —
produced a **second payout for the same work**.

Now: `bookings.payout_id` links a job to the payout that covered it (migration
`0012_fast_gargoyle.sql`, applied to the live database). Generation skips any job
that already has one, so a second run creates nothing; a job completed late and
never paid out is still picked up; and deleting a *pending* payout releases its jobs
back to the next run.

### P0-4 — Any technician could read the company's books ✅ fixed

`GET /reports/:report` and `GET /payouts` were behind plain `requireAuth`. Verified
live with a real technician's bearer token: it returned company revenue, tax
collected, gross margin and COGS, receivables and aging, client revenue, and the
**payroll report showing every tech's pay**.

Now both are `requireAdmin`, confirmed live: the technician's token gets 403 on all
six of those endpoints and the office's token still gets 200.

### P1-5 — Moving an appointment told nobody ✅ fixed

A `rescheduled` notification exists and ships enabled by default — client email,
tech SMS, office in-app — but **only the customer-initiated change-request flow
ever fired it**. When a dispatcher dragged a job on the calendar or changed the date
in the work-order modal, the tech's phone kept showing the old time and the customer
was never told. That is a missed appointment and a truck roll.

Now both office reschedule paths fire it, and only when the time actually changed
(saving the modal without touching the date does not spam anyone).

### P1-6 — A finished job could be dragged into another reporting period ✅ fixed

`POST /:id/schedule` accepted any booking. Revenue reports and payout periods are
selected by `scheduled_at`, so rescheduling a completed job moved money between
periods — after the payouts for those periods had already been generated.

Now: 409 on completed or cancelled, with a message that explains why.

### P1-7 — "Mark paid" had no guard ✅ fixed

No compare-and-set on status and no existence check. A double-click (or two people
in the payouts screen at once) re-stamped `paid_at` on a payout that had already
gone out and wrote a second "paid" line into the audit log; a stale id logged
`Marked payout paid ($undefined)` and answered **200**, so the office believed a
tech had been paid.

Now: 404 on an unknown payout, 409 on one that is already paid, and a paid payout
can no longer be deleted at all — that row is the only record that the tech was
paid.

### P1-8 — The driver's Earnings screen showed the customer's tax-inclusive total ✅ fixed (server side)

`GET /me/earnings` summed `booking.price` as the tech's "gross". On that same $1,000
Ontario job the tech saw **$1,130**. Now it reports the pre-tax value of the work,
which is also the figure payouts are computed on, so the two finally reconcile.

---

### P0-9 — Payouts paid a cut of the invoice instead of what the tech earned ✅ fixed

Two pay models disagreed: `accrueTechPay()` stored real pay per job (hourly rate ×
on-site minutes + per-unit line pay), while the payouts screen paid *gross minus a
platform fee %*. Real pay is now the only model, in one place:
`packages/web/src/shared/tech-pay.ts` (`computeTechPay()`), used by both
`services/billing.ts` and `api/routes/payouts.ts`.

- Platform fee % is gone from the payout run and from the UI.
- Completed jobs are included whether or not the customer has paid yet.
- A job with no hourly rate and no per-unit lines pays `$0` and is flagged
  ("no pay rate set") instead of quietly paying a percentage.
- Payouts now store the breakdown: `hourly_pay`, `unit_pay`, `on_site_minutes`,
  `unrated_jobs`, `breakdown` (migration `0013_cooing_spacker_dave.sql`, applied to
  live Turso and columns confirmed present).
- Admin payouts screen shows hourly / per-unit / total per tech with expandable
  per-job detail.

### P0-10 — Driver and web "Earnings" showed job value, not the tech's pay ✅ fixed

`/api/me/earnings`, the web rider Earnings and Jobs pages, and the driver app's
Earnings screen all show real pay now, with the hourly + per-unit split. Rider job
cards show "Pay on completion" before the job is finished. Shipped to TestFlight as
build 17 (1.0.1).

Fixed in commit `0e1e30e`. Verified live with `tech-pay-verify.py` —
**ALL CLEAN, 36 assertions** against the running server on 4200 and the real Turso
database; probe booking/payout rows deleted and deletion verified, tech hourly rate
restored. Sabotage-checked (payout `net` temporarily set back to a % of total → named
payout tests failed; restored → green). Gates: `bun test src` **661 pass / 0 fail** ·
CI-shape **590 pass** · `tsc --noEmit` **0** · `oxlint` **0 / 355 files** ·
`vite build` ok · `crash-sweep.py` **50/50** · mobile `typecheck` **0** · GitHub CI
run `32148176120` **success**.

---


### P1-11 — The dispatcher could send one tech to two jobs at the same time ✅ fixed

Assign, create, edit, and drag-to-reschedule now check the assigned technician's
other non-terminal, non-archived jobs using the service duration (fallback: one
hour). A clash returns a forceable 409 with a plain-English message (for example,
"Dan Rosenblat is already booked at 2:00 PM — Availability probe"), and the web UI
asks the dispatcher before continuing. Back-to-back jobs are allowed; completed,
cancelled, archived, unassigned, and other-tech jobs do not count as clashes.

### P1-12 — Time off existed, but dispatch ignored it ✅ fixed

`tech_shifts` time-off rows are now enforced when the office assigns, creates,
edits, or reschedules work. This is also forceable — the company can still override
it intentionally — but not silently. Regular shift rows are not treated as hard
availability; many tenants do not fill shift calendars consistently.

### P1-13 — Shift/time-off rows could store broken dates and impossible times ✅ fixed

`/api/shifts` now validates input instead of raw `c.req.json()`: bad dates are 400,
stale/cross-tenant rider ids are 404, start/end minutes must be real minutes within
the day, end must be after start, `kind` must be `shift` or `timeoff`, and PUT/DELETE
unknown ids return 404. Date-picker values like `2026-09-15` are stored as the start
of that day in the company's own timezone, not UTC midnight (which showed/enforced
the previous day for North American tenants).

New proof:
- Pure tests: `src/shared/__tests__/availability.test.ts` — overlap, back-to-back,
  default duration, time-off day matching, and dispatcher messages.
- Route tests: `dispatch-and-payouts.test.ts` now covers availability across assign,
  schedule, create and patch; `shifts.test.ts` covers validation and tenant checks.
- Sabotage check: temporarily disabled the assign availability block; the named
  double-booking + time-off tests failed, restored green.
- Live verifier: `availability-verify.py` → **ALL CLEAN, 20 assertions** against the
  running server on 4200 and the real Turso database. It only exercised refusals, so
  no assigned/rescheduled notifications were sent. Probe booking/shift rows were
  deleted and deletion verified.

---
## Open — your decisions, not code

1. **Assign and reschedule aren't in the audit log.** Payouts, deletes and edits are.
   Given that a reassignment now moves clock state around, I'd log both — say the
   word.
2. **Twilio is still authenticating with the account SID and auth token** rather than
   an API key (`TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` are not in the
   environment). Pre-existing, works fine, weaker than it should be.

---

## Verified

- New tests: `src/api/routes/__tests__/dispatch-and-payouts.test.ts` — 23 tests,
  confirmed failing first (20 red), now green.
- Sabotage-checked, one fix at a time: reverting the tax fix → 2 named tests fail;
  removing the payout dedupe → 4 fail; removing the assign guard → 3 fail; removing
  the reschedule notification → 1 fails; putting reports back on `requireAuth` → 2
  fail. Each restored to 23/23.
- `dispatch-money-verify.py` → **ALL CLEAN, 26 assertions** against the running
  server on 4200 and the real Turso database, using a real technician token and a
  real office session. It deliberately tests only the refusals, all of which happen
  before any notification is sent, so it messaged nobody. Probe rows were deleted and
  the deletion verified.
- Gates: `bun test src` **648 pass / 0 fail** · CI-shape run **577 pass** ·
  `tsc --noEmit` **0 errors** · `oxlint` **0 warnings / 0 errors, 353 files** ·
  `vite build` ok · `crash-sweep.py` **50/50 clean** · mobile `typecheck` **0**.
- Migration `0012_fast_gargoyle.sql` applied to the live Turso database and the new
  column confirmed present.

**To ship the web changes: publish from the Runable UI.** No mobile build is needed —
the driver-app fix here was server-side.
