# Multi-company people (shared technicians / customers / admins)

## Goal
One person (one email, one password) can belong to MANY companies, holding a
different role, permissions, manager and staff type at each.

## Core design decision
`user.email` stays **globally unique**. That is not a limitation — it is what
makes "one login, switch companies" work. The thing that becomes multi-valued is
not the identity, it is the **membership**.

    user (identity: name, email, password, phone)
      └── memberships (one row per company)
            companyId, role, permissions, staffType, managerId, status

`user.companyId` is kept as the person's DEFAULT/home company (what they land on
at login) so nothing that reads it breaks.

## Why role resolution is the crux
55 call sites read `user.role`. Rewriting them all would be a huge blast radius.
Instead `authMiddleware` resolves the acting company FIRST, then overlays that
membership's role/permissions/staffType/managerId onto the request's user
object. Every existing `user.role` check keeps working verbatim and silently
becomes per-company. This is the single highest-leverage part of the change.

## Answers from Dan (2026-08-10)
1. Driver app: pick a company at login, see only that company's jobs, switcher to change.
2. Adding an existing email to a 2nd company = **invite they must accept**. The
   second company NEVER sets a password (that would hand them control of the
   person's login at company #1).
3. Role/permissions/manager are **per company**.
4. Shareable: field staff, customers, admins/managers — all three.
5. One login + password for everyone; switch companies.

## Work plan
- [x] Probe live DB: 6 companies, 21 users, 0 email collisions today.
- [ ] 1. `memberships` table + migration (generate, never db:push).
- [ ] 2. Backfill: one membership per existing user from user.companyId/role.
- [ ] 3. authMiddleware: resolve company from memberships; overlay per-company
      role/permissions. Superadmin keeps cross-tenant X-Company-Id.
- [ ] 4. `GET /api/me/companies` + `POST /api/me/company` (switch).
- [ ] 5. Team/riders create: existing email -> membership + invite, not 409.
- [ ] 6. Invite accept: create membership; if user exists, just attach (no password).
- [ ] 7. Team/customer LISTS must read via memberships, not user.companyId.
- [ ] 8. Web: company switcher in admin shell.
- [ ] 9. Mobile: company picker at login + switcher in profile.
- [ ] 10. Tests: cross-tenant isolation must still pass.

## Guardrails
- NEVER db:push against Turso (batch bug). db:generate -> commit -> db:migrate.
- Tenant isolation tests are the safety net — they must stay green.
- `memberships` is tenant-owned (has companyId) so tdb() auto-scopes it.
- Deleting a membership must NOT delete the person (they may work elsewhere).
</content>
