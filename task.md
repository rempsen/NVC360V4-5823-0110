# Open-items audit — Jul 3, 2026

Publish confirmed working (login TDZ crash fixed 0da76e9, cross-tenant messaging
leak fixed e399a54). Went through every task-*.md/*.md tracker file + spot-checked
code for each claimed-done item. Status below.

## Confirmed DONE, verified again just now
- tsc clean, 98/98 backend tests pass.
- Geofence auto-arrive/pause/resume: code correct (tracking.ts ping handler +
  booking-status.ts pauseClock/resumeClock), radii set per-tenant in DB
  (default 20m, others 50-150m). Mobile FLOW/ACTIVE_PING logic matches (Start
  Driving -> enroute; auto-arrives via GPS ping; Complete Job manual only).
- Driver on/off-duty toggle (profile.tsx): logic reads right (onShift = status
  !== "offline", busy states keep toggle ON). No bug found live in code.
- Per-tenant "send-from" email: fully built — tenant_email_domains table,
  self-serve submit/verify UI, dispatch.ts only honors a custom From address
  once its domain is Resend-VERIFIED (else safely falls back). Code complete.
- Tracking link (/t/:token): route + token resolution all correct; the one
  link user flagged (a88aea389c0d) points to a real, existing, non-expired
  completed booking — loads fine now. If it showed "wrong location" it was
  likely a stale/expired token from an old test, not a routing bug.
- Stripe webhook: code already fails closed in prod (rejects unsigned events
  with 400) — this part of blocker #2 is DONE in code.

## Real open items (need action, not just code)
1. **STRIPE_WEBHOOK_SECRET is not set** in .env. Code is ready; needs a
   webhook endpoint created in the Stripe dashboard (pointing at
   https://uberize.ai/api/payments/webhook) and the signing secret pasted in.
   I can't create this myself — needs you or me with dashboard access.
2. **SENTRY_DSN unset** — no error aggregation in prod yet. Optional; needs a
   Sentry project + DSN.
3. **Migrations not baselined** — schema changes still go out via raw SQL /
   db:push instead of a committed drizzle migration history. Pure tech debt,
   no user-facing impact; can do without new secrets.
4. **Multi-tenancy**: 5 foundation tables fully enforced (bookings, invoices,
   riders, messages, payment_ledger) + tdb() helper now covers many more
   (confirmed via tenant.test.ts - invoices/messages/api_keys/company_settings
   all isolated). Remaining ungoverned tables are lower-risk single-tenant-safe
   items. Not urgent unless onboarding more paying tenants soon.

## Next
Picking off #3 (migration baseline) now since it needs no external input.
Will flag #1/#2 to user for the missing secrets/dashboard step.
