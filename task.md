# Task — admin UI polish pass (Linear/Stripe level)

Order agreed with Dan: **6 (web admin polish) → mobile polish → 1 (intake form review) → 2 (score booking flow) → 4 (small-phone card layouts)**
Weight polish toward the **operations modules** (work orders, scheduler, fleet, inbox) — that's where Dan spends his time.

## Baselines (do not regress)
- `bunx tsc --noEmit -p tsconfig.app.json` from packages/web → non-TS2769 errors == **159**
- `bun test src` (NO root .env sourced) → **323 pass / 0 fail**
- `bunx oxlint packages/web packages/mobile --deny-warnings --no-error-on-unmatched-pattern` from repo root → 0
- Build with `bunx vite build` (never `bun run build` — tsc step fails on pre-existing errors)
- `python3 a11y-gate.py` from packages/web → PASS 24 pages × 2 widths
- mobile: `bunx tsc --noEmit` filtered to `^(app|lib|components)/` → 0 ; `npx expo export --platform ios`

## The 5 agreed changes
1. [x] Thin branded scrollbars + `scrollbar-gutter: stable` (styles.css)
2. [x] Radius scale collapsed 5 values → 2 + pills, via token mapping (styles.css)
3. [x] Global branded `:focus-visible` ring; filled ring variant for inputs (styles.css)
4. [x] Sidebar nav bottom fade mask (`.nvc-fade-b`, shell.tsx, desktop + drawer)
5. [~] Ops tables + empty states
   - [x] new shared `components/empty-state.tsx`
   - [x] bookings: sticky thead, merged sort control, skeleton loading, split
         "no matches" vs "nothing yet" empty states, `hasAnyFilter`
   - [ ] scheduler empty states
   - [ ] inbox empty state
   - [ ] fleet empty state
- also: folded `text-[9px]` (16 uses) → `text-[10px]`; 9px was unshippably small

## Verify
- Live Chrome at 1024 + 390 via `mb`, screenshots in /tmp/polish
- Chrome debug: tmux `chrome`, port 9222. Login via `mb js` (React-controlled
  inputs ignore `mb fill`: set value with the native setter + dispatch `input`,
  then `form.requestSubmit()`). admin@nvc360.app / admin123
- Web server: tmux `web` port 4200, log /tmp/web4200.log

## Done earlier this session
- Deleted all leftover `ZZ …` probe rows from real Turso (14 bookings + 222 child
  rows + 1 orphan service), verified 0 remaining
- TestFlight build 14 (v1.0.1) built + submitted; Dan confirmed it opens clean
- Dan confirmed web Publish now succeeds (AWS SDK cut fixed the builder OOM)
