import { Link } from "wouter";
import { StoredImage } from "../../components/stored-image";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useAuth } from "../../hooks/use-auth";
import { StatusBadge } from "../../components/brand";
import { money } from "../../lib/utils";
import { fmtAppointment } from "../../../shared/fmt-appointment";
import { useBrand } from "../../lib/use-brand";
import {
  Sparkles, Wrench, Zap, Scissors, Bug, HeartPulse, Truck, Siren,
  Moon, Hammer, LifeBuoy, Star, Clock, ArrowRight, MapPin, Search,
} from "lucide-react";
import { useState } from "react";
import { isOpenStatus } from "../../../shared/job-status";

const ICON: Record<string, any> = {
  sparkles: Sparkles, wrench: Wrench, zap: Zap, scissors: Scissors, bug: Bug,
  "heart-pulse": HeartPulse, truck: Truck, siren: Siren, moon: Moon,
  hammer: Hammer, "life-buoy": LifeBuoy, "washing-machine": Wrench,
};

export default function CustomerHome() {
  const { user } = useAuth();
  // Appointment times render on the COMPANY's clock, not the device's.
  const brand = useBrand();
  const [q, setQ] = useState("");
  const services = useQuery({
    queryKey: ["services"],
    queryFn: async () => (await api.services.$get()).json(),
  });
  const bookings = useQuery({
    queryKey: ["bookings"],
    queryFn: async () => (await api.bookings.$get()).json(),
  });

  // "onsite" and "paused" are real statuses, and this hand-written list left them
  // out — so the Active booking banner vanished the moment the tech clocked in
  // at the door, which is when the customer looks at it most. Vocabulary is
  // shared now: see shared/job-status.ts.
  const active = bookings.data?.bookings.find((b) => isOpenStatus(b.status));

  const filtered = (services.data?.services ?? []).filter(
    (s) =>
      s.name.toLowerCase().includes(q.toLowerCase()) ||
      s.category.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <div className="space-y-6">
      <div className="animate-fade-up">
        <h1 className="text-2xl font-extrabold text-white">
          Hi {user?.name?.split(" ")[0]} 👋
        </h1>
        <p className="text-slate-500">What can we help with today?</p>
      </div>

      {/* active booking banner */}
      {active && (
        <Link to={`/app/track/${active.id}`}>
          <div className="animate-fade-up flex items-center justify-between rounded-2xl bg-gradient-to-r from-brand to-brand-deep p-5 text-white shadow-lg shadow-brand/20">
            <div className="flex items-center gap-4">
              <div className="relative grid h-12 w-12 place-items-center rounded-xl bg-ink-2/15">
                <span className="live-ping absolute inset-0 rounded-xl opacity-30" />
                <MapPin className="relative h-6 w-6" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-white/80">Active booking</span>
                  <StatusBadge status={active.status} />
                </div>
                <div className="text-lg font-bold">{active.service?.name}</div>
                <div className="text-sm text-white/70">{fmtAppointment(active.scheduledAt, brand.timezone)}</div>
              </div>
            </div>
            <ArrowRight className="h-6 w-6" />
          </div>
        </Link>
      )}

      {/* search */}
      <div className="relative animate-fade-up delay-1">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-500" />
        <input aria-label="Search services…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search services…"
          className="w-full rounded-2xl border border-white/10 bg-ink-2 py-3.5 pl-12 pr-4 text-white outline-none transition placeholder:text-slate-500 focus:border-brand focus:ring-2 focus:ring-brand/20"
        />
      </div>

      {/* services grid */}
      <div>
        <h2 className="mb-3 text-lg font-bold text-white">Browse services</h2>
        {services.isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-56 animate-pulse rounded-2xl bg-ink-2/5" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 bg-ink-2 py-14 text-center">
            <Search className="mx-auto h-8 w-8 text-slate-600" />
            <p className="mt-3 font-semibold text-slate-300">
              {q ? `No services match "${q}"` : "No services available yet"}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              {q ? "Try a different word, or clear the search." : "Please check back shortly."}
            </p>
            {q && (
              <button
                onClick={() => setQ("")}
                className="mt-4 rounded-full border border-white/10 bg-ink px-5 py-2 text-sm font-semibold text-slate-200 hover:border-white/20"
              >
                Clear search
              </button>
            )}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((s) => {
              const Icon = ICON[s.icon] ?? Wrench;
              return (
                <Link key={s.id} to={`/app/book/${s.id}`}>
                  <div className="group h-full overflow-hidden rounded-2xl border border-white/5 nvc-card transition hover:-translate-y-1 hover:shadow-lg">
                    <div className="relative h-32 overflow-hidden">
                      <StoredImage
                        src={s.image}
                        alt={s.name}
                        className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
                        fallback={<div className="h-full w-full bg-white/5" />}
                      />
                      <div className="absolute left-3 top-3 grid h-9 w-9 place-items-center rounded-lg bg-ink-2/90 text-cyan-glow backdrop-blur">
                        <Icon className="h-4.5 w-4.5" />
                      </div>
                    </div>
                    <div className="p-4">
                      <div className="flex items-start justify-between">
                        <h3 className="font-bold text-white">{s.name}</h3>
                        <span className="flex items-center gap-0.5 text-xs font-semibold text-amber-500">
                          <Star className="h-3 w-3 fill-amber-400" />{s.rating}
                        </span>
                      </div>
                      <div className="mt-3 flex items-center justify-between">
                        <span className="font-extrabold text-cyan-glow">{money(s.basePrice)}</span>
                        <span className="flex items-center gap-1 text-xs text-slate-500">
                          <Clock className="h-3 w-3" />{s.durationMins}m
                        </span>
                      </div>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
