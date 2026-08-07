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

## Phase 2 — Automation  ✅ DONE (commit b608b2e)
- [x] 2.1 automation engine — services/automation.ts (trigger->rule matching, conditions incl. any-of + minMinutes, {{var}} templating, runsCount), wired into dispatch.fireEvent via EVENT_TO_TRIGGER; time-based triggers (tech_idle, sla_risk) swept every 60s from server.ts
- [x] 2.2 review requests — queued on job completion (per-tenant delay, default 120min), SMS links to the permanent job record; star widget on /t/:token; routing gate: 4-5★ -> tenant Google review URL, <=3★ never routed publicly + private low_rating alert to admins. Settings UI: enable toggle, delay, Google review URL.
- [x] 2.3 maintenance plans — maintenance_plans table, services/maintenance.ts (reminder N days before due, rolls due date forward one interval + re-queues on fire, cancel on deactivate), api/routes/maintenance.ts, admin/maintenance.tsx page + nav item
- [x] migration 0005_lush_lord_hawal.sql applied
- [x] verified live: 26/26 checks passed (conditions, rule run/skip/disabled, counters, notifications, templating, time sweep, 4 routing cases, ask scheduling + dedupe + handler, reminder lifecycle incl. roll-forward and cancel)

## Phase 3 — Documentation  ✅ DONE
- [x] 3.1 before/after tagging — job_photos.phase (before|during|after) + customerVisible; phase picker in mobile capture flow + admin photos panel; grouped display on /t/:token, property hub, admin modal; internal photos never reach customer surfaces
- [x] 3.2 mobile signature — components/signature-pad.tsx (PanResponder, ZERO native deps: strokes POSTed as points, server renders SVG) + POST /api/bookings/:id/signature; bookings.signatureUrl/signatureName/signedAt; signature_captured event; shown on customer record + admin modal. Ships OTA — no new binary needed.
- [x] 3.3 voice notes — lib/voice-note.ts (expo-audio loaded lazily, isVoiceNoteSupported() hides the button on older binaries instead of crashing) + POST /api/bookings/:id/voice-note; best-effort server transcription via AI gateway; transcript appended to driverNotes; INTERNAL-only event. NEEDS A NEW NATIVE BUILD to appear (expo-audio added to package.json + NSMicrophoneUsageDescription in app.json).
- [x] new admin endpoint GET /api/bookings/:id/events (full internal timeline + signature) feeding the FieldRecordPanel in work-order-modal
- [x] migration 0006_salty_terror.sql applied
- [x] verified live: 35/35 checks against the running server (signature persist/validate/SVG render, phase tagging + fallback, internal-photo filtering on /t/, voice note storage + transcript + isolation, admin events auth)

## Phase 4 — Unified inbox ✅ DONE
- [x] `realtime.ts`: MsgKind extended with `"inbox"` (company-keyed `msg:inbox:<companyId>`)
- [x] `GET /api/messages/inbox` — client + tech + broadcast threads, counts, unread-first sort. Read state untouched (poll-safe).
- [x] `GET /api/messages/inbox/stream` — signal-only SSE, 1s tick / 20s ping
- [x] `POST /api/messages/:bookingId/mark-read` — explicit ack, separate from GET
- [x] all three declared ABOVE `/:bookingId` (Hono matches in registration order)
- [x] `publishMsg("inbox", …)` at all 4 send sites + both track.ts sites
- [x] `track.ts` POST /:token/messages now also notifies THIS tenant's admins — homeowner replies from the public page previously surfaced nowhere in admin
- [x] `admin/inbox.tsx` + lazy route + nav item under Operations
- [x] UI bugs found in browser check and fixed: "Invalid Date" in thread pane (raw rows return ISO strings, `Number()` gave NaN — added tolerant `msgTime()`); "Unread" chip counted messages while every other chip counted threads; open thread jumped down the list the instant it was marked read (now pinned while active)
- [x] verified live: 36/36 checks (`packages/web/verify-phase4.ts`) + browser pass on /admin/inbox (filters, open, reply, unread clearing, Open job link)
- NOTE: replying to a real client thread sends a REAL SMS to the customer. Use throwaway bookings with rider_id NULL when testing.

## Phase 5 — AI dispatch

## Notes / decisions
- Turso: db:generate -> commit -> db:migrate. NEVER db:push.
- tsc --noEmit unreliable (Hono chain false positives). Verify by booting tmux `web` on 4200.
- No invoicing. No pricing on customer-facing surfaces.
