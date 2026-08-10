# NVC360 web/admin platform fixes (from the 6.4/10 expert review)

## Fix 1 — silent mutation failures  ✅ DONE, committed `e06c5cd`
`bun verify-fix1.ts` → 19/19 PASS. Throwing `apiFetch` + `ApiError` + toast system +
single shared QueryClient with a global `MutationCache.onError`.

## Fix 2 — N+1 + pagination on GET /api/bookings  ✅ DONE, committed `e542c72`
`bun verify-fix2.ts` → 15/15 PASS. 4 queries total regardless of row count.
37→547ms, 87→550ms, 162→555ms (1.02x growth for 4.4x data; old model projected ~9.5s).
Pagination opt-in via `?page`/`?pageSize`; unpaginated capped at MAX_LIST=2000 + `truncated`.

## Fix 3 — zod validation on write endpoints  ✅ DONE, committed `8b39e94`
`bun verify-fix3.ts` → 35/35 PASS. Original probe (empty name, -99999 price, -5 mins,
50k description) now 400 with a field map (was 201). `PUT /api/zones/<unknown>` now 404 (was 500).

---

## Fix 4 — crash reporting + error boundaries  ✅ IMPLEMENTED
- `src/web/lib/sentry.ts` — env-gated on `VITE_SENTRY_DSN`, disabled in dev, no PII,
  no Session Replay, `beforeSend` drops expected <500 ApiErrors.
- `src/web/lib/global-errors.ts` — `unhandledrejection` + `window.error` net,
  stale-chunk-after-deploy detection, de-duped toast.
- `src/web/components/error-boundary.tsx` — `RootErrorBoundary` (full screen) +
  `RouteErrorBoundary` (per role area; auto-resets on navigation, keeps shell alive).
- `provider.tsx` attaches user id + role to reports.
- query-client reports 5xx/unexpected only.
- VERIFIED: with no DSN, Sentry is fully tree-shaken (0 bytes in dist). With a DSN in
  the root `.env`, the DSN + SDK land in the bundle. **DSN is build-time, not runtime.**

## Fix 6 — modal accessibility  ✅ IMPLEMENTED
- `src/web/hooks/use-dialog.ts` — role/aria-modal/labelling, focus in + restore,
  Tab trap, topmost-only Escape, scroll lock. onClose held in a ref so an inline
  arrow at the call site can't re-run the effect and steal focus mid-typing.
- `components/modal.tsx` rebuilt on the hook; backdrop is a div, not a button.
- `components/dialog-panel.tsx` — `<DialogPanel>` drop-in for the 12 hand-rolled
  overlays: services, catalog, stripe-pay, bookings (assign), rider/active (decline),
  automation, maintenance, email-editor (x2), users drawer, riders drawer,
  notifications (drawer + edit-message).

## Fix 5 — replace 12 native confirm()/alert()  ⬜ IN PROGRESS
job-report.tsx:46 · scheduler.tsx:124 · options-catalog.tsx:90,106,232 ·
settings.tsx:54 · services.tsx:79 · bookings.tsx:446,795 · catalog.tsx:205 ·
intake-forms.tsx:320

## Fix 8 — extend validate.ts to remaining raw c.req.json() sites  🟡 IN PROGRESS
Done so far:
- money/scheduling/public routes (commit 2759dcd, verify-fix8.ts 53/53)
- identity routes: team, riders, invites, api-keys (commit f6ae037,
  verify-fix9.ts 80/80)
- notif-config (12 bodies) + email designer/channels/webhooks/domains
  (verify-fix10.ts 106/106)
New shared primitives in validate.ts: hhmm(), hexColor(), bool(),
outboundUrl() — outboundUrl blocks non-http schemes (stored XSS) and
loopback/link-local/RFC1918 hosts (SSRF via the webhook test-ping).
Still raw: option-catalog(4), messages(4), admin(4), tags/superadmin/
integrations/custom-fields(3 each), track/templates/shifts/notifications/
maintenance/forms/fleet/automation(2 each), plus ~12 files with 1.

### Gotcha learned here
The Channels tab PATCHes the WHOLE settings row on save, so any min-length
rule on a field that is legitimately blank in live data (smsFromNumber,
smsSenderId, emailFromName) would 400 the entire Save button. Those are
length-capped only. Always replay the real frontend payload, not just probes.

## Frontend crash sweep  ✅ NEW (packages/web/crash-sweep.py)
Found: the Channels tab of /admin/notifications was completely dead for every
admin — useIndustryNotificationGuidance() was called AFTER the loading
early-return, so React threw "Rendered more hooks than during the previous
render" and the tab rendered the error boundary. tsc, the build and the API
tests could not see it; only rendering the page could. Hook moved above the
return. crash-sweep.py now walks 16 admin pages + every in-page tab in real
Chrome and fails on any error boundary or uncaught page error: ALL CLEAN.

## Known data issue (not code)
The stored email header logo (notification_channels.emailLogoUrl ->
/api/public/file/email-logos/...png) 404s — the object predates S3 and was
lost with the ephemeral local disk. Dan needs to re-upload it in
Notifications -> Channels, otherwise notification emails render a broken
image.

## Mobile / responsive viewport pass  ✅ DONE (commit 8b840a5)
Audited with `packages/web/audit-responsive.py` (Playwright, real 390px + 768px
viewports over 8 admin pages). 134 issues -> 0. Fixed:
- sr-only escape in bookings.tsx / users.tsx action <th> caused whole-page
  horizontal scroll (doc scrollWidth 524 vs 390 viewport)
- dashboard revenue KPI clipped ("$15,04"): missing min-w-0 on grid items
- catalog / options-catalog / services / inbox had ZERO page padding
- tap targets: scheduler card actions were 16px tall; pills 20-28px; icon
  buttons 36px; leaflet zoom 30x30. Now 44px min below lg (styles.css block)
- /admin/reports raw-export rows overflowed at 768px
Score for the responsive criterion: 7.5/10 (was unscored). Layout and touch
targets are now correct; still no dedicated mobile navigation pattern for the
data tables, which fall back to horizontal scroll.

## Fix 5 note
`bunx tsc --noEmit -p tsconfig.app.json` baseline is 247 errors (all known
false positives). Build with `bunx vite build`, never `bun run build`.


## Fix 8 progress — session of Aug 7 2026 (later)

Committed this session:
- `4dbd126` option-catalog.ts + option-selections.ts + messages.ts validated.
  Headline finds: `priceDelta: "1,200"` published an upgrade tier as FREE
  (Number()||0); POST /api/messages/direct 500'd on EVERY call from a
  `co` ReferenceError thrown AFTER the write, so app retries duplicated
  the message + notification; POST /:bookingId inserted before resolving
  the booking (orphans). verify-fix11.ts 108/108.
- `9bc40bb` admin/fleet.tsx `jobNoun` ReferenceError — whole Fleet page
  (map + dispatch) hit the error boundary for any mapped work order with
  a blank title AND an unresolvable service name. Reproduced in Chrome by
  intercepting /api/jobs/search and blanking those two fields.
- `1f30ebe` admin.ts (4 raw bodies). Headline finds: PATCH could set a
  user's email to garbage (that's their login) or to another user's
  address (bare 500, now 409); `name: 123` stored as "123.0"; 500k notes
  and 5,000 addresses accepted; reset-password ran the hasher over a
  100k string and 500'd on a numeric password. role/companyId confirmed
  already unreachable. verify-fix12.ts 71/71.
- Also de-flaked verify-fix9.ts (presence.ts legitimately downgrades a
  heartbeat-less tech to "offline", so asserting "available" raced).

Type-error baseline now **245** (was 247). No TS2304/TS18048 anywhere.
crash-sweep.py ALL CLEAN. Verifier suite all green.

### OPEN — found live, not yet fixed
- **PATCH /api/bookings/:id with a serviceId that doesn't exist -> bare
  500** (FK constraint on bookings.service_id). idField accepts any
  string, so nothing checks the row exists. Same class likely applies to
  riderId / customerId / templateId / propertyId on both create and
  patch, and it doubles as a cross-tenant FK check. Reproduced with
  `{"serviceId":"zz-deleted-service"}`.

### Remaining fix-8 tail
tags.ts / superadmin.ts / integrations.ts / custom-fields.ts (3 each),
track.ts / templates.ts / shifts.ts / notifications.ts / maintenance.ts /
forms.ts / fleet.ts / automation.ts (2 each), ~12 files with 1.

## Fix 8 progress log (continued)

Done and committed:
- f6ae037 identity routes (team/riders/invites/api-keys) — verify-fix9, 80/80
- 1071aa3 notif-config + dead Channels tab — verify-fix10, 106/106
- 4dbd126 option-catalog / option-selections / messages
- 9bc40bb fleet.tsx jobNoun crash
- 1f30ebe admin.ts user-management bodies
- 1349011 work-order foreign keys
- a056641 tags.ts + custom-fields.ts — verify-fix12, 45/45
  * Headline: options:"a,b,c" stored a JSON string; renderer's .map() threw and
    put the WHOLE technician drawer behind the error boundary for every admin.
    Fixed at the API and hardened in web/components/custom-fields.tsx.
  * tags entity-link route used to delete existing links BEFORE validating the
    payload — silent data loss on a malformed body.
- 8971175 integrations.ts + superadmin.ts — verify-fix13, 44/44
  * Headline: brand-scout was a live SSRF (fetched 127.0.0.1 / 169.254.169.254
    and echoed parsed content back). Now behind outboundUrl().
  * Brand patch stored javascript: logos, junk hex colours, invalid contact
    emails and a 20k jobNoun.

Remaining c.req.json() sites (raw bodies), in risk order:
  track.ts, templates.ts, shifts.ts, notifications.ts, maintenance.ts, forms.ts,
  fleet.ts, automation.ts  (2 each)
  tracking.ts, skills.ts, settings.ts, reviews.ts, public-forms.ts, mcp.ts,
  bookings.ts  (1 each; messages.ts / notif-config.ts / admin.ts counts are the
  doc comments only)

Probe hygiene learned this pass:
- superadmin has NO delete-company route, so never let a probe create a tenant;
  only exercise rejection paths that fail before the insert.
- For routes that write tenant settings, snapshot the row through drizzle
  (not the API) and restore it at the end — verify-fix13 does this for acme-hvac.
- Do NOT put min(1) on a field the real UI submits blank (folderName,
  smsFromNumber, smsSenderId, emailFromName). Always replay the actual payload.
- Baseline tsc error count is now 245 (bunx tsc --noEmit -p tsconfig.app.json).

Verifier suite (all green as of 8971175):
  set -a && source ../../.env && set +a && bun verify-fix1.ts && bun verify-fix2.ts \
    && bun verify-fix3.ts && bun verify-fix8.ts && bun verify-fix9.ts \
    && bun verify-fix10.ts && bun verify-fix12.ts && bun verify-fix13.ts
