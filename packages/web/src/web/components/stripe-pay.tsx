import { useEffect, useMemo, useState } from "react";
import { DialogPanel } from "./dialog-panel";
// NOTE: import from "@stripe/stripe-js/pure", NOT "@stripe/stripe-js".
// The normal entrypoint injects <script src="js.stripe.com/..."> as a MODULE
// SIDE EFFECT, at import time. Rollup placed this package in the eagerly loaded
// `vendor` chunk, so every visitor — including someone sitting on the sign-in
// screen who will never pay for anything — was fetching three remote Stripe
// scripts (js.stripe.com plus m.stripe.network's fingerprinting bundle) on
// first paint. The `/pure` entrypoint defers that network work until loadStripe()
// is actually called, i.e. when a customer opens the payment modal.
import { loadStripe } from "@stripe/stripe-js/pure";
// Type-only import: `import type` is erased at compile time, so this pulls in
// no runtime module and cannot reintroduce the side effect described above.
// (The /pure entrypoint doesn't re-export the Stripe type itself.)
import type { Stripe } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import { api } from "../lib/api";
import { money, dismiss } from "../lib/utils";
import { Loader } from "./loader";
import { CreditCard, CheckCircle2, ShieldCheck, X } from "lucide-react";

/**
 * Real Stripe payment modal (PaymentElement).
 *  - POST /payments/intent/:bookingId  -> { clientSecret, publishableKey }
 *  - confirmPayment (card entered by the customer)
 *  - POST /payments/sync/:bookingId    -> reconcile immediately (webhook is the
 *    source of truth, this just gives instant UI feedback)
 */

// Cache the Stripe.js singleton per publishable key.
const stripeCache = new Map<string, Promise<Stripe | null>>();
function stripePromiseFor(pk: string) {
  if (!stripeCache.has(pk)) stripeCache.set(pk, loadStripe(pk));
  return stripeCache.get(pk)!;
}

type IntentResp = {
  clientSecret?: string;
  paymentIntentId?: string;
  publishableKey?: string;
  alreadyPaid?: boolean;
};

export function StripePayModal({
  bookingId,
  amount,
  invoiceNumber,
  onClose,
  onPaid,
}: {
  bookingId: string;
  amount: number;
  invoiceNumber: string;
  onClose: () => void;
  onPaid: () => void;
}) {
  const [intent, setIntent] = useState<IntentResp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.payments.intent[":bookingId"].$post({
          param: { bookingId },
          // a stable idempotency key per booking dedupes accidental retries
          header: { "Idempotency-Key": `intent_${bookingId}` },
        } as any);
        const data = (await res.json()) as IntentResp;
        if (cancelled) return;
        if (data.alreadyPaid) {
          onPaid();
          return;
        }
        if (!data.clientSecret || !data.publishableKey) {
          setError("Could not start payment. Please try again.");
          return;
        }
        setIntent(data);
      } catch {
        if (!cancelled) setError("Payments are not available right now.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bookingId, onPaid]);

  const stripePromise = useMemo(
    () => (intent?.publishableKey ? stripePromiseFor(intent.publishableKey) : null),
    [intent?.publishableKey],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      {...dismiss(onClose)}
    >
      <DialogPanel onClose={onClose} label="Pay invoice securely" className="w-full max-w-md rounded-2xl bg-ink-2 p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-extrabold text-white">Pay securely</h3>
            <p className="text-sm text-slate-500">Invoice {invoiceNumber}</p>
          </div>
          <button onClick={onClose} className="rounded-full p-1 text-slate-500 hover:bg-white/5 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4 flex items-center justify-between rounded-xl bg-ink px-4 py-3">
          <span className="text-sm text-slate-500">Total (CAD)</span>
          <span className="text-lg font-extrabold text-cyan-glow">{money(amount)}</span>
        </div>

        {error && (
          <div className="mt-4 rounded-xl bg-red-500/10 px-4 py-3 text-sm font-medium text-red-400">
            {error}
          </div>
        )}

        {!intent && !error && (
          <div className="mt-8 flex flex-col items-center gap-3 py-6">
            <Loader className="h-6 w-6 border-white/30 border-t-cyan-glow" />
            <p className="text-sm text-slate-500">Setting up secure checkout…</p>
          </div>
        )}

        {intent?.clientSecret && stripePromise && (
          <Elements
            stripe={stripePromise}
            options={{
              clientSecret: intent.clientSecret,
              appearance: {
                theme: "night",
                variables: {
                  colorPrimary: "#06B6D4",
                  colorBackground: "#0f1419",
                  borderRadius: "12px",
                },
              },
            }}
          >
            <PayForm bookingId={bookingId} amount={amount} onPaid={onPaid} />
          </Elements>
        )}

        <p className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-slate-600">
          <ShieldCheck className="h-3.5 w-3.5" /> Payments secured by Stripe
        </p>
      </DialogPanel>
    </div>
  );
}

function PayForm({
  bookingId,
  amount,
  onPaid,
}: {
  bookingId: string;
  amount: number;
  onPaid: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setErr(null);

    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: "if_required",
    });

    if (error) {
      setErr(error.message ?? "Payment failed. Please check your card details.");
      setSubmitting(false);
      return;
    }

    if (paymentIntent && ["succeeded", "processing"].includes(paymentIntent.status)) {
      // reconcile our invoice immediately (webhook stays the source of truth)
      await api.payments.sync[":bookingId"]
        .$post({ param: { bookingId } })
        .catch(() => {});
      setDone(true);
      setTimeout(onPaid, 900);
      return;
    }

    setErr("Payment could not be completed. Please try again.");
    setSubmitting(false);
  }

  if (done) {
    return (
      <div className="mt-6 flex flex-col items-center gap-2 py-6">
        <CheckCircle2 className="h-12 w-12 text-green-500" />
        <p className="font-bold text-white">Payment received</p>
        <p className="text-sm text-slate-500">Thank you from the NVC 360 team.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-5">
      <PaymentElement options={{ layout: "tabs" }} />
      {err && (
        <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{err}</p>
      )}
      <button
        type="submit"
        disabled={!stripe || submitting}
        className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-brand py-3.5 font-semibold text-white shadow-lg shadow-brand/30 transition hover:bg-brand-deep disabled:opacity-60"
      >
        {submitting ? (
          <Loader className="h-5 w-5 border-white/40 border-t-white" />
        ) : (
          <>
            <CreditCard className="h-4.5 w-4.5" /> Pay {money(amount)}
          </>
        )}
      </button>
    </form>
  );
}
