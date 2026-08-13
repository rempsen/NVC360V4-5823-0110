# Driver-app notification indicators (Aug 13)

## Goal (Dan)
1. Red count indicator on the app itself = unread messages + pending work orders (accept/decline).
2. Multi-company techs: visual indicator on the COMPANY that sent the message/work order, in the
   company picker + profile switcher, so they can tap that company to receive it.

## Plan
- [x] Audit: badge today = Messages tab only, unread DISPATCH direct msgs, ACTIVE company only.
      No Jobs-tab badge for offered work orders. Picker/switcher have no indicators at all.
      OS icon badge mirrors the messages-only count.
- [x] Backend `GET /api/me/notifications` in packages/web/src/api/routes/me.ts —
      company-agnostic, own memberships only, per-company {unreadMessages, pendingOffers}.
- [x] mobile lib/notify-summary.ts — single polled query feeding every indicator.
- [ ] (rider)/_layout.tsx — Jobs badge, Messages badge, Profile badge (elsewhere), icon = total.
- [ ] pick-company.tsx — per-company red badge + "2 new work orders · 1 message" line.
- [ ] profile.tsx switcher — same per-company badge.
- [ ] Jobs screen banner: "Acme is waiting on you" -> tap to switch.
- [ ] Tests (web): route tests for /api/me/notifications.
- [ ] Sabotage check.
- [ ] Gates: oxlint 0 / tsc non-TS2769 159 / bun test src >=293 / vite build / crash-sweep / a11y.
- [ ] Live proof: real server + real Turso, offered booking + unread msg across 2 companies.
- [ ] Commit + push.

## Notes
- `/api/messages/direct/unread` left untouched (other consumers) — new endpoint is additive.
- Job-thread unread counted only for jobs still assigned & not completed/cancelled, else the
  badge shows a number the tech cannot clear.
- Suspended companies never badge.
