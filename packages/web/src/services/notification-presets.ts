/**
 * Per-ICP notification defaults.
 *
 * The base 15-row event×recipient channel matrix (see `seedNotificationRules`
 * in dispatch.ts) is a reasonable one-size-fits-all starting point, but real
 * trades differ a lot in how urgent/SMS-heavy vs. scheduled/email-heavy their
 * default communications should be. This file layers small, targeted
 * overrides on top of that base matrix, grouped into reusable "archetypes"
 * derived from the deep per-ICP research in `icp_knowledge_base`
 * (notificationRefinement column) — see /home/user/icp-research/<slug>/04-*.md
 * for the underlying source material.
 *
 * Tenants can still hand-edit every rule afterward in Notifications — this
 * only changes what they start with.
 */
import type { NvcEvent, Recipient } from "./dispatch";

export type ChannelOverride = Partial<{
  inApp: boolean;
  email: boolean;
  sms: boolean;
  webhook: boolean;
}>;

type Key = `${NvcEvent}:${Recipient}`;
type OverrideMap = Partial<Record<Key, ChannelOverride>>;

/** Emergency / same-day dispatch trades: bias toward SMS for urgency at every stage. */
const URGENT_DISPATCH: OverrideMap = {
  "created:client": { sms: true }, // instant ack matters when it might be an emergency call
  "accepted:client": { sms: true },
  "cancelled:client": { sms: true }, // a cancelled emergency job needs to reach the client immediately
};

/** Long-cycle project trades (weeks/months, milestone-driven): de-emphasize SMS, lean on email digests. */
const LONG_CYCLE_PROJECT: OverrideMap = {
  "enroute:client": { sms: false, email: true },
  "arrived:client": { sms: false },
  "accepted:client": { email: true },
  "completed:office": { email: true },
};

/** Resident/tenant-facing (work order created by someone other than the payer): keep the occupant in the loop. */
const TENANT_FACING: OverrideMap = {
  "assigned:client": { sms: true },
  "completed:client": { sms: true },
};

/** Parent/guardian or renter facing, SMS-first per research ("session reminder ... SMS-first"). */
const SMS_FIRST_CONSUMER: OverrideMap = {
  "created:client": { sms: true },
  "assigned:client": { sms: true },
  "completed:client": { sms: true },
};

/** Recurring billing / low-touch logistics (rental cycles, off-rent, invoices): email over SMS. */
const LOW_TOUCH_BILLING: OverrideMap = {
  "enroute:client": { sms: false },
  "arrived:client": { sms: false },
  "receipt:client": { email: true },
};

/** Storm/weather-triggered crew coordination: office/dispatcher needs an immediate heads-up too. */
const STORM_CREW_ALERT: OverrideMap = {
  "created:office": { sms: true },
};

/**
 * Map of industry-presets.ts id -> channel overrides, merged onto the base
 * matrix in seedNotificationRules(). Later keys in a merged object win.
 * ICPs not listed here get the plain base matrix (this includes brand-new or
 * "other" industries with no research yet).
 */
export const NOTIFICATION_OVERRIDES: Record<string, OverrideMap> = {
  // Core, research-backed trades
  electrical: URGENT_DISPATCH,
  "hvac-plumbing": URGENT_DISPATCH,
  "garage-door": URGENT_DISPATCH,
  restoration: URGENT_DISPATCH,
  "concrete-foundation-repair": URGENT_DISPATCH,
  "commercial-building-maintenance": { ...URGENT_DISPATCH, ...TENANT_FACING },
  "tree-care": { ...URGENT_DISPATCH, ...STORM_CREW_ALERT },
  "landscaping-grounds-snow": STORM_CREW_ALERT,

  "home-builder-developer": LONG_CYCLE_PROJECT,
  "design-build": LONG_CYCLE_PROJECT,
  "renovation-contractor": LONG_CYCLE_PROJECT,
  "painting-decorating": LONG_CYCLE_PROJECT,
  flooring: LONG_CYCLE_PROJECT,
  exteriors: LONG_CYCLE_PROJECT,

  // Outlier / lighter-treatment ICPs (per their own "hold" research verdict) —
  // still get a light, research-grounded nudge, not a full custom profile.
  "property-management-maintenance": TENANT_FACING,
  "sports-organization": SMS_FIRST_CONSUMER,
  "equipment-rental": LOW_TOUCH_BILLING,
};

/** Merge an industry's overrides onto a base default row list (mutates a copy, returns new array). */
export function applyNotificationOverrides<
  T extends { event: NvcEvent; recipient: Recipient },
>(base: T[], industry: string | null | undefined): T[] {
  const overrides = (industry && NOTIFICATION_OVERRIDES[industry]) || null;
  if (!overrides) return base;
  return base.map((row) => {
    const key = `${row.event}:${row.recipient}` as Key;
    const patch = overrides[key];
    return patch ? { ...row, ...patch } : row;
  });
}
