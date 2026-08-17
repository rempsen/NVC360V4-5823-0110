import { Hono } from "hono";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq } from "drizzle-orm";
import { requireAuth, tx } from "../middleware/auth";
import { isAdminRole } from "../lib/permissions";
import { notify, buildEmailData } from "../../services/notify";
import { getStripe, stripeEnabled, STRIPE_PUBLISHABLE_KEY, toMinor } from "../../services/stripe";
import { AppError, Err } from "../lib/errors";
import { log } from "../lib/logger";
import { capture } from "../lib/analytics";
import { incr } from "../lib/metrics";
import { jsonBody, money } from "../lib/validate";
import { z } from "zod";
import type { AppEnv } from "../env";

const RefundBody = z.object({
  amount: money("Refund amount").positive("Refund amount must be greater than zero").optional(),
  reason: z.string().trim().max(400, "Reason must be 400 characters or fewer").optional(),
});

type SessionUser = { id: string };

/** Append an immutable ledger row. Never throws into the request path. */
async function ledger(row: {
  companyId?: string;
  invoiceId?: string | null;
  bookingId?: string | null;
  kind: "charge" | "refund" | "dispute" | "adjustment";
  amount: number;
  currency: string;
  stripeObjectId?: string | null;
  status: "succeeded" | "pending" | "failed";
  memo?: string;
}) {
  try {
    // Derive the tenant from the linked invoice when not explicitly supplied
    // (webhook context has no request user). Falls back to "default".
    let companyId = row.companyId;
    if (!companyId && row.invoiceId) {
      const [inv] = await db
        .select({ companyId: schema.invoices.companyId })
        .from(schema.invoices)
        .where(eq(schema.invoices.id, row.invoiceId));
      companyId = inv?.companyId;
    }
    await db.insert(schema.paymentLedger).values({
      companyId: companyId ?? "default",
      invoiceId: row.invoiceId ?? null,
      bookingId: row.bookingId ?? null,
      kind: row.kind,
      amount: row.amount,
      currency: row.currency,
      stripeObjectId: row.stripeObjectId ?? null,
      status: row.status,
      memo: row.memo,
    });
  } catch (e) {
    log.error("ledger write failed", { err: (e as Error).message, ...row });
  }
}

/** Reflect a Stripe PaymentIntent's terminal/intermediate state onto our invoice. */
async function syncInvoiceFromIntent(pi: {
  id: string;
  status: string;
  latest_charge?: string | null;
  last_payment_error?: { message?: string } | null;
}) {
  const [inv] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.stripePaymentIntentId, pi.id));
  if (!inv) return null;

  let status = inv.status;
  if (pi.status === "succeeded") status = "paid";
  else if (pi.status === "processing") status = "processing";
  else if (pi.status === "canceled") status = "failed";
  else if (pi.status === "requires_payment_method" && pi.last_payment_error) status = "failed";

  const paidNow = status === "paid" && inv.status !== "paid";

  await db
    .update(schema.invoices)
    .set({
      status,
      stripeChargeId: pi.latest_charge ?? inv.stripeChargeId,
      lastPaymentError: pi.last_payment_error?.message ?? null,
      paidAt: status === "paid" ? (inv.paidAt ?? new Date()) : inv.paidAt,
    })
    .where(eq(schema.invoices.id, inv.id));

  if (status === "paid") {
    await db
      .update(schema.bookings)
      .set({ paymentStatus: "paid" })
      .where(eq(schema.bookings.id, inv.bookingId));
  }

  if (paidNow) {
    await ledger({
      invoiceId: inv.id,
      bookingId: inv.bookingId,
      kind: "charge",
      amount: inv.total,
      currency: inv.currency,
      stripeObjectId: pi.latest_charge ?? pi.id,
      status: "succeeded",
      memo: `Invoice ${inv.number} paid`,
    });
    incr("invoices_paid_total");
    incr("revenue_paid_cents_total", Math.round(inv.total * 100));
    capture("invoice.paid", inv.companyId, {
      invoiceId: inv.id,
      bookingId: inv.bookingId,
      amount: inv.total,
      currency: inv.currency,
    });
    // receipt email + in-app notification
    const ed = await buildEmailData(inv.companyId, inv.bookingId);
    if (ed) {
      await notify({
        companyId: inv.companyId,
        type: "receipt",
        userId: inv.customerId,
        bookingId: inv.bookingId,
        title: "Payment received",
        body: `Receipt ${inv.number} — $${inv.total.toFixed(2)} paid.`,
        emailKind: "receipt",
        email: ed.email,
        emailData: { ...ed.emailData, price: inv.total, invoiceNumber: inv.number },
      }).catch((e) => log.error("receipt notify failed", { err: (e as Error).message }));
    }
  }
  return { inv, status };
}

export const paymentsRoutes = new Hono<AppEnv>()
  // publishable key + capability flag for the browser
  .get("/config", (c) =>
    c.json({ enabled: stripeEnabled, publishableKey: STRIPE_PUBLISHABLE_KEY }, 200),
  )

  // Get the invoice for a booking.
  //
  // 404 means "you can't see this booking" — a booking outside your tenant, or
  // one that isn't yours when you're a customer/tech. A booking you CAN see
  // that simply hasn't been invoiced yet is a normal, healthy state and returns
  // 200 with `invoice: null`, so the customer tracking page doesn't error out
  // on every job before its invoice exists.
  .get("/invoice/:bookingId", requireAuth, async (c) => {
    const u = c.get("user") as SessionUser & { role?: string };
    const t = tx(c);
    const bookingId = c.req.param("bookingId");

    const b = await t.selectOne(schema.bookings, eq(schema.bookings.id, bookingId));
    if (!b) return c.json({ message: "Not found" }, 404);

    // Tenant scoping alone is not enough: without this, any signed-in customer
    // could read a co-tenant's invoice by guessing a booking id. Office roles
    // (admin/superadmin/manager/dispatcher/...) legitimately see every invoice
    // in their own tenant; the two roles that are scoped to their own work are
    // the client and the technician.
    if (u.role === "customer" || u.role === "rider") {
      let allowed = false;
      if (u.role === "rider") {
        const rp = await t.selectOne(schema.riders, eq(schema.riders.userId, u.id));
        allowed = !!rp && !!b.riderId && rp.id === b.riderId;
      } else {
        allowed = b.customerId === u.id;
      }
      if (!allowed) return c.json({ message: "Not found" }, 404);
    }

    const inv = await t.selectOne(schema.invoices, eq(schema.invoices.bookingId, bookingId));
    return c.json({ invoice: inv ?? null }, 200);
  })

  // Create (or reuse) a PaymentIntent for a booking's invoice and return its
  // client_secret so the browser can confirm with Stripe Elements.
  // Idempotent: a client-supplied Idempotency-Key dedupes retries.
  .post("/intent/:bookingId", requireAuth, async (c) => {
    if (!stripeEnabled) throw new AppError(503, "payments_disabled", "Payments are not configured");
    const u = c.get("user") as SessionUser;
    const bookingId = c.req.param("bookingId");

    const inv = await tx(c).selectOne(schema.invoices, eq(schema.invoices.bookingId, bookingId));
    if (!inv) throw Err.notFound("Invoice not found");
    if (inv.status === "paid") return c.json({ alreadyPaid: true, invoice: inv }, 200);

    const stripe = getStripe();
    const idemKey = c.req.header("Idempotency-Key") || `pi_${inv.id}`;

    // reuse an existing open intent if we have one (avoids duplicate charges)
    let pi;
    if (inv.stripePaymentIntentId) {
      pi = await stripe.paymentIntents.retrieve(inv.stripePaymentIntentId).catch(() => null);
      if (pi && ["canceled", "succeeded"].includes(pi.status)) pi = null;
      // keep amount in sync if invoice total changed
      if (pi && pi.amount !== toMinor(inv.total)) {
        pi = await stripe.paymentIntents.update(pi.id, { amount: toMinor(inv.total) });
      }
    }
    if (!pi) {
      pi = await stripe.paymentIntents.create(
        {
          amount: toMinor(inv.total),
          currency: inv.currency,
          automatic_payment_methods: { enabled: true },
          metadata: { invoiceId: inv.id, bookingId, customerId: u.id, number: inv.number },
          description: `NVC360 invoice ${inv.number}`,
        },
        { idempotencyKey: idemKey },
      );
      await tx(c).update(
        schema.invoices,
        { stripePaymentIntentId: pi.id, status: "processing", lastPaymentError: null },
        eq(schema.invoices.id, inv.id),
      );
    }

    return c.json({ clientSecret: pi.client_secret, paymentIntentId: pi.id, publishableKey: STRIPE_PUBLISHABLE_KEY }, 200);
  })

  // Confirm/refresh: poll Stripe for the latest intent state and reconcile.
  // Used as a fallback when the webhook is delayed.
  .post("/sync/:bookingId", requireAuth, async (c) => {
    if (!stripeEnabled) throw new AppError(503, "payments_disabled", "Payments are not configured");
    const bookingId = c.req.param("bookingId");
    const t = tx(c);
    const inv = await t.selectOne(schema.invoices, eq(schema.invoices.bookingId, bookingId));
    if (!inv?.stripePaymentIntentId) throw Err.notFound("No payment in progress");

    const pi = await getStripe().paymentIntents.retrieve(inv.stripePaymentIntentId);
    // `retrieve` resolves to Stripe's Response<PaymentIntent> wrapper (the intent
    // plus `lastResponse`); the syncer only reads intent fields.
    await syncInvoiceFromIntent(pi as unknown as Parameters<typeof syncInvoiceFromIntent>[0]);
    const fresh = await t.selectOne(schema.invoices, eq(schema.invoices.id, inv.id));
    return c.json({ invoice: fresh }, 200);
  })

  // Refund (full or partial). Writes a negative ledger entry.
  .post("/refund/:bookingId", requireAuth, jsonBody(RefundBody), async (c) => {
    if (!stripeEnabled) throw new AppError(503, "payments_disabled", "Payments are not configured");
    const u = c.get("user") as SessionUser & { role?: string };
    if (u.role && !(isAdminRole(u.role) || ["owner", "dispatcher"].includes(u.role))) {
      throw Err.forbidden("Not allowed to issue refunds");
    }
    const bookingId = c.req.param("bookingId");
    // `amount` was unchecked: NaN survives `Math.min(NaN, remaining)` and the
    // `amount <= 0` guard (both comparisons are false with NaN), so a NaN
    // refund reached the Stripe API. `reason` was unbounded and goes into
    // Stripe metadata, which rejects values over 500 chars.
    const body = c.req.valid("json");

    const t = tx(c);
    const inv = await t.selectOne(schema.invoices, eq(schema.invoices.bookingId, bookingId));
    if (!inv) throw Err.notFound("Invoice not found");
    if (!inv.stripePaymentIntentId || inv.status !== "paid") {
      throw Err.conflict("Invoice is not in a refundable state");
    }

    const remaining = inv.total - inv.amountRefunded;
    const amount = body.amount != null ? Math.min(body.amount, remaining) : remaining;
    if (amount <= 0) throw Err.conflict("Nothing left to refund");

    const stripe = getStripe();
    const refund = await stripe.refunds.create(
      {
        payment_intent: inv.stripePaymentIntentId,
        amount: toMinor(amount),
        reason: "requested_by_customer",
        metadata: { invoiceId: inv.id, bookingId, by: u.id, note: body.reason ?? "" },
      },
      { idempotencyKey: `refund_${inv.id}_${toMinor(amount)}_${inv.amountRefunded}` },
    );

    const newRefunded = inv.amountRefunded + amount;
    const fullyRefunded = newRefunded >= inv.total - 0.001;
    await t.update(
      schema.invoices,
      { amountRefunded: newRefunded, status: fullyRefunded ? "refunded" : inv.status },
      eq(schema.invoices.id, inv.id),
    );
    if (fullyRefunded) {
      await t.update(
        schema.bookings,
        { paymentStatus: "refunded" },
        eq(schema.bookings.id, bookingId),
      );
    }

    await ledger({
      invoiceId: inv.id,
      bookingId,
      kind: "refund",
      amount: -amount,
      currency: inv.currency,
      stripeObjectId: refund.id,
      status: "succeeded",
      memo: body.reason ?? "Refund issued",
    });

    const fresh = await t.selectOne(schema.invoices, eq(schema.invoices.id, inv.id));
    return c.json({ invoice: fresh, refundId: refund.id, refunded: amount }, 200);
  })

  // ledger view for an invoice/booking (audit)
  .get("/ledger/:bookingId", requireAuth, async (c) => {
    const rows = await tx(c).select(
      schema.paymentLedger,
      eq(schema.paymentLedger.bookingId, c.req.param("bookingId")),
    );
    return c.json({ entries: rows }, 200);
  });

// Exported for the webhook route (mounted before auth in api/index.ts).
export { syncInvoiceFromIntent, ledger };
