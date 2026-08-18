import * as schema from "../api/database/schema";
import { eq } from "drizzle-orm";
import { tdb } from "../api/database/tenant";
import { parseRateModel, computeSubtotal, EMPTY_RATE_MODEL, type RateModel } from "../shared/pricing";
import { lookupTax, regionFromAddress } from "../shared/tax";
import { parseLineItems, sumLineItems, round2 } from "../shared/catalog";
import { computeTechPay, type TechPayResult } from "../shared/tech-pay";

/**
 * Tenancy: every function takes the resolved `companyId` and routes all
 * tenant-table access through `tdb(companyId)`, which auto-scopes reads/writes
 * to the company and fails closed when the id doesn't belong to the tenant.
 * The booking is always re-fetched scoped, so a booking from another tenant is
 * invisible here (returns null) rather than silently billed.
 */

/** Resolve the effective rate model for a booking: booking snapshot > template > service > legacy basePrice. */
export async function resolveRateModel(companyId: string, b: typeof schema.bookings.$inferSelect): Promise<RateModel> {
  const t = tdb(companyId);
  const fromBooking = parseRateModel(b.rateModel);
  if (fromBooking) return fromBooking;
  if (b.templateId) {
    const tpl = await t.selectOne(schema.taskTemplates, eq(schema.taskTemplates.id, b.templateId));
    const fromTpl = parseRateModel(tpl?.rateModel);
    if (fromTpl) return fromTpl;
  }
  const svc = await t.selectOne(schema.services, eq(schema.services.id, b.serviceId));
  const fromSvc = parseRateModel(svc?.rateModel);
  if (fromSvc) return fromSvc;
  // legacy: treat basePrice/price as a pure flat rate
  return { ...EMPTY_RATE_MODEL, flatRate: b.price || svc?.basePrice || 0 };
}

/** Determine tax region for a booking (explicit > address > company default). */
export async function resolveRegion(companyId: string, b: typeof schema.bookings.$inferSelect): Promise<string> {
  if (b.region) return b.region;
  const fromAddr = regionFromAddress(b.address);
  if (fromAddr) return fromAddr;
  // company default — keyed by THIS tenant's settings row, not the legacy
  // `id="default"` singleton (which returned MB/0 tax for every non-default company).
  const co = await tdb(companyId).selectOne(schema.companySettings);
  return co?.defaultRegion || "MB";
}

export interface BillingResult {
  region: string;
  subtotal: number;
  taxRatePct: number;
  taxLabel: string;
  taxAmount: number;
  total: number;
  lineItemsCost?: number;
  lineItemsPrice?: number;
  items: { label: string; qty: number; unit: string; rate: number; amount: number }[];
}

/** Recompute a booking's client charge from its rate model + actuals, persist, return breakdown. */
export async function recomputeBooking(
  companyId: string,
  bookingId: string,
  opts: { actualMinutes?: number; actualKm?: number; persist?: boolean } = {}
): Promise<BillingResult | null> {
  const t = tdb(companyId);
  const b = await t.selectOne(schema.bookings, eq(schema.bookings.id, bookingId));
  if (!b) return null;
  const rm = await resolveRateModel(companyId, b);
  const region = await resolveRegion(companyId, b);

  const actualMinutes = opts.actualMinutes ?? b.onSiteMinutes ?? 0;
  const actualKm = opts.actualKm ?? b.mileageKm ?? 0;

  const { subtotal: rateSubtotal, items: rateItems } = computeSubtotal(rm, actualMinutes, actualKm);

  // ---- catalog line items ----
  const lineItems = parseLineItems(b.lineItems);
  const li = sumLineItems(lineItems);
  // append line items to the breakdown so client records show them explicitly.
  // pay-only per-unit lines (kind "unit" with no customer charge) are hidden from the invoice.
  const invoiceLines = lineItems.filter((x) => !(x.kind === "unit" && (x.price || 0) <= 0));
  const items = [
    ...rateItems,
    ...invoiceLines.map((x) => ({
      label: x.kind === "assembly" ? `${x.name} (assembly)` : x.name,
      qty: x.qty,
      unit: x.unit,
      rate: x.unitPrice,
      amount: x.price,
    })),
  ];

  const subtotal = round2(rateSubtotal + li.price);

  // tax: rate-model portion is fully taxable; line items respect their per-item taxable flag
  const tax = lookupTax(region);
  const taxRatePct = tax?.rate ?? 0;
  const taxLabel = tax?.label ?? "";
  const taxableBase = round2(rateSubtotal + li.taxablePrice);
  const taxAmount = round2((taxableBase * taxRatePct) / 100);
  const total = round2(subtotal + taxAmount);

  const result: BillingResult = { region, subtotal, taxRatePct, taxLabel, taxAmount, total, items, lineItemsCost: li.cost, lineItemsPrice: li.price };

  if (opts.persist !== false) {
    await t.update(schema.bookings, {
      region,
      subtotal,
      taxRatePct,
      taxLabel,
      taxAmount,
      total,
      price: total,
      lineItemsCost: li.cost,
      lineItemsPrice: li.price,
      priceBreakdown: JSON.stringify(items),
      rateModel: JSON.stringify(rm),
    }, eq(schema.bookings.id, bookingId));
  }
  return result;
}

/** Quote without persisting (live preview / estimates). */
export async function quoteBooking(companyId: string, bookingId: string, actualMinutes?: number, actualKm?: number) {
  return recomputeBooking(companyId, bookingId, { actualMinutes, actualKm, persist: false });
}

export type { TechPayResult } from "../shared/tech-pay";

/** Compute & persist tech pay for a completed job.
 *  = hourly pay (on-site time × rider hourly rate) + ad-hoc per-unit line pay.
 *  The arithmetic lives in `shared/tech-pay.ts` so job completion, payout
 *  generation and the Earnings screens can never drift apart. */
export async function accrueTechPay(companyId: string, bookingId: string): Promise<TechPayResult | null> {
  const t = tdb(companyId);
  const b = await t.selectOne(schema.bookings, eq(schema.bookings.id, bookingId));
  if (!b || !b.riderId) return null;
  const r = await t.selectOne(schema.riders, eq(schema.riders.id, b.riderId));
  if (!r) return null;
  const pay = computeTechPay({
    onSiteMinutes: b.onSiteMinutes || 0,
    payRatePerHour: r.payRatePerHour || 0,
    lineItems: parseLineItems(b.lineItems),
  });
  const breakdown = {
    onSiteMinutes: b.onSiteMinutes || 0,
    hours: pay.hours,
    payRatePerHour: pay.payRatePerHour,
    hourlyPay: pay.hourlyPay,
    unitPay: pay.unitPay,
    mileageKm: b.mileageKm || 0,
    techPay: pay.techPay,
    unrated: pay.unrated,
  };
  await t.update(schema.bookings, {
    techPay: pay.techPay,
    techPayBreakdown: JSON.stringify(breakdown),
  }, eq(schema.bookings.id, bookingId));
  return pay;
}
