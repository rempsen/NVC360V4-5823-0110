import { sumUnitLinePay, round2, type LineItem } from "./catalog";

/**
 * What the technician actually earns on a job.
 *
 *   tech pay = (on-site minutes -> hours) x the tech's hourly rate
 *            + the pay side of every per-unit line item (e.g. $1.20/sq-ft installed)
 *
 * This is the single source of truth. It is used when a job is completed
 * (`accrueTechPay`), when a payout is generated for a pay period, and by the
 * Earnings screens — so all three always agree. Previously payouts were a flat
 * percentage of the customer's invoice, which could never reconcile with what
 * the driver app told the tech they had earned.
 *
 * Deliberately pure and defensive:
 *  - `Number(undefined)` / `Number("nonsense")` is NaN, and NaN money silently
 *    poisons every total downstream, so non-finite inputs fall back to 0.
 *  - Negative minutes or a negative rate (a typo in the team screen) must never
 *    produce negative pay, which would quietly claw back other jobs in the same
 *    payout period.
 *  - Catalog/product cost is company COGS, NOT tech pay — only `kind: "unit"`
 *    lines pay the tech (see `sumUnitLinePay`).
 */
export interface TechPayInput {
  /** Billed minutes actually worked on site (the geofenced clock). */
  onSiteMinutes: number;
  /** The tech's hourly rate for on-site time, from their team/rider record. */
  payRatePerHour: number;
  /** Parsed line items on the booking. */
  lineItems: LineItem[];
}

export interface TechPayResult {
  hours: number;
  payRatePerHour: number;
  hourlyPay: number;
  unitPay: number;
  techPay: number;
  /**
   * True when this job produced $0 because nobody set the tech's hourly rate
   * and there was no per-unit pay either — i.e. the office needs to fix the
   * rate, not a tech who genuinely earned nothing. Surfaced on the payout so a
   * $0 line is never mistaken for a correct one.
   */
  unrated: boolean;
}

/** Non-finite / negative -> 0. Never let bad config become NaN or negative money. */
function safe(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

export function computeTechPay(input: TechPayInput): TechPayResult {
  const payRatePerHour = safe(input.payRatePerHour);
  const minutes = safe(input.onSiteMinutes);
  const hours = round2(minutes / 60);
  const hourlyPay = round2(hours * payRatePerHour);
  // sumUnitLinePay can go negative if someone entered a negative unit cost;
  // clamp so a bad line can't reduce pay earned on other jobs in the period.
  const unitPay = Math.max(0, sumUnitLinePay(input.lineItems ?? []));
  const techPay = round2(hourlyPay + unitPay);
  const unrated = payRatePerHour === 0 && unitPay === 0;
  return { hours, payRatePerHour, hourlyPay, unitPay, techPay, unrated };
}
