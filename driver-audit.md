# Driver app audit — Aug 2026 (dispatcher / client / driver)

Scope: `packages/mobile` (driver app) + the server paths the driver drives
(`tracking.ts` ping/geofence, `booking-status.ts`, `bookings.ts` status route),
because a driver-app bug shows up on the dispatcher board and the customer's
tracking link, not just on the phone.

## Findings

### P0-1 Geofence radius: four sources of truth, three different numbers
- `schema.ts` `geofenceRadiusM` default **150**
- `tracking.ts` fallback when a company has no settings row: **20**
- admin Settings UI default shown/coerced to: **20**
- driver app copy: "Auto-arrives when you're within **150m**"
Effect: on a company with no settings row auto-arrive needs the driver inside
20 m of the geocoded pin — it effectively never fires on commercial sites —
while the app promises 150 m. Drivers stop trusting auto check-in.
Fix: one shared `DEFAULT_GEOFENCE_RADIUS_M` + NaN-safe resolver; UI copy shows
the company's real radius and live distance.

### P0-2 Manual "I've Arrived" gets its clock paused ~8s later
`applyBookingStatus("arrived")` sets `insideGeofence = true` even when the
driver tapped Arrived manually from outside the radius. The next ping sees
`!inside && insideGeofence` → `pauseClock`. Driver sees "Clock paused — you've
stepped away" while standing on site. On-site minutes feed tech pay.
Fix: `insideGeofence` means "GPS has seen you inside", set only on the
geofence path (`opts.byGeofence`).

### P0-3 `resumeClock` early-return leaves `insideGeofence` stale
`if (b.clockState === "running") return` — so re-entering the site after a
manual arrival never flips `insideGeofence` to true, and exit detection stays
dead for the rest of the job: the clock keeps running after the tech drives
away. Over-reported on-site time.
Fix: reconcile the flag even when the clock is already running.

### P0-4 `POST /:id/status` accepts any transition
No validation: enroute → completed (skips arrival, no transit time, customer
never gets the "arrived" notification), completed → enroute (re-opens a billed
job, re-fires SMS). This is the class of bug behind the "it skipped arrival"
report.
Fix: transition graph in `shared/job-status.ts`, 409 on invalid, office (admin)
can still force a correction.

### P1-5 The most important button in the app fails silently
`setStatus` has no `onError`. Offline is handled (mutation pauses, hint shown),
but a *rejected* call — 403, 409, expired session — shows nothing at all. The
driver taps "Complete Job", nothing happens, and they tap again.
Fix: surface the server's message, plus error haptic.

### P1-6 Same silent failure on messages and checklist
`sendMsg`, `sendDispatch`, `toggleChecklist` have no `onError`. Checklist also
only updates *after* the server replies, so on slow signal a tapped box looks
dead.
Fix: `onError` alerts; checklist optimistic with rollback.

### P1-7 GPS ping loop can leak a second timer
`startPings()` is async (awaits permission) and the effect cleanup returns
immediately. Change status fast and the old async continuation overwrites
`pingTimer.current` after cleanup ran → an orphan 8-second interval for the
rest of the shift: double GPS writes, double battery.
Fix: cancellation flag.

### P1-8 Ping failures are invisible to everyone
`catch {}` in the ping loop. If pings fail, the dispatcher's map and the
customer's tracking link freeze on a stale dot and nobody is told.
Fix: count consecutive failures, warn the driver on screen after 3.

### P2-9 `companySettings` read from the DB on every ping
Every active driver, every 8 s. Cache per tenant with a short TTL.

## Status
- [x] P0-1 shared radius + live distance
- [x] P0-2 byGeofence
- [x] P0-3 resumeClock reconcile
- [x] P0-4 transition graph
- [x] P1-5 setStatus onError
- [x] P1-6 messages/checklist onError + optimistic
- [x] P1-7 ping timer cancellation
- [x] P1-8 ping failure surfacing
- [x] P2-9 settings cache

## Verified
- `packages/web/src/shared/__tests__/status-transitions.test.ts` — 15 unit tests
  (red first: NEXT_STATUSES did not exist).
- `packages/web/src/api/routes/__tests__/status-flow-and-clock.test.ts` — 12
  route/service tests against in-memory libsql.
- `driver-flow-verify.py` — 34 assertions over HTTP against the real server on
  4200 and the real Turso DB, probe rows deleted and the deletion verified.
- Sabotage-checked all three P0 server fixes: reverting each one fails its own
  named tests (2, 1 and 3 respectively) and restoring returns to green.
- Gates: 625 web tests / mobile typecheck 0 / tsc app 0 / oxlint 0 / vite build
  ok / crash-sweep 50/50.

## For Dan
- The `default` company has `geofence_radius_m = 20` saved in the database —
  that is a real saved value from the old settings screen (which suggested 20),
  not a fallback, so auto check-in on that company needs a driver within 20 m of
  the pin. Left untouched rather than changing live data. Recommend 100-150 m in
  Admin > Settings.
