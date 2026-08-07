# Web platform fixes 1–3 (from web-platform-review.md, 6.4/10)

## Fix 1 — silent mutation failures (3.0 → target 8+)
- [x] `src/web/lib/api-error.ts` — `ApiError` class + `errorMessage()` + `messageFromBody()`
- [x] `src/web/lib/api.ts` — `apiFetch` throws on non-2xx, wired into `hc({ fetch })`
- [x] `src/web/components/toast.tsx` — toast system, errors sticky, de-dupe by key, `aria-live`
- [x] `src/web/lib/query-client.ts` — ONE shared client + `MutationCache.onError` (wires all 131
      unhandled mutations at once) + `QueryCache.onError` (only when no data) + 401 → sign-in
- [x] `src/web/components/provider.tsx` — uses shared client + ToastProvider
- [x] `src/web/main.tsx` — removed the duplicate nested QueryClient
- [x] verify: `bun verify-fix1.ts` → ALL PASS 19/19 (non-2xx rejects with ApiError+status, 2xx
      unchanged, all errorMessage mappings, envelope parsing). Browser E2E: patched fetch → 400 on
      `/api/catalog` PATCH (a route NOT touched by fix 3) → sticky toast "Base price can't be
      negative", aria-live=polite, modal stayed open. Screenshot `/tmp/toast-error.png` reviewed.

### Key safety check done
All graceful-degradation call sites (`fleet.tsx:71` empty fallback, `integrations.tsx:47`
"coming soon", `intake-forms.tsx:319`, `integrations.tsx:207`) use **raw fetch**, NOT the typed
client — unaffected by the throwing wrapper. `notifications.tsx:831` reads `.ok` off the JSON
*body* on a 200, not the HTTP status — also unaffected.
Mutations set `retry: 0` — retrying a write could double-send an SMS / double-fire dispatch.

## Fix 2 — GET /api/bookings N+1 + no pagination (4.0)
- [x] batch `enrich()` with `inArray` (services, riders, users, customers) — `enrichMany()`,
      4 queries total regardless of row count, per-batch try/catch fallback
- [x] add pagination to `GET /` — deliberately OPT-IN via `?page`/`?pageSize`; 10 consumers
      (admin dashboard, scheduler, rider earnings, mobile) aggregate over the whole set, so
      defaulting to page 1 would silently corrupt revenue/count totals. Unpaginated reads
      hard-capped at `MAX_LIST = 2000` with a `truncated` flag.
- [x] keep response shape backward-compatible — `{ bookings: [...] }` preserved,
      `total`/`page`/`pageSize`/`pages`/`truncated` added additively
- [x] verify: `bun verify-fix2.ts` → ALL PASS 15/15. Flat scaling measured: 37 rows 547 ms /
      87 KB, 87 rows 550 ms / 176 KB, 162 rows 555 ms / 308 KB — 1.02x time for 4.4x data.
      Old per-row model projected ~9.5 s for 162 rows; actual 0.56 s. (~270 ms of that is fixed
      session/auth overhead: `/api/health` 66 ms, single-query `/api/services` 270 ms.)
      Fixtures cleaned up, count back to baseline 12.
- Pattern copied: `src/api/routes/job-search.ts` `enrichRows()`

## Fix 3 — validation (3.5)
- [x] shared helper `src/api/lib/validate.ts` — `ValidationError`, `parseBody()`, `validate()`,
      primitives `money()`, `durationMins`, `shortText()`, `longText()`, `percent()`.
      Unknown keys are **stripped, not rejected** (existing clients send extra keys) — which also
      closes the mass-assignment surface. 400s reuse the existing envelope
      `{ error: { code, message }, fields, message }` (bare `message` kept for older clients).
- [x] zod on `services.ts` POST/PATCH + explicit allow-listed PATCH writes + DELETE 404s
- [x] `zones.ts` unchecked destructure → PUT/DELETE unknown id now 404 (was 500 / silent success)
- [x] verify: `bun verify-fix3.ts` → ALL PASS 35/35. The original review probe
      (`name:""`, `basePrice:-99999`, `durationMins:-5`, 50k-char description) now returns
      **400 with a field map** — it was 201 Created. All money/duration edge cases rejected
      (negative, NaN, Infinity, string, absurd, zero/fractional duration, whitespace name).
      Valid input still 201 with exact values; price 0 allowed; injected `id`/`companyId`/`rating`
      ignored; malformed JSON → 400 not 500. Fixtures cleaned up.
- [ ] remaining ~91 raw `c.req.json()` call sites across the other 42 route files (not done)

## Repo gotchas
- `tsc --noEmit` unreliable here (project refs + pre-existing Hono overload false positives)
- server serves `packages/web/dist` → must `bunx vite build` for frontend changes
- NEVER `db:push` (Turso batch bug)
- `fireEvent()` on a seeded booking sends a REAL SMS — use throwaway bookings, `rider_id NULL`
- web: tmux `web` on :4200
