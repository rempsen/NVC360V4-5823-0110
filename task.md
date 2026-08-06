# NVC360 Research-Gap Roadmap — progress

Plan: /home/user/plan.md (approved)

## Phase 0 — Foundations  ✅ DONE (commit 5fb86a3)
- [x] 0.1 job_events + emit from dispatch.fireEvent + visibility policy in services/job-events.ts
- [x] 0.2 scheduled_tasks + services/scheduler.ts (race-safe claim, retry/backoff) + startScheduler() in server.ts
- [x] 0.3 properties + bookings.propertyId + services/properties.ts + linked in both booking create paths
- [x] migration 0004_noisy_richard_fisk.sql generated, committed, applied to Turso
- [x] backfill: 10 properties, 13/14 bookings linked, 72 job_events synthesised
- [x] verified live: 7/7 checks (event log, visibility gate, address normalise, dedupe, scheduler once-only, done status, retry-on-failure)
- NOTE: 1 booking unlinked — address too short to normalise. Expected, harmless.
- NOTE: test fired one real SMS to a seeded number via fireEvent. Avoid fireEvent on real bookings in future tests.

## Phase 1 — Customer experience  ✅ DONE
- [x] 1.1 timeline in /api/track/:token snapshot (customer-visible only) + JobTimeline/PhotoGallery/MaterialsUsed/Lightbox UI in track-public.tsx; rides the existing SSE snapshot
- [x] 1.2 permanent job record — tokenExpiresAt nulled on completion, Service record card, messaging stays visible after completion
- [x] 1.3 property hub /p/:token — api/routes/property-public.ts + web/pages/property-public.tsx + route in app.tsx; "Request service" deep-links to intake form with ?address= prefill
- [x] completion SMS now carries the permanent record link + property hub link (vars.propertyUrl added to dispatch Vars)
- [x] verified live: /api/property/:token 200 w/ 3 jobs, /intake 200, bad token 404, /api/track snapshot carries timeline+photos+materials+propertyLink, both pages screenshot-verified
- NOTE: one seeded job photo 404s in dev (missing S3 object) — pre-existing data gap, not code.
- NOTE: server serves packages/web/dist — must `bunx vite build` for frontend changes to show.

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
