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
