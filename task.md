# NVC360 Research-Gap Roadmap — progress

Plan: /home/user/plan.md (approved)

## Phase 0 — Foundations
- [ ] 0.1 job_events table + emit from dispatch.fireEvent + backfill script
- [ ] 0.2 scheduled_tasks table + services/scheduler.ts + tick in server.ts
- [ ] 0.3 properties table + bookings.propertyId + services/properties.ts + backfill
- [ ] migrate (db:generate -> commit -> db:migrate), boot, verify, commit

## Phase 1 — Customer experience
- [ ] 1.1 timeline endpoint + track-public UI + SSE
- [ ] 1.2 permanent job record
- [ ] 1.3 property hub /p/:token

## Phase 2 — Automation
- [ ] 2.1 automation engine
- [ ] 2.2 review requests + Google routing
- [ ] 2.3 maintenance plans

## Phase 3 — Documentation
- [ ] before/after tagging, mobile signature, voice notes

## Phase 4 — Unified inbox
## Phase 5 — AI dispatch

## Notes / decisions
- Turso: db:generate -> commit -> db:migrate. NEVER db:push.
- tsc --noEmit unreliable (Hono chain false positives). Verify by booting tmux `web` on 4200.
- No invoicing. No pricing on customer-facing surfaces.
