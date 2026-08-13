import { Link } from "wouter";
import { StoredImage } from "../../components/stored-image";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { StatusBadge } from "../../components/brand";
import { FullLoader } from "../../components/loader";
import { money } from "../../lib/utils";
import { fmtAppointment } from "../../../shared/fmt-appointment";
import { useBrand } from "../../lib/use-brand";
import { ArrowRight, Calendar, MapPin, PackageOpen } from "lucide-react";

export default function CustomerBookings() {
  // Appointment times render on the COMPANY's clock, not the device's.
  const brand = useBrand();
  const bookings = useQuery({
    queryKey: ["bookings"],
    queryFn: async () => (await api.bookings.$get()).json(),
  });

  if (bookings.isLoading) return <FullLoader label="Loading bookings…" />;
  const list = bookings.data?.bookings ?? [];

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-extrabold text-white">My bookings</h1>

      {list.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 bg-ink-2 py-16 text-center">
          <PackageOpen className="mx-auto h-10 w-10 text-slate-600" />
          <p className="mt-3 font-semibold text-slate-600">No bookings yet</p>
          <Link to="/app" className="mt-4 inline-block rounded-full bg-brand px-6 py-2.5 text-sm font-semibold text-white">
            Book a service
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {list.map((b) => (
            <Link key={b.id} to={`/app/track/${b.id}`}>
              <div className="group flex items-center gap-4 rounded-2xl border border-white/5 bg-ink-2 p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
                {b.service?.image && (
                  <StoredImage src={b.service.image} className="h-16 w-16 rounded-xl object-cover" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate font-bold text-white">{b.service?.name}</h3>
                    <StatusBadge status={b.status} />
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                    <span className="flex items-center gap-1"><Calendar className="h-3.5 w-3.5" />{fmtAppointment(b.scheduledAt, brand.timezone)}</span>
                    <span className="flex items-center gap-1 truncate"><MapPin className="h-3.5 w-3.5" />{b.address}</span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-extrabold text-cyan-glow">{money(b.price)}</div>
                  <span className={`text-[11px] font-semibold ${b.paymentStatus === "paid" ? "text-green-600" : "text-amber-600"}`}>
                    {b.paymentStatus === "paid" ? "Paid" : "Unpaid"}
                  </span>
                </div>
                <ArrowRight className="h-5 w-5 text-slate-600 transition group-hover:text-cyan-glow" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
