# Web/Admin — Next Priorities Punch List

Follow-up to `WEB_ADMIN_UX_AUDIT.md`. Items 1-4 (broken pages, broken avatar, missing 404, stale login
error) are **fixed and verified** — see commit `be61b39`. This is the detailed, actionable breakdown of
everything still open, in the order I'd tackle them.

---

## Group A — Trust & correctness (do these next)

### 5. Dashboard revenue is calculated differently than Reports — and it shows
**Root cause, confirmed in code:**
- Dashboard (`packages/web/src/api/routes/admin.ts:59`) — `revenue = paidInvoices.reduce((s,i) => s + i.total, 0)`.
  Only counts invoices explicitly marked **paid**.
- Reports (`packages/web/src/api/routes/reports.ts:123-126`) — sums booking `total` directly off every
  booking in range, regardless of invoice/payment status.
- Result: Reports correctly showed **$13,611.70** revenue over 90 days in my walkthrough; the Dashboard
  showed **$0.00 "No payments recorded yet"** for the same tenant, same time period. Two genuinely
  different numbers both labeled "Revenue," one page apart.
- This traces back to the known gap in `QUALITY_AUDIT.md`: `STRIPE_WEBHOOK_SECRET` isn't set, so invoices
  likely never flip to "paid" via webhook in this environment — meaning the Dashboard's stat is
  structurally almost-always-zero until that's fixed, independent of whether jobs are actually completed
  and billed.

**Recommended fix (pick one):**
- **(a) Consistency fix (fast, ~1 hr):** change the Dashboard stat to sum booking totals the same way
  Reports does, and relabel Reports' version "Booked value" vs. Dashboard's (if kept invoice-based)
  "Collected revenue" — so they're allowed to differ, but visibly mean different things.
- **(b) Root-cause fix (bigger, ties into existing backlog):** wire `STRIPE_WEBHOOK_SECRET` (already
  flagged in `QUALITY_AUDIT.md` blocker #1) so invoices actually transition to paid, then the two numbers
  converge naturally.
- Recommend (a) now regardless — it's cheap and stops the visible contradiction immediately — and (b) as
  part of whatever payments-hardening work already exists on your roadmap.

### 6. Screen-reader accessible name collision on `activate()` cards
File: `packages/web/src/web/lib/utils.ts:70` (the `activate()` helper) + first confirmed usage
`packages/web/src/web/pages/admin/riders.tsx:~187`.
- **Task:** audit every usage of `activate(...)` across `packages/web/src/web` (`rg "\.\.\.activate\("`) —
  each one needs either (a) an explicit `aria-label` on the outer element, or (b) confirmation its only
  descendant content is plain visible text with no competing `title`/`aria-label` on a nested control.
- Quick win: add `aria-label={`View ${r.name}`}` (or equivalent) to each card/row using `activate()`. Small
  per-instance change, but needs a full sweep, not just the one file I hit.

---

## Group B — Responsiveness (recurring pattern, one real project)
Confirmed clipping at 1024px (a normal 13" laptop width, not an edge case) in:
- `packages/web/src/web/pages/admin/builder.tsx` — 3-column layout, "EST. MINUT..." and pricing inputs
  clip.
- `packages/web/src/web/pages/admin/settings.tsx` — right-hand Calendar Sync column squeezes to ~120px,
  Regenerate button clips.
- `packages/web/src/web/pages/admin/users.tsx` (Directory) — Joined column runs off with unstyled
  overflow scroll.
- `packages/web/src/web/pages/admin/notifications.tsx` — channel-icon matrix's rightmost recipient column
  cut at viewport edge.

**Recommended approach:** don't fix these one-by-one with page-specific hacks — pick one pattern and apply
it everywhere:
1. For tables (Directory, and any other data table): make the table wrapper `overflow-x-auto` with a
   `min-width` on the table itself, so it scrolls horizontally as a deliberate, styled behavior instead of
   silently clipping. The API/MCP JSON block in Settings already does this correctly — copy that pattern.
2. For multi-column form/detail layouts (Builder, Settings): add a responsive breakpoint that stacks
   columns vertically below ~1200px instead of forcing a fixed 3-column grid.
3. Once the pattern is picked, sweep all four files above in one pass rather than four separate fixes —
   should be a half-day to a day total, not four separate efforts.

---

## Group C — Data-loss-risk / silent-failure UX

### 8. Intake form "No recipient" warning has no inline fix
File: `packages/web/src/web/pages/admin/intake-forms.tsx`. Currently shows a red "No recipient" badge with
only a generic "Edit" action. **Fix:** add a quick-set control right on the warning row — a small
recipient-email input + save button inline, or at minimum a button that jumps straight into the edit modal
with the recipient field focused, rather than a generic "Edit" that dumps the user into the full form.
Effort: 1-2 hrs.

### 9. Fleet map has no empty-state messaging
File: `packages/web/src/web/pages/admin/fleet.tsx`. When there are zero active technicians (likely on a
quiet day or new tenant), the map just renders empty dark tiles under the status legend. Borrow the
Scheduler calendar's existing empty-state pattern ("All caught up — every active job is scheduled...") —
add an overlay message like "No technicians active right now" centered on the map when the tech list is
empty. Effort: 30 min.

---

## Group D — Information architecture

### 10. "Customers" nav item vs. "Directory" page title mismatch
File: `packages/web/src/web/pages/admin/users.tsx` (routed as `/admin/clients`, nav label "Customers" in
`shell.tsx`). The page actually lists customers + technicians + dispatchers + super admins together under
the title "Directory."
- **Cheap fix (30 min):** rename the nav label from "Customers" to "Directory" or "People" to match what's
  actually there.
- **Better fix (~1 day):** split into an actual customer list (what the nav item promises) and keep a
  separate "Directory"/team-roster view for internal accounts — cleaner mental model, more work.
- Recommend the cheap fix now, revisit the split if this becomes a recurring point of confusion in usage.

---

## Group E — Polish (batch these together, low individual cost)

- **Text truncation with no title/tooltip**, several places: catalog item names
  (`packages/web/src/web/pages/admin/catalog.tsx`), integration names
  (`packages/web/src/web/pages/admin/integrations.tsx`). Add `title={fullName}` on the truncated element —
  a five-minute fix per file once you're in there.
- **Icon-only controls without a visible label** — the biggest concentration is the Notifications channel
  matrix (`notifications.tsx`), which is also the source of 9 of the current 20 lint errors
  (`jsx-a11y/control-has-associated-label`). Add a one-line legend above the matrix ("📧 Email · 💬 SMS ·
  🔔 Push") and `aria-label` on each icon button. Fixes the lint errors and the UX question at once.
  Effort: 1-2 hrs.
- **Superadmin-gated pages** (`companies.tsx` when viewed as a non-superadmin) show bare unstyled
  "Superadmin access only." text. Wrap it in the same restricted-state card style used elsewhere (or just
  redirect to `/admin` instead of rendering an access-denied page at all). Effort: 30 min.
- **`autoFocus` used in 3 places** (lint-flagged, `jsx-a11y/no-autofocus`) — review each; usually fine for
  a search box or modal's first field, but worth a deliberate look. Effort: 30 min to review all three.

---

## Suggested sequencing

| Order | Group | Why |
|---|---|---|
| 1 | A (items 5-6) | Trust (dashboard number) + a real accessibility bug — both small, both matter daily |
| 2 | E (a11y sub-items only) | Fixes lint errors + UX in one pass, small effort |
| 3 | B (responsiveness) | Bigger but a single well-scoped project across 4 files |
| 4 | C (8-9) | Lower risk but real — silent lead loss (8) and a confusing empty map (9) |
| 5 | D (10) | Cheap rename now; defer the bigger split unless it becomes a recurring complaint |
| 6 | E (remaining polish) | Batch whenever convenient, no urgency |

Let me know which group to start on and I'll go.
