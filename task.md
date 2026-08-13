# Small-screen (≤390px) pass — admin

Gate baselines: `bun test src` (no .env) ≥352/0 · oxlint 0 · tsc non-TS2769 = 159 ·
`bunx vite build` (NEVER `bun run build`) · crash-sweep ALL CLEAN · a11y-gate PASS.
Dev server serves prebuilt dist → re-run `bunx vite build` after every web source change.

## Done
- work-orders (bookings.tsx): stacked card list below lg; table only ≥lg.
  Job cell max-w so truncate works; Assign/Edit labels moved to 2xl; customer
  column moved lg→xl; pill row + search stack until lg. No overflow at 390/768/1024/1280.
- scheduler.tsx: "drag here" copy → "tap Assign" below lg; grab handle hidden below lg.
- dead `n-2` class (never defined in any CSS) → `line-clamp-2` in notifications.tsx, services.tsx.
- FOUND: both gates listed phantom routes (/admin/bookings, /admin/team, /admin/users,
  /admin/customers) that render AdminNotFound → they were auditing a 404 and passing.
  Fixed both PAGES lists to the 25 real routes + added a hard phantom-route guard.
- a11y-gate: new `hscroll` check (inner overflow-x-auto scrollers at 390px) — the
  document-level check could never see the work-orders table.

## Fixed after the gate correction (all 16 findings it surfaced)
- work-orders sort-direction button 28x28 -> 32x32.
- builder: 5 icon-only delete buttons got aria-label + title (page had never been audited).
- clients/Directory: dropped the 720px table floor below lg (the columns already
  hide there), named the delete button, role pill no longer wraps inside itself.
- reports detail table: px-2/text-xs at phone width — dynamic report columns
  cannot be carded, so they had to cost less padding.
- notifications matrix, techs tab strip, fleet overlay: deliberate scrollers,
  allowlisted in a11y-gate ALLOWED with reasons.
- Sabotage-checked: phantom path -> exit 2; reverting the work-orders cards ->
  hscroll finding; restoring -> clean.
- Gates green: 352/0 · oxlint 0 · tsc 159 · vite build · crash-sweep ALL CLEAN ·
  a11y PASS 25 pages x 2 widths.

## Batched for the next EAS build (not yet built)
- cross-company Earnings screen (commit 774a0f1)
