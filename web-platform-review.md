# NVC360 Web / Admin Platform — Expert Review

**Reviewer stance:** 15 years shipping production SaaS admin platforms. Graded the way I'd grade a product about to be sold to paying field-service companies, not the way I'd grade a prototype.

**Scope:** `packages/web` — 53,342 lines, 44 API route files, 29 admin pages, 34 services.
**Method:** static analysis of the whole codebase plus live probes against the running server on :4200. Every defect below was **reproduced**, not inferred.

**Overall: 6.4 / 10**

Strong architecture with a genuinely impressive multi-tenancy and permissions layer, undermined by a systemic client-side error-handling flaw and a data-layer pattern that will not survive real customer volume.

---

## Scores

| # | Criterion | Score | One-line verdict |
|---|---|---|---|
| 1 | Security & access control | **8.5** | Best part of the codebase. Fail-closed tenancy, real permission catalog. |
| 2 | Error handling & user feedback | **3.0** | ~130 of 161 mutations can fail silently and look successful. Critical. |
| 3 | Data layer & scalability | **4.0** | Textbook N+1 on the busiest endpoint, zero pagination. |
| 4 | Input validation | **3.5** | No schema validation anywhere. I created a service with a negative price. |
| 5 | Observability | **5.5** | Excellent backend logging with PII scrubbing. Frontend is completely blind. |
| 6 | Accessibility | **5.0** | Good icon labelling, but no dialog semantics and no focus management. |
| 7 | UI/UX polish | **7.5** | Genuinely good. Consistent, dark, dense, well-considered empty states. |
| 8 | Test coverage | **4.5** | 14 test files for 53k lines, all backend. Right things tested, far too few. |
| 9 | Code quality & consistency | **7.0** | Readable, well-commented, honest about its own tradeoffs. Some giant files. |
| 10 | Performance (frontend) | **7.0** | Sensible code splitting and lazy routes. Payloads are the problem, not JS. |

---

## Critical findings

### 1. A rejected save is indistinguishable from a successful one — 3.0/10

This is the finding that matters most, and it is systemic rather than a one-off bug.

The admin pages call the API like this, 79 times:

```ts
mutationFn: async (id) => (await api.services[":id"].$delete({ param: { id } })).json()
```

The Hono client does **not** throw on a non-2xx response. So a 400/403/500 resolves normally, React Query treats it as a success, `onSuccess` fires, `invalidateQueries` runs and the modal closes. The user believes their change saved.

**Reproduced live:**

```
server said: 400 Bad Request
did .json() throw?            false
payload handed to react-query: {"message":"name required"}
=> mutationFn resolved normally, so react-query fires onSuccess
```

Counts: **161 `useMutation` calls, 30 `onError` handlers.** Roughly 130 mutations have no failure path at all. Of the ones that do surface something, the mechanism is `alert()` — there is no toast system in the app (12 native `confirm()`/`alert()` call sites, zero toast infrastructure).

Why this is severity-one for this product: dispatchers work fast under pressure. A silently dropped work-order edit or a silently failed technician assignment doesn't look like a bug — it looks like the platform lost data. It will be reported as "NVC360 randomly forgets things", which is the hardest class of complaint to debug and the fastest way to lose a tenant.

### 2. N+1 queries against a remote database, with no pagination — 4.0/10

`GET /api/bookings` (the endpoint behind Work Orders, Scheduler and the dashboard) does this:

```ts
rows = await t.select(schema.bookings, isNull(schema.bookings.deletedAt));  // ALL rows, no limit
const enriched = await Promise.all(rows.map(enrich));
```

And `enrich()` issues **up to 4 sequential queries per booking** — service, rider, rider's user, customer.

**Measured live: 822 ms and 44 KB for 14 bookings.** That's ~50 round trips to a *remote* Turso instance for a near-empty database.

The scaling maths is unforgiving: a tenant with 2,000 work orders means ~8,000 remote round trips and a multi-megabyte JSON payload on a single page load. It will time out well before that.

Notably, `job-search.ts` **already solves this correctly** — batched `inArray` lookups, real pagination, `count(*)` for totals. The good pattern exists in the codebase; the busiest endpoint just doesn't use it.

### 3. No input validation anywhere on the API — 3.5/10

**0 uses of `zValidator`. 93 raw `await c.req.json()` calls.** Bodies are read and written straight to the database.

**Reproduced live** — `POST /api/services`:

```
sent:    { name: "", category: "", basePrice: -99999, durationMins: -5, description: 50,000 chars }
result:  201 Created
stored:  name="" basePrice=-99999 durationMins=-5 descLen=50000
```

A service with no name, a negative price and a negative duration is now in the catalog. Negative prices flow into `lineItemsPrice`/`subtotal`/`total` and into technician pay calculations. There is careful pricing logic in `shared/pricing.ts` with real unit tests, and it is being fed unvalidated garbage.

Related, same root cause: `PUT /api/zones/:id` with an id that doesn't exist returns **500, not 404** — confirmed live. It destructures `const [zone] = await tx(c).update(...)` and then reads `zone.polygon` without a null check. (Credit where due: the error envelope is clean — `{"error":{"code":"internal"},"requestId":"..."}` with no stack trace or SQL leaked.)

---

## Notable findings

### 4. The frontend is invisible in production — 5.5/10

The backend logging is genuinely good: structured JSON lines, request-id correlation, a regex-based PII/secret scrubber that masks emails and strips tokens, and a single `captureException` choke point ready for a `SENTRY_DSN`.

The frontend has **none of it**. No Sentry, no `window.onerror`, no `unhandledrejection` handler. There is exactly one root-level `ErrorBoundary` in `app.tsx`, which means any render crash white-screens the *entire admin platform* rather than one panel — and you will never find out it happened. The driver app already got Sentry during its review; the web app was left behind.

### 5. Accessibility: labelled but not navigable — 5.0/10

Better than expected in one dimension: 398 `aria-label` attributes against 395 buttons, so icon-only controls are mostly labelled. The `Modal` component locks body scroll, handles Escape, and even gives the backdrop `aria-label="Close dialog"`.

But app-wide: **0 `role="dialog"`, 0 `aria-modal`, no focus trap, no focus restore on close.** A screen reader announces a modal as an unlabelled div; a keyboard user tabs straight through it into the page behind. Also only 52 `<label>` elements for 293 `<input>` elements — most fields rely on placeholder text, which disappears on focus and isn't read as a name.

### 6. Test coverage is thin, but aimed well — 4.5/10

14 test files for 53k lines. What's covered is exactly what I'd pick first — tenant isolation, API-key isolation, permissions, pricing, tax, money rounding, the geofenced clock. That's good instinct.

What's missing: **every one of the 29 admin pages, and 43 of 44 route files.** There is no test that would have caught the silent-mutation-failure bug, because there are no frontend tests at all.

### 7. Some files are too big to reason about — 7.0/10

`work-order-modal.tsx` is 1,667 lines. `notifications.tsx` 1,372. `bookings.tsx` 1,112. `scheduler.tsx` 1,067. These are the files that get edited most often and they're the hardest to edit safely.

The code itself reads well — the comments are unusually honest (the `z-[1050]` comment in `modal.tsx` explains *why* the stacking order is what it is, the `MAX_SERVICE_RADIUS_KM` comment explains a real trust boundary). That quality of commenting is rare and worth preserving.

---

## What's genuinely strong

**Security and multi-tenancy (8.5)** — I tried to break this and couldn't.

- `tenantId()` **throws** if a tenant-scoped handler is reached without a company — fail closed, not fail open.
- Superadmin cross-tenant switching via `X-Company-Id` validates against a cached allow-list from the `companies` registry, so probing arbitrary values falls back to the user's home company.
- `requirePermission()` resolves per-person overrides on top of role defaults against a real permission catalog — not a boolean `isAdmin` flag.
- Writes explicitly `delete set.companyId` so a payload can't move a record between tenants. My mass-assignment probe (`id`, `createdAt`, `rating` injection) was **rejected**.
- Redis-backed rate limiting with a separate stricter limiter on auth.
- Dedicated isolation tests exist and pass.

For a multi-tenant SaaS this is the layer that has to be right, and it is.

**UI/UX (7.5)** — 74 loader/skeleton usages and 102 distinct empty-state strings means someone actually thought about the in-between states, which is the thing most teams skip. Copy like "All caught up — every active job is scheduled and assigned" is the right register. The `useWorkerNoun()`/`useCustomerNoun()` hooks mean tenants who call them "drivers" or "crews" see their own vocabulary throughout.

**Frontend performance (7.0)** — Lazy-loaded admin routes, heavy libraries isolated into their own chunks (`leaflet` → `vendor-maps`, `recharts`/`d3` → `vendor-charts`, `pdf-lib` → `vendor-pdf`), and — correctly — React deliberately *not* hand-split, with a comment explaining the production TDZ crash that taught that lesson. Largest chunk is 657 KB raw / 208 KB gzipped, which is fine.

---

## Recommended fix order

Ranked by damage-prevented per hour of work.

| # | Fix | Impact | Effort |
|---|---|---|---|
| 1 | Throw on non-2xx in one shared API wrapper + add a toast system; wire every mutation's failure path | Eliminates the silent-data-loss class outright | ~1 day |
| 2 | Paginate `GET /api/bookings` and batch `enrich()` with `inArray` (copy the `job-search.ts` pattern) | Turns a future outage into a non-event | ~0.5 day |
| 3 | Add zod validation to write endpoints, starting with money/duration fields; fix the unchecked destructures that 500 | Stops bad data at the door | ~1 day |
| 4 | Sentry on the web app + `unhandledrejection`; add per-route error boundaries so one panel crashing doesn't white-screen the platform | You find out about bugs before Dan's customers call him | ~0.5 day |
| 5 | Replace the 12 `confirm()`/`alert()` sites with the real dialog/toast components | Removes the last "unfinished" tell in the UI | ~0.5 day |
| 6 | Modal a11y: `role="dialog"`, `aria-modal`, focus trap + restore; associate labels with inputs | Keyboard and screen-reader usability | ~0.5 day |
| 7 | Frontend tests for the flows that touch money and dispatch; split the four 1,000+ line files | Makes the next change safe | ~2 days |

**Fixes 1–3 are the ones that change the product's risk profile.** They're about 2.5 days and would move the overall score to roughly **8.0**.

---

## Honest caveats

- I could not complete a fresh mobile-viewport browser pass — the headless browser tooling wedged partway through the audit. Earlier in this session I did successfully render `/admin/scheduler` and the assign modal, both of which looked correct, so the desktop UI assessment is grounded in real screenshots. The responsive/mobile assessment is **not** verified and is excluded from the UI/UX score rather than guessed at.
- The 3.0 on error handling is a judgement about a *pattern*, evidenced by the 161-vs-30 count and one reproduced case. I did not click through all 161 mutations individually.
- Scores are calibrated against commercial SaaS admin platforms, not against typical internal tools. Against the latter this codebase grades noticeably higher.
