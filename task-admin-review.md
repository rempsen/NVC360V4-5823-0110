# Web/Admin platform expert review

Same treatment as the driver app review (Jul 2026): score against 10
App-Store-caliber criteria, then fix findings in order.

## Done this session (before review)
- d50edb6 in-app invite acceptance (driver app + /api/me/invites, decline)
- 63c5a54 background teardown (Live Activity + GPS self-shutoff)
- 0342720 voice note mic permission
- Build 12 in TestFlight, VALID

## Review criteria (10)
1. Reliability / error handling
2. Performance (bundle, query waterfalls, render cost)
3. Security & tenant isolation
4. Accessibility
5. Information architecture / navigation
6. Visual design & polish
7. Forms & data entry UX
8. Empty / loading / error states
9. Observability (Sentry, logging)
10. Mobile-web responsiveness

## Status
- [x] Inventory the admin surface
- [ ] Score each criterion with evidence
- [ ] Write findings report
