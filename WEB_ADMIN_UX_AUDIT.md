# NVC360 Web / Admin Platform — Expert UI/UX & Feature Audit

**Reviewer lens:** 20-year UI/UX product designer, daily-usability focus.
**Date:** July 30, 2026. **Method:** logged into the live dev build (tmux `web`, port 4200) as company
admin (`admin@nvc360.app`), walked every one of the 26 admin routes plus the marketing/customer surface,
screenshotted each at ~1024px, cross-checked suspicious findings against source. Re-ran lint for a real,
current accessibility number. This audit is scoped to **UI/UX and feature-set** — not backend/scale, which
`QUALITY_AUDIT.md` and `AUDIT_CTO_2026-06.md` already cover.

---

## ✅ P0 items 1–4 — FIXED and verified live (commit `be61b39`)
All four below were fixed and re-tested against the running vite dev server (port 5173) after the fix —
not just read, actually clicked through. See `NEXT_PRIORITIES.md` for what's left.

## 🔴 P0 — Found broken right now (fix before anything else)

### 1. Three admin pages are fully crashed: Payouts, Reports, Tags & Fields
All three call `useJobNoun()` without importing it — a `ReferenceError` that trips the error boundary and
shows a generic "Something went wrong" screen instead of the page. Confirmed live (screenshot) and by
static grep across every admin page:
```
packages/web/src/web/pages/admin/payouts.tsx:17   const { nounPlural: jobPlural } = useJobNoun();
packages/web/src/web/pages/admin/reports.tsx:359  const { nounPlural: jobNounPlural } = useJobNoun();
packages/web/src/web/pages/admin/tags.tsx         (same pattern)
```
None of these files import `useJobNoun` from `../../lib/use-brand` (only `useWorkerNoun`/`useCustomerNoun`
are imported). Left over from the customerNoun/jobNoun terminology-wiring commit — never caught because
`tsc` isn't a reliable gate in this repo and nobody opened these three pages in a browser afterward.
**Fix is one line each**: add `useJobNoun` to the existing `use-brand` import. Trivial, but three core
ops pages (money in/out, reporting, tagging) are unusable until it's done.

### 2. Broken technician profile photo renders the browser's broken-image icon + overlapping alt text
On **Technicians & Managers → Field Staff**, Dan Rosenblat's card shows a mangled broken-image glyph with
ghost text ("Dan Roser...") bleeding through behind it (see crop). `photoUrl` points at a URL that 404s;
`TechAvatar` (`components/tech-avatar.tsx`) has no `onError` fallback to the color-initials avatar it
already supports for riders with no photo at all — it only checks "does `photoUrl` exist," not "did it
actually load." **Fix:** add an `onError` handler on the `<img>` that clears `photoUrl` state so it falls
back to the initials avatar, same pattern used when there's no photo.

### 3. Stale/unmatched routes render a completely blank page — no 404, no redirect
Tried `/auth` (wrong guess for sign-in) and `/admin/map` (wrong guess for the fleet map) — both rendered
a totally blank page, no header, no message, sidebar gone or present depending on nesting level. `wouter`'s
`<Switch>` in both `app.tsx` (top-level) and `admin/index.tsx` (nested) has no catch-all route. Any
mistyped URL, old bookmark, or stale link after a route gets renamed (like `/auth` → `/sign-in` clearly
was) drops the user on a dead blank screen with zero way to recover except editing the URL bar.
**Fix:** add a `<Route>` fallback (no `path` prop, or `path="*"` depending on wouter version) rendering a
simple "page not found, here's a link home" component in both switches.

### 4. Login error banner is stale — doesn't clear as the user corrects their input
Submit sign-in with a bad value → "Invalid email" banner appears. Fix the field to a valid email and
retype the password → the banner is still sitting there reading "Invalid email" even though the field now
holds a clearly valid address, right up until the next submit. A first-time user would reasonably think
the form is still rejecting their (now-correct) input. **Fix:** clear the error state `onChange`, not only
on submit.

---

## 🟠 P1 — Real, verified UX gaps

### 5. Dashboard shows an internally-inconsistent headline number
`/admin` dashboard shows **Revenue: $0.00 "No payments recorded yet"** directly above/near **Recent Work
Orders** listing multiple completed jobs with real dollar amounts ($156.80, $4,781.60...). A dispatcher's
first reaction to their own command center would be "why does it say zero when I can see money right
there?" Whatever the underlying cause (payments not linked to demo bookings, `payment_ledger` genuinely
empty since Stripe webhook secret isn't set per `QUALITY_AUDIT.md`), the dashboard should never present a
headline metric that visibly contradicts the list directly below it — at minimum, label it "Collected
revenue" vs. "Booked value" so the two numbers aren't implied to be the same thing.

### 6. Screen-reader accessible name on technician/job cards is actively misleading
`activate()` (`lib/utils.ts`) turns a `<div>` into `role="button"` with **no explicit `aria-label`**, so
the accessible name is computed from all descendant text — including the nested delete button's
`title="Remove technician"`, which sits earlier in the DOM than the visible name. A screen reader
announces the *entire* technician card as **"Remove technician, Dan Rosenblat, 5.0, 0 jobs..."** A
non-sighted user has every reason to believe clicking the card deletes the technician, when it actually
opens their detail view. Confirmed in `riders.tsx` (~line 187) and this `activate()` pattern is reused
elsewhere — worth auditing every other card/row that uses it. **Fix:** give the outer clickable an explicit
`aria-label` (e.g. `View ${r.name}`) so it doesn't inherit the delete button's title text.

### 7. Three-pane / wide layouts break at a completely normal laptop width (1024px)
At 1024px (not an edge case — a real 13" laptop resolution):
- **Form Builder Templates**: the middle "Template Name / Category / Est. minutes" column and the pricing
  panel below it clip mid-word ("EST. MINUT...", "INCL. MIN", pricing inputs pushed off-frame).
- **Settings → Company**: the right-hand "Calendar Sync" column squeezes body copy into ~120px, and the
  "Regenerate" button is clipped at the edge.
- **Directory (Customers)**: the table's rightmost columns (Joined date) run off-screen with a scrollbar,
  no sticky/priority columns.
- **Notifications → Notification Rules**: the channel-icon matrix's rightmost recipient column is cut at
  the viewport edge.
This is a repeated pattern, not a one-off: several pages assume a wider-than-1024px canvas. **Fix:**
either make these layouts responsive (stack columns below a breakpoint) or set a documented minimum
supported width and add horizontal scroll containers consistently (some pages, like the API/MCP JSON
block, already do this correctly — reuse that pattern instead of clipping).

### 8. "No recipient" warning has no inline fix
Intake Forms → "Request Service" shows a red **"No recipient"** badge (a lead form nobody receives), which
is good — the system knows something's wrong. But the only available action is the generic "Edit" button;
there's no one-click "Set recipient" affordance right on the warning itself. A real submission could
silently go nowhere until an admin happens to notice this badge.

### 9. Fleet map has no empty-state messaging
`/admin/fleet` with zero active technicians (a very likely state for a new or quiet-day tenant) just shows
an empty dark map tile with a 0/0/0/0/0/3-offline legend at top — no "no technicians active right now" copy
on the map itself. Contrast with the Scheduler's calendar view, which handles the same "nothing here"
situation well ("All caught up — every active job is scheduled and assigned"). The map should borrow that
pattern.

### 10. Directory / Customers naming mismatch
Sidebar nav says **"Customers"**; the page itself is titled **"Directory"** and lists every account type
(customers, technicians, dispatchers, super admins) mixed together. Either rename the nav item to
"Directory" or "People," or split it — right now a dispatcher clicking "Customers" expecting a customer
list gets a mixed roster instead, with no on-page explanation of why.

---

## 🟡 P2 — Polish items worth a pass

- **Text truncation with no title/tooltip**: catalog item names ("Flooring Installed (p...", "Preventive
  Mainte..."), integration names ("Quick...", "Google ...") truncate mid-word with no hover-title, so the
  full name isn't recoverable without opening the item.
- **Icon-only controls without visible labels**: this is the concrete source of most of the current 20 lint
  errors (see below) — notably the Notifications channel-toggle matrix (9 `control-has-associated-label`
  hits) is icon-only with no text label per control; a legend at the top of the matrix would fix both the
  lint errors and the "what does this icon mean" question for a first-time admin.
  Rule of thumb going forward: any icon-only interactive control needs a real `aria-label`.
- **Superadmin-gated pages show a bare, unstyled "Superadmin access only."** text with no card, icon, or
  way back — inconsistent with how every other empty/restricted state in the app is styled.
- **`autoFocus` used in 3 places** (lint-flagged) — usually fine, but worth a deliberate look since it's a
  known usability trap for screen-reader/keyboard users landing somewhere unexpected.

---

## ✅ What's genuinely strong (would hold up well in a product review)

- **Scheduler**: drag-and-drop kanban + calendar with skill-based filtering, a real "AI suggest best match"
  promise in the subtitle, and the best empty-state message in the whole app.
- **Catalog**: clean card grid with cost/margin shown inline, category tabs, search — exactly what a
  dispatcher pricing a job needs at a glance.
- **Jobs (bookings) table**: search, status filters, sort, export, and a clear status pipeline — this is a
  well-built, dense data table.
- **Automation & AI**: clear on/off toggles per rule with trigger→action chips, easy to scan.
- **Settings → API & MCP**: genuinely modern differentiator (Claude Code / MCP client config with
  copy-paste snippets) most competitors in this space don't have.
- **Audit Log**: filterable by entity type, readable human-language entries ("Dan Super Admin created tag
  'Friends&Family'").
- **Marketing/landing page** (`/`): polished, on-brand, good use of live-dispatch social proof.

---

## Accessibility — real, current number (re-run this session)

`bunx oxlint packages/web` (root, matching the project's own `lint` script scope): **0 warnings, 20
errors, 203 files.** This is a big improvement over the stale "313 warnings" figure in `QUALITY_AUDIT.md`
— that backlog was already burned down in an earlier session and the old doc was never updated. Current
breakdown:

| Rule | Count |
|---|---|
| `jsx-a11y/control-has-associated-label` | 9 |
| `jsx-a11y/no-autofocus` | 3 |
| `jsx-a11y/label-has-associated-control` | 2 |
| `no-unused-vars` | 4 |
| `no-unused-expressions` | 1 |
| misc | 1 |

14 of the 20 are real a11y issues (icon-only controls / unlabeled form fields), concentrated in a handful
of dense matrix/form UIs (Notifications being the biggest contributor). Small, fixable backlog — nowhere
near the scale the old audit implied.

---

## Scope note

This pass covered all 26 admin routes plus the public marketing page. Customer-facing (`/app/*`) and
rider-web (`/rider/*`) surfaces were reachability-checked only (both correctly gate by role — logging in as
admin redirects away from `/rider`) since testing them properly needs dedicated customer/rider test
accounts; flagging as a good follow-up if you want the same treatment there.

---

## Prioritized punch-list

| # | Item | Effort | Why now |
|---|---|---|---|
| 1 | Fix `useJobNoun` import in payouts.tsx, reports.tsx, tags.tsx | 15 min | 3 core pages are fully broken |
| 2 | `onError` fallback on `TechAvatar` for broken photo URLs | 15 min | Visibly broken UI on a people-facing page |
| 3 | Catch-all/404 route in both `app.tsx` and `admin/index.tsx` switches | 30 min | Any stale link = blank dead page |
| 4 | Clear sign-in error banner on input change | 15 min | Confusing first-run experience |
| 5 | Fix `activate()` cards' accessible name (add explicit `aria-label`) | 1-2 hrs (audit all usages) | Actively misleading for screen-reader users |
| 6 | Reconcile Dashboard revenue vs. recent work order amounts (label or wire correctly) | varies | Trust/data-integrity signal on the most-viewed page |
| 7 | Responsive fixes for Builder / Settings / Directory / Notifications at ≤1024px | 1-2 days | Recurring pattern across 4+ pages |
| 8 | Inline "Set recipient" action on the intake-form warning badge | 1-2 hrs | Silent lead-loss risk |
| 9 | Empty-state copy on Fleet map | 30 min | Matches existing good pattern elsewhere |
| 10 | Rename "Customers" nav item or split Directory by role | 30 min-1 day depending on approach | IA clarity |

Items 1-4 are all small, low-risk, and fix things that are actively broken right now — recommend doing
those regardless of what else gets scheduled. Let me know which of the rest you want tackled first.
