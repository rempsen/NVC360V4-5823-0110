# Driver release (cancel) a job they accepted

Policy (Dan, confirmed):
- Release => job returns to dispatch queue UNASSIGNED (status confirmed, riderId null). Customer status unchanged/not told.
- Reason REQUIRED from fixed list + optional note.
- Allowed stages: assigned/accepted, enroute, arrived/onsite, in_progress/paused. NOT offered (that's Decline), not completed/cancelled.
- Notify: office in-app + push + email. Customer: nothing.

## Plan
- [ ] dispatch.ts: NvcEvent "released", EVENT_META, defaultMessage, seed rule (office inApp+email), timeline actor/detail
- [ ] job-events.ts: kind "released", visible:false
- [ ] bookings.ts: POST /:id/release (ownership: assigned rider or admin; CAS update; reconcileRiderStatus; fireEvent before nulling rider)
- [ ] bookings.ts: fix /:id/cancel authz (admin OR owning customer; currently requireAuth only)
- [ ] backfill notification_rules 'released' row for existing companies (raw SQL, Turso)
- [ ] mobile job/[id].tsx: "Can't do this job" + reason modal
- [ ] tests: release-job.test.ts (+ cancel authz), sabotage check
- [ ] gates: oxlint 0, tsc non-TS2769 = 160, bun test src 197+ pass (no root .env), vite build, a11y, crash-sweep
- [ ] live proof on :4200
- [ ] delete probe user cancelprobe1@probe.test (a3iLOW7piadlyrN3A5TaAlT5hPUGaDop)

## Status: DONE — commit 8ea0ed2, pushed
Gates: oxlint 0 · tsc non-TS2769 160 · bun test src 210/0 · vite build ok · crash-sweep clean · a11y PASS
Backfilled notification_rules 'released' (office, in_app+email) for all 5 companies in Turso.
Probes deleted + verified (relprobe-0001, cancelprobe-booking-0001, cancelprobe1@probe.test).
Open: browser walkthrough of the WEB tech portal release sheet blocked — /rider/* is role-gated and
demotech@nvc360.app / tech1234 returns 401. Needs a working tech login (ask Dan before resetting).
Leftover foreign probe rows NOT deleted (not mine): bookings titled "ZZ FK Probe" x2,
"ZZ Assign Probe v2", plus several "ZZ Fix8 FK ok" cancelled rows.

## Next in queue
1. track-public.tsx review (1008 lines, unauthenticated, highest customer volume)
2. book.tsx nextSlots() timezone only (slots stay 9/11/13/15/17, must mean tenant-local)
3. intake-form.tsx, then customer/home|bookings|track|profile; score booking flow into admin-review.report
4. Backlog: small-phone layouts for work-orders/scheduler; customer email/SMS copy review; alert when
   rate limiter fails open on Redis outage
