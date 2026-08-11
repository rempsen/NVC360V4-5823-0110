import { useState } from "react";
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
  const tax = +(service.basePrice * 0.13).toFixed(2);
  const total = +(service.basePrice + tax).toFixed(2);

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
              <Row label="Tax (13%)" value={money(tax)} />
              <div className="my-2 border-t border-white/5" />
              <Row label="Total" value={money(total)} bold />
            </div>
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

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className={bold ? "font-bold text-white" : "text-slate-500"}>{label}</span>
      <span className={bold ? "text-lg font-extrabold text-cyan-glow" : "font-medium text-slate-200"}>{value}</span>
    </div>
  );
}
