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

## Item 1 — public intake form audit (in progress, Aug 13 late)
Live: /f/default/request-service?k=nvcpub_3767…f1e6 renders clean at 1024 + 390
(/tmp/intake/01-1024.png, 02-390.png). Layout is NOT the problem.
Suspected findings (verify with tests before fixing):
- A. out-of-zone submit returns 422 but the customer `user` row + membership are
     created BEFORE the zone check → junk client records + orphan photo upload
- B. `email` is never format-validated; it lands in `user.email` and in the
     recipient email's `Reply-To`
- C. photo > 15 MB is silently dropped (no else branch) — customer thinks it sent
- D. client-side: `?k=` missing only errors after filling+submitting; no
     `aria-busy`; server errors render at the bottom with no scroll/focus move
Never curl the real /submit — it calls fireEvent() (real SMS/email). Verify in the
in-memory harness (see intake-form-service-zone.test.ts).
