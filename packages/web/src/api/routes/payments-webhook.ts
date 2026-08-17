import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq } from "drizzle-orm";
import { getStripe, stripeEnabled, STRIPE_WEBHOOK_SECRET, fromMinor } from "../../services/stripe";
import { syncInvoiceFromIntent, ledger } from "./payments";
import { log } from "../lib/logger";
import type Stripe from "stripe";
import type { AppEnv } from "../env";

/**
 * Stripe webhook — mounted BEFORE json parsing/auth in api/index.ts so we can
 * read the raw request body for signature verification. Replay-safe via the
 * idempotency_keys table (keyed on the Stripe event id).
 */
export const paymentsWebhookRoutes = new Hono<AppEnv>().post("/", async (c) => {
  if (!stripeEnabled) return c.json({ received: false, reason: "stripe disabled" }, 200);

  const sig = c.req.header("stripe-signature");
  const raw = await c.req.text();

  // Fail closed in production: never accept an unsigned/unverifiable webhook.
  const isProd = process.env.NODE_ENV === "production";
  if (isProd && (!STRIPE_WEBHOOK_SECRET || !sig)) {
    log.error("stripe webhook rejected: signature required in production", {
      hasSecret: !!STRIPE_WEBHOOK_SECRET,
      hasSig: !!sig,
    });
    return c.json({ error: "webhook signature required" }, 400);
  }

  let event: Stripe.Event;
  const stripe = getStripe();
  try {
    if (STRIPE_WEBHOOK_SECRET && sig) {
      event = stripe.webhooks.constructEvent(raw, sig, STRIPE_WEBHOOK_SECRET);
    } else {
      // dev fallback when no signing secret is configured yet — parse only.
      // NEVER reached in prod because STRIPE_WEBHOOK_SECRET will be set.
      log.warn("stripe webhook signature NOT verified (no secret configured)");
      event = JSON.parse(raw) as Stripe.Event;
    }
  } catch (err) {
    log.error("stripe webhook signature verification failed", { err: (err as Error).message });
    return c.json({ error: "invalid signature" }, 400);
  }

  if (!event?.id) return c.json({ error: "missing event id" }, 400);

  // idempotent replay guard
  const existing = await db
    .select()
    .from(schema.idempotencyKeys)
    .where(eq(schema.idempotencyKeys.key, event.id));
  if (existing.length) return c.json({ received: true, duplicate: true }, 200);
  await db
    .insert(schema.idempotencyKeys)
    .values({ key: event.id, scope: "stripe_webhook", responseStatus: 200 })
    .onConflictDoNothing();

  try {
    switch (event.type) {
      case "payment_intent.succeeded":
      case "payment_intent.processing":
      case "payment_intent.payment_failed":
      case "payment_intent.canceled": {
        const pi = event.data.object as Stripe.PaymentIntent;
        await syncInvoiceFromIntent({
          id: pi.id,
          status: pi.status,
          latest_charge: typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id ?? null,
          last_payment_error: pi.last_payment_error ? { message: pi.last_payment_error.message } : null,
        });
        break;
      }
      case "charge.refunded": {
        const ch = event.data.object as Stripe.Charge;
        const piId = typeof ch.payment_intent === "string" ? ch.payment_intent : ch.payment_intent?.id;
        if (piId) {
          const [inv] = await db
            .select()
            .from(schema.invoices)
            .where(eq(schema.invoices.stripePaymentIntentId, piId));
          if (inv) {
            const refunded = fromMinor(ch.amount_refunded);
            const fully = refunded >= inv.total - 0.001;
            await db
              .update(schema.invoices)
              .set({ amountRefunded: refunded, status: fully ? "refunded" : inv.status })
              .where(eq(schema.invoices.id, inv.id));
            if (fully) {
              await db
                .update(schema.bookings)
                .set({ paymentStatus: "refunded" })
                .where(eq(schema.bookings.id, inv.bookingId));
            }
          }
        }
        break;
      }
      case "charge.dispute.created": {
        const dp = event.data.object as Stripe.Dispute;
        const piId = typeof dp.payment_intent === "string" ? dp.payment_intent : dp.payment_intent?.id;
        const [inv] = piId
          ? await db.select().from(schema.invoices).where(eq(schema.invoices.stripePaymentIntentId, piId))
          : [undefined];
        await ledger({
          invoiceId: inv?.id ?? null,
          bookingId: inv?.bookingId ?? null,
          kind: "dispute",
          amount: -fromMinor(dp.amount),
          currency: dp.currency,
          stripeObjectId: dp.id,
          status: "pending",
          memo: `Dispute opened: ${dp.reason}`,
        });
        break;
      }
      default:
        log.info("stripe webhook ignored event", { type: event.type });
    }
  } catch (err) {
    log.error("stripe webhook handler error", { type: event.type, err: (err as Error).message });
    return c.json({ error: "handler error" }, 500);
  }

  return c.json({ received: true }, 200);
});
