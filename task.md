# Admin audit — round 3 (scheduler / availability)

## Done
- admin-audit.md updated: P0-9 (real tech pay) + P0-10 (earnings screens) documented as fixed in 0e1e30e; stale "Open" items 1&2 removed.

## Findings this round
- P1-11: Nothing stops the office from sending one tech to two jobs at the same time.
  `POST /bookings/:id/assign`, `POST /bookings` (create with riderId) and
  `POST /bookings/:id/schedule` never look at the tech's other jobs.
- P1-12: `tech_shifts` (shifts + time-off) is written by the UI and read by nothing.
  `rg techShifts` → only shifts.ts. A tech marked off can be dispatched silently.
- P1-13: `shifts.ts` has no validation at all: raw `c.req.json()`, `new Date(b.date)`
  can be Invalid Date, startMin/endMin unchecked (end < start, negatives, strings),
  riderId not checked against the tenant (FK 500), PUT/DELETE return 200 for
  unknown ids.

## Plan
1. New pure module `src/shared/availability.ts` — overlap + time-off math. Unit tests.
2. Wire into assign: 409 `forceable: true` with a plain-English message. Client
   `web/lib/assign-job.ts` must show the server message, not the reassign wording.
3. Harden shifts.ts (zod, rider tenant check, end > start, 404s).
4. Tests first (red), implement, sabotage-check, live-verify on 4200 + real Turso
   with probe rows + cleanup.
5. Gates: bun test src · tsc app · oxlint · vite build · crash-sweep · mobile typecheck
   · CI-shape run. Commit, push, poll CI.
