import { Hono } from "hono";
import { requireAuth, tenantId } from "../middleware/auth";
import { parseRateModel, computeSubtotal, EMPTY_RATE_MODEL, type RateModel } from "../../shared/pricing";
import { lookupTax, taxRegionOptions, regionFromAddress } from "../../shared/tax";
import { round2 } from "../../shared/catalog";
import { quoteBooking, resolveRegion } from "../../services/billing";
import { parseBody, jsonBlob } from "../lib/validate";
import { z } from "zod";

/** Non-negative, finite, and capped — this feeds computeSubtotal(). */
const qty = z.number().finite().min(0).max(1_000_000).optional();

const QuoteBody = z.object({
  rateModel: jsonBlob(50_000).optional(),
  actualMinutes: qty,
  minutes: qty,
  actualKm: qty,
  km: qty,
  region: z.string().trim().max(64).optional(),
});

/** Address is optional: with no address we return the company default region. */
const TaxPreviewBody = z.object({
  address: z.string().trim().max(500).optional(),
  amount: z.number().finite().min(0).max(10_000_000),
});

function coerceRateModel(input: any): RateModel {
  if (!input) return { ...EMPTY_RATE_MODEL };
  if (typeof input === "string") return parseRateModel(input) ?? { ...EMPTY_RATE_MODEL };
  return { ...EMPTY_RATE_MODEL, ...input };
}

export const pricingRoutes = new Hono()
  // tax region dropdown options (CA provinces + US states)
  .get("/regions", requireAuth, async (c) => {
    return c.json({ regions: taxRegionOptions() }, 200);
  })
  // live preview: given a rate model + region + actuals, return the breakdown w/ tax
  .post("/quote", requireAuth, async (c) => {
    const body = await parseBody(c, QuoteBody);
    const rm = coerceRateModel(body.rateModel);
    const actualMinutes = body.actualMinutes ?? body.minutes ?? 0;
    const actualKm = body.actualKm ?? body.km ?? 0;
    const { subtotal, items } = computeSubtotal(rm, actualMinutes, actualKm);
    const tax = lookupTax(body.region);
    const taxRatePct = tax?.rate ?? 0;
    const taxLabel = tax?.label ?? "";
    const taxAmount = Math.round(subtotal * taxRatePct) / 100;
    const total = Math.round((subtotal + taxAmount) * 100) / 100;
    return c.json(
      { region: body.region ?? "", subtotal, taxRatePct, taxLabel, taxAmount, total, items },
      200
    );
  })
  /**
   * Authoritative tax preview for a not-yet-created booking, given the service
   * address the customer has typed so far.
   *
   * Why this exists: the customer booking page used to hardcode `basePrice * 0.13`
   * (Ontario HST) in the order summary. The invoice, meanwhile, is computed by
   * billing.ts from the REAL region — so a customer in Calgary was quoted 13% and
   * invoiced 5%, and a customer in Montreal was quoted 13% and invoiced 14.975%,
   * i.e. billed MORE than the total they agreed to. On a $140 job that's $2.77
   * over quote in Quebec and $11.20 over-quoted in Alberta.
   *
   * It deliberately calls the SAME resolveRegion() + lookupTax() the invoice
   * path uses, rather than re-deriving the region client-side, so the quote and
   * the invoice cannot drift — including the "address doesn't resolve, fall back
   * to this tenant's default region" case, which the browser can't know.
   */
  .post("/tax-preview", requireAuth, async (c) => {
    const body = await parseBody(c, TaxPreviewBody);
    // resolveRegion reads only .region and .address off the booking row; pass a
    // stub with no explicit region so it follows address -> company default.
    const region = await resolveRegion(tenantId(c), {
      region: "",
      address: body.address ?? "",
    } as any);
    const tax = lookupTax(region);
    const taxRatePct = tax?.rate ?? 0;
    // Same expression as services/billing.ts computeBilling() — including round2's
    // EPSILON nudge — so the previewed cents can never differ from the invoice.
    const taxAmount = round2((body.amount * taxRatePct) / 100);
    return c.json(
      {
        region,
        taxRatePct,
        taxLabel: tax?.label ?? "",
        taxRegion: tax?.region ?? "",
        taxAmount,
        total: round2(body.amount + taxAmount),
        /** false when we fell back to the company default (address unresolved) */
        fromAddress: !!body.address && !!regionFromAddress(body.address),
      },
      200,
    );
  })
  // recompute/preview an existing booking from its current actuals (no persist)
  .get("/quote/:bookingId", requireAuth, async (c) => {
    const r = await quoteBooking(tenantId(c), c.req.param("bookingId"));
    if (!r) return c.json({ message: "Not found" }, 404);
    return c.json(r, 200);
  });
