import { useEffect, useState } from "react";
import { useParams, useLocation, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { FullLoader, Loader } from "../../components/loader";
import { StoredImage } from "../../components/stored-image";
import { money } from "../../lib/utils";
import { AddressAutocomplete } from "../../components/address-autocomplete";
import {
  Calendar, Clock, MapPin, MessageSquare, ArrowLeft, CheckCircle2, Star,
} from "lucide-react";

/** Debounce a rapidly-changing value (the address updates on every keystroke). */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function nextSlots() {
  const slots: { label: string; value: string }[] = [];
  const now = new Date();
  for (let d = 0; d < 5; d++) {
    for (const h of [9, 11, 13, 15, 17]) {
      const dt = new Date(now);
      dt.setDate(now.getDate() + d);
      dt.setHours(h, 0, 0, 0);
      if (dt > now)
        slots.push({
          label: dt.toLocaleString("en-US", {
            weekday: "short", month: "short", day: "numeric", hour: "numeric",
          }),
          value: dt.toISOString(),
        });
    }
  }
  return slots;
}

export default function BookPage() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [slot, setSlot] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [done, setDone] = useState<string | null>(null);

  const svc = useQuery({
    queryKey: ["service", id],
    queryFn: async () => (await api.services[":id"].$get({ param: { id } })).json(),
  });

  const basePrice = (svc.data as any)?.service?.basePrice as number | undefined;

  /**
   * Real tax for this address, from the server.
   *
   * This page used to hardcode `basePrice * 0.13` — Ontario HST — for everyone.
   * The invoice is computed from the actual region, so a Calgary customer was
   * quoted 13% and invoiced 5%, and a Montreal customer was quoted 13% and
   * invoiced 14.975% (billed MORE than the total they agreed to). We ask the
   * server, which uses the same region resolution as the invoice, so the two
   * can't drift — and so we don't have to guess the tenant's default region
   * when an address hasn't resolved to a province/state yet.
   *
   * Debounced: the address updates on every keystroke via onResolve.
   */
  const debouncedAddress = useDebounced(address, 400);
  const quote = useQuery({
    queryKey: ["tax-preview", debouncedAddress, basePrice],
    // No address typed yet = nothing to base tax on. Don't ask, and don't show
    // the company-default figure as if it were this customer's tax.
    enabled: basePrice != null && debouncedAddress.trim().length > 0,
    queryFn: async () => {
      const res = await api.pricing["tax-preview"].$post({
        json: { address: debouncedAddress, amount: basePrice as number },
      });
      if (!res.ok) throw new Error("tax preview failed");
      return res.json();
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const res = await api.bookings.$post({
        json: { serviceId: id, scheduledAt: slot, address, notes },
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["bookings"] });
      qc.invalidateQueries({ queryKey: ["notifications"] });
      setDone(data.booking.id);
    },
  });

  if (svc.isLoading) return <FullLoader label="Loading service…" />;
  const service = (svc.data as any)?.service;
  if (!service) return <p>Service not found.</p>;
  const slots = nextSlots();
  const q = quote.data as
    | { taxLabel: string; taxAmount: number; total: number; fromAddress: boolean }
    | undefined;

  if (done) {
    return (
      <div className="mx-auto max-w-md py-10 text-center">
        <div className="mx-auto grid h-20 w-20 place-items-center rounded-full bg-green-100">
          <CheckCircle2 className="h-10 w-10 text-green-600" />
        </div>
        <h1 className="mt-5 text-2xl font-extrabold text-white">Booking confirmed!</h1>
        <p className="mt-2 text-slate-500">
          We've emailed your confirmation. You'll be notified when a pro is assigned.
        </p>
        <div className="mt-6 flex flex-col gap-3">
          <button
            onClick={() => navigate(`/app/track/${done}`)}
            className="rounded-xl bg-brand py-3.5 font-semibold text-white shadow-lg shadow-brand/30 transition hover:bg-brand-deep"
          >
            Track my booking
          </button>
          <button
            onClick={() => navigate("/app")}
            className="rounded-xl border border-white/10 bg-ink-2 py-3.5 font-semibold text-slate-200 transition hover:border-white/20"
          >
            Back to home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/app" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-cyan-glow">
        <ArrowLeft className="h-4 w-4" /> Back
      </Link>

      <div className="grid gap-6 md:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          {/* service header */}
          <div className="overflow-hidden rounded-2xl border border-white/5 nvc-card">
            <StoredImage
              src={service.image}
              alt={service.name}
              className="h-44 w-full object-cover"
              fallback={<div className="h-44 w-full bg-white/5" />}
            />
            <div className="p-5">
              <div className="flex items-center justify-between">
                <h1 className="text-xl font-extrabold text-white">{service.name}</h1>
                <span className="flex items-center gap-0.5 text-sm font-semibold text-amber-500">
                  <Star className="h-4 w-4 fill-amber-400" />{service.rating}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-500">{service.description}</p>
            </div>
          </div>

          {/* date/time */}
          <Section icon={Calendar} title="Choose a time">
            <div className="flex flex-wrap gap-2">
              {slots.map((s) => (
                <button
                  key={s.value}
                  onClick={() => setSlot(s.value)}
                  className={`rounded-xl border-2 px-3.5 py-2 text-sm font-medium transition ${
                    slot === s.value
                      ? "border-brand bg-brand/5 text-cyan-glow"
                      : "border-white/10 bg-ink-3 text-slate-300 hover:border-white/20"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </Section>

          {/* address */}
          <Section icon={MapPin} title="Service address">
            <AddressAutocomplete
              value={address}
              onResolve={({ address }) => setAddress(address)}
              placeholder="123 Main St, Toronto, ON"
              inputClassName="w-full rounded-xl border border-white/10 bg-ink-2 px-4 py-3 outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
          </Section>

          {/* notes */}
          <Section icon={MessageSquare} title="Notes (optional)">
            <textarea aria-label="Gate code, parking, specifics…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Gate code, parking, specifics…"
              rows={3}
              className="w-full resize-none rounded-xl border border-white/10 bg-ink-2 px-4 py-3 outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
          </Section>
        </div>

        {/* summary */}
        <div className="md:sticky md:top-20 md:self-start">
          <div className="rounded-2xl border border-white/5 bg-ink-2 p-5 shadow-sm">
            <h3 className="font-bold text-white">Order summary</h3>
            <div className="mt-4 space-y-2 text-sm">
              <Row label={service.name} value={money(service.basePrice)} />
              {/*
                Never show a guessed tax figure. Until the address resolves to a
                real region we say so, rather than printing a number the invoice
                won't match.
              */}
              {q ? (
                <>
                  <Row
                    label={q.taxLabel || "Tax"}
                    value={money(q.taxAmount)}
                    hint={q.fromAddress ? undefined : "estimated — confirm your address"}
                  />
                  <div className="my-2 border-t border-white/5" />
                  <Row label="Total" value={money(q.total)} bold />
                </>
              ) : (
                <>
                  <Row
                    label="Tax"
                    value={quote.isError ? "—" : "Calculated from your address"}
                    muted
                  />
                  <div className="my-2 border-t border-white/5" />
                  <Row label="Subtotal" value={money(service.basePrice)} bold />
                </>
              )}
            </div>
            {q && !q.fromAddress && address.trim().length > 0 && (
              <p className="mt-2 text-[11px] text-amber-400/90">
                We couldn't identify the province or state in that address, so tax
                is estimated. Pick a suggestion from the address list to confirm it.
              </p>
            )}
            <div className="mt-3 flex items-center gap-1.5 text-xs text-slate-500">
              <Clock className="h-3.5 w-3.5" /> Est. {service.durationMins} min
            </div>
            {create.isError && (
              <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
                Couldn't create booking. Try again.
              </p>
            )}
            <button
              disabled={!slot || !address || create.isPending}
              onClick={() => create.mutate()}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-brand py-3.5 font-semibold text-white shadow-lg shadow-brand/30 transition hover:bg-brand-deep disabled:opacity-50"
            >
              {create.isPending ? <Loader className="h-5 w-5 border-white/40 border-t-white" /> : "Confirm booking"}
            </button>
            <p className="mt-2 text-center text-[11px] text-slate-500">
              You'll pay after the service is completed.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ icon: Icon, title, children }: any) {
  return (
    <div className="rounded-2xl border border-white/5 bg-ink-2 p-5 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-4.5 w-4.5 text-cyan-glow" />
        <h3 className="font-bold text-white">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function Row({
  label, value, bold, muted, hint,
}: {
  label: string; value: string; bold?: boolean; muted?: boolean; hint?: string;
}) {
  return (
    <div className="flex justify-between gap-3">
      <span className={bold ? "font-bold text-white" : "text-slate-500"}>
        {label}
        {hint && <span className="ml-1 text-[11px] text-amber-400/80">({hint})</span>}
      </span>
      <span
        className={
          bold
            ? "text-lg font-extrabold text-cyan-glow"
            : muted
              ? "text-right text-xs text-slate-500"
              : "font-medium text-slate-200"
        }
      >
        {value}
      </span>
    </div>
  );
}
