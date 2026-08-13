import { Link } from "wouter";
import { Logo } from "../components/brand";
import { useAuth } from "../hooks/use-auth";
import {
  MapPin,
  MessageSquare,
  Workflow,
  ArrowRight,
  Truck,
  Zap,
  CheckCircle2,
  Radio,
  Bot,
  Plug,
  Clock,
  ShieldCheck,
  Phone,
  TrendingDown,
  Building2,
} from "lucide-react";

function Nav() {
  const { isAuthed, role } = useAuth();
  const home =
    role === "admin" ? "/admin" : role === "rider" ? "/rider" : "/app";
  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-white/5 bg-ink/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
        <Logo />
        <nav className="hidden items-center gap-8 text-sm font-medium text-slate-400 md:flex">
          <a href="#features" className="hover:text-brand">Platform</a>
          <a href="#how" className="hover:text-brand">How it works</a>
          <a href="#industries" className="hover:text-brand">Industries</a>
          <a href="#pricing" className="hover:text-brand">Pricing</a>
          <a href="#integrations" className="hover:text-brand">Integrations</a>
        </nav>
        <div className="flex items-center gap-3">
          {isAuthed ? (
            <Link
              to={home}
              className="rounded-full bg-brand px-5 py-2 text-sm font-semibold text-ink shadow-lg shadow-brand/30 transition hover:bg-cyan-glow"
            >
              Dashboard
            </Link>
          ) : (
            <>
              <Link to="/sign-in" className="inline-flex min-h-[32px] items-center px-1 text-sm font-medium text-slate-300 hover:text-brand">
                Sign in
              </Link>
              <Link
                to="/sign-up"
                className="rounded-full bg-brand px-5 py-2 text-sm font-semibold text-ink shadow-lg shadow-brand/30 transition hover:bg-cyan-glow"
              >
                Request Demo
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

export default function Index() {
  return (
    <div className="min-h-screen bg-ink text-slate-200">
      <Nav />

      {/* Hero */}
      <section className="relative overflow-hidden pt-16 nvc-grid-bg">
        <div className="absolute -right-40 top-10 -z-10 h-96 w-96 rounded-full bg-brand/15 blur-3xl" />
        <div className="absolute -left-40 top-60 -z-10 h-96 w-96 rounded-full bg-cyan-glow/10 blur-3xl" />
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-5 py-16 pb-24 md:grid-cols-2 md:py-24 md:pb-32">
          <div>
            <span className="animate-fade-up inline-flex items-center gap-2 rounded-full border border-brand/30 bg-brand/10 px-3 py-1 text-xs font-semibold text-brand">
              <Radio className="h-3.5 w-3.5" /> NVC360 4.0 — Launching 2026
            </span>
            <h1 className="animate-fade-up delay-1 mt-5 font-display text-5xl font-black leading-[1.04] text-white md:text-6xl">
              Make your clients{" "}
              <span className="bg-gradient-to-r from-brand to-cyan-glow bg-clip-text text-transparent text-glow">
                love you.
              </span>
            </h1>
            <p className="animate-fade-up delay-2 mt-5 max-w-md text-lg text-slate-400">
              Live tech tracking. Automatic ETAs. Zero "where is my tech?" calls.
              NVC360 turns every service call into a 5-star experience — and cuts
              20% off your field labor while it's at it.
            </p>
            <div className="animate-fade-up delay-3 mt-8 flex flex-wrap gap-3">
              <Link
                to="/sign-up"
                className="inline-flex items-center gap-2 rounded-full bg-brand px-7 py-3.5 font-semibold text-ink shadow-xl shadow-brand/40 transition hover:bg-cyan-glow"
              >
                Get Started <ArrowRight className="h-4 w-4" />
              </Link>
              <a
                href="#features"
                className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-7 py-3.5 font-semibold text-slate-200 transition hover:border-brand hover:text-brand"
              >
                See how it works
              </a>
            </div>
            <div className="animate-fade-up delay-4 mt-10 flex items-center divide-x divide-white/10">
              {[
                ["20%", "Lower labor cost"],
                ["800+", "Techs operated"],
                ["1B", "Hrs wasted / yr"],
              ].map(([n, l], i) => (
                <div key={l} className={i === 0 ? "pr-8" : "px-8"}>
                  <div className="text-3xl font-black tracking-tight text-white">{n}</div>
                  <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wider text-slate-500">{l}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Live dispatch mock card over real lifestyle photo */}
          <div className="animate-fade-up delay-2 relative">
            <div className="relative overflow-hidden rounded-[28px] border border-white/10 shadow-2xl shadow-black/40">
              <img
                src="/img/nvc-doorstep.jpg"
                alt="Technician greeting a happy customer at their door with the NVC360 app"
                className="h-[360px] w-full object-cover md:h-[440px]"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-ink via-ink/30 to-transparent" />
            </div>
            <div className="nvc-glass nvc-glow absolute -bottom-6 -left-4 right-8 rounded-[24px] p-1 backdrop-blur-xl md:-left-10">
              <div className="rounded-[20px] bg-ink-2/95 p-4">
                <div className="flex items-center justify-between border-b border-white/5 pb-3">
                  <span className="text-xs font-bold tracking-wider text-slate-400">
                    NVC360 DISPATCH — LIVE
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-live/15 px-2 py-0.5 text-[11px] font-bold text-emerald-live">
                    <span className="relative h-1.5 w-1.5"><span className="live-ping absolute inset-0 rounded-full" /><span className="absolute inset-0 rounded-full bg-emerald-live" /></span>
                    8 TECHS ACTIVE
                  </span>
                </div>
                <div className="mt-3 space-y-2">
                  {[
                    { n: "Marcus L.", s: "En Route · ETA 8m", c: "#0ea5e9" },
                    { n: "Aisha K.", s: "On Site · HVAC", c: "#10b981" },
                  ].map((t) => (
                    <div key={t.n} className="flex items-center gap-3 rounded-xl bg-white/[0.03] px-3 py-2">
                      <span className="grid h-8 w-8 place-items-center rounded-full text-[11px] font-bold text-ink" style={{ background: t.c }}>{t.n.split(" ").map(x=>x[0]).join("")}</span>
                      <div className="flex-1">
                        <div className="text-sm font-semibold text-white">{t.n}</div>
                        <div className="text-[11px] text-slate-400">{t.s}</div>
                      </div>
                      <MessageSquare className="h-4 w-4 text-slate-500" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Problem stat band */}
      <section className="border-y border-white/5 bg-ink-2 py-10">
        <div className="mx-auto max-w-6xl px-5">
          <div className="flex flex-wrap items-center justify-center divide-x divide-white/5">
            {[
              [TrendingDown, "20% reduction", "in labor costs"],
              [Phone, "Zero calls", "'where is my tech?'"],
              [Clock, "End the 4-hour", "window. Forever."],
            ].map(([Icon, top, sub]: any, i) => (
              <div key={i} className={`flex items-center gap-3 ${i === 0 ? "pr-12" : "px-12"} py-2`}>
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand/[0.08] text-brand ring-1 ring-brand/20">
                  <Icon className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-sm font-bold text-white">{top}</div>
                  <div className="text-xs text-slate-500">{sub}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Product showcase — device lineup */}
      <section className="relative overflow-hidden pb-8 pt-16">
        <div className="absolute left-1/2 top-1/2 -z-10 h-[420px] w-[820px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand/10 blur-3xl" />
        <div className="mx-auto max-w-6xl px-5 text-center">
          <span className="inline-flex items-center rounded-full border border-brand/25 bg-brand/[0.08] px-3 py-1 text-[11px] font-bold uppercase tracking-widest text-brand">See it in action</span>
          <h2 className="mt-2 font-display text-4xl font-black text-white">Uberize your business</h2>
          <p className="mx-auto mt-3 max-w-xl text-slate-400">
            One connected system across dispatch desk, technician phone, and client device —
            schedule, track, and communicate in real time.
          </p>
          <img
            src="/img/nvc-devices.png"
            alt="NVC360 running across desktop dispatch, technician mobile, and client tracking views"
            className="mx-auto mt-10 w-full max-w-5xl drop-shadow-[0_30px_60px_rgba(0,0,0,0.5)]"
          />
        </div>
      </section>

      {/* Features */}
      <section id="features" className="mx-auto max-w-6xl px-5 py-20">
        <div className="mb-12 text-center">
          <span className="inline-flex items-center rounded-full border border-brand/25 bg-brand/[0.08] px-3 py-1 text-[11px] font-bold uppercase tracking-widest text-brand">Platform</span>
          <h2 className="mt-4 font-display text-4xl font-black text-white tracking-tight">
            One platform for real-time field service
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-slate-400 leading-relaxed">
            Unify dispatchers, technicians, and clients into one real-time system —
            no new hardware, no system replacement.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            { icon: MapPin, t: "Live Fleet Tracking", d: "See every tech color-coded by class & availability. Reassign on the fly — no phone calls." },
            { icon: MessageSquare, t: "Client Experience", d: "Auto SMS + email the moment a tech departs. Live ETA link + two-way messaging." },
            { icon: Workflow, t: "Drag-and-Drop Scheduling", d: "Build custom work orders & tasks, then drag to schedule and assign the right tech." },
            { icon: Bot, t: "AI Route & Auto-Rules", d: "AI optimizes routes and fires automation rules to run leaner and serve faster." },
            { icon: Plug, t: "Deep Integrations", d: "QuickBooks, Xero, Gmail, Google Calendar, Microsoft 365, Outlook & CompanyCam." },
            { icon: Building2, t: "Robust Admin Backend", d: "Users, billing, settings & full CSV exports in every configuration you need." },
          ].map((f) => (
            <div key={f.t} className="group relative rounded-2xl border border-white/[0.06] bg-ink-2 p-6 transition-all duration-200 hover:-translate-y-1 hover:border-brand/25 hover:bg-ink-3 hover:shadow-xl hover:shadow-brand/5">
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-brand/10 text-brand ring-1 ring-brand/15 transition-all duration-200 group-hover:bg-brand/15 group-hover:ring-brand/25">
                <f.icon className="h-[18px] w-[18px]" />
              </div>
              <h3 className="mt-5 font-semibold text-white">{f.t}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{f.d}</p>
              <div className="absolute bottom-4 right-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                <ArrowRight className="h-4 w-4 text-brand/50" />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="bg-ink-2 py-20">
        <div className="mx-auto max-w-6xl px-5">
          <div className="mb-14 grid items-center gap-10 md:grid-cols-2">
            <div className="relative">
              <div className="overflow-hidden rounded-[28px] border border-white/10 shadow-2xl shadow-black/40">
                <img
                  src="/img/nvc-app-hand.jpg"
                  alt="Customer following their job live in the NVC360 app from home"
                  className="h-[320px] w-full object-cover md:h-[400px]"
                />
              </div>
              <div className="absolute -bottom-5 -right-3 hidden w-40 overflow-hidden rounded-2xl border border-white/10 shadow-xl sm:block">
                <img src="/img/nvc-eta-sms.jpg" alt="Client receiving a live ETA notification" className="h-full w-full object-cover" />
              </div>
            </div>
            <div>
              <span className="inline-flex items-center rounded-full border border-brand/25 bg-brand/[0.08] px-3 py-1 text-[11px] font-bold uppercase tracking-widest text-brand">The client journey</span>
              <h2 className="mt-2 font-display text-4xl font-black text-white">Dispatch smarter in seconds</h2>
              <p className="mt-4 max-w-md text-slate-400">
                From the moment a job is created to the moment it's closed, every step is tracked,
                timed, and shared — so your clients always know exactly what's happening.
              </p>
            </div>
          </div>
          <div className="grid gap-6 md:grid-cols-4">
            {[
              { icon: Workflow, t: "Create & Assign", d: "Build a custom job, attach notes & photos, assign the closest qualified tech." },
              { icon: MapPin, t: "Track & Communicate", d: "Live GPS, automated ETAs, and in-app messaging keep everyone aligned." },
              { icon: CheckCircle2, t: "Details at Hand", d: "Scope, checklists, site notes & client info in one organized mobile view." },
              { icon: Zap, t: "Document & Close", d: "Log time & travel, capture photos, collect approvals, close jobs digitally." },
            ].map((s, i) => (
              <div key={i} className="relative rounded-2xl border border-white/5 bg-ink p-6 transition duration-200 hover:border-brand/20 hover:bg-ink-2">
                <div className="absolute -top-4 left-6 grid h-9 w-9 place-items-center rounded-xl bg-brand font-black text-ink ring-4 ring-brand/20 text-sm">{i + 1}</div>
                <s.icon className="mt-4 h-7 w-7 text-brand" />
                <h3 className="mt-3 font-bold text-white">{s.t}</h3>
                <p className="mt-2 text-sm text-slate-400">{s.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Industries */}
      <section id="industries" className="mx-auto max-w-6xl px-5 py-20">
        <div className="mb-12 text-center">
          <span className="inline-flex items-center rounded-full border border-brand/25 bg-brand/[0.08] px-3 py-1 text-[11px] font-bold uppercase tracking-widest text-brand">Industries</span>
          <h2 className="mt-2 font-display text-4xl font-black text-white">If you run a mobile workforce, NVC360 works for you</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            ["Home Services", "Professional ETA notifications build trust and 5-star reviews.", "/img/nvc-doorbell.jpg"],
            ["Delivery & Logistics", "Real-time route tracking and automated delivery notifications.", "/img/nvc-van.jpg"],
            ["Utility & Telecom", "Dispatch field crews and track every cable & line repair live.", "/img/nvc-cable-tech.jpg"],
            ["HVAC & Plumbing", "Schedule techs, send live ETAs, close more calls per day.", null],
            ["Construction & Subcontracting", "Manage large crews across multiple sites with live visibility.", null],
            ["Property Management", "Coordinate maintenance crews & vendors from one dashboard.", null],
          ].map(([t, d, img]) => (
            <div key={t as string} className="group overflow-hidden rounded-2xl border border-white/5 bg-ink-2 transition hover:-translate-y-1 hover:border-brand/30">
              {img ? (
                <div className="relative h-40 overflow-hidden">
                  <img src={img as string} alt={t as string} className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
                  <div className="absolute inset-0 bg-gradient-to-t from-ink-2 via-ink-2/20 to-transparent" />
                </div>
              ) : null}
              <div className="p-5">
                {!img && <Truck className="h-6 w-6 text-brand" />}
                <h3 className={`font-bold text-white ${img ? "" : "mt-3"}`}>{t}</h3>
                <p className="mt-1 text-sm text-slate-400">{d}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Integrations */}
      <section id="integrations" className="border-y border-white/5 bg-ink-2 py-16">
        <div className="mx-auto max-w-6xl px-5 text-center">
          <span className="inline-flex items-center rounded-full border border-brand/25 bg-brand/[0.08] px-3 py-1 text-[11px] font-bold uppercase tracking-widest text-brand">Integrations</span>
          <h2 className="mt-2 font-display text-3xl font-black text-white">Keep the systems you trust</h2>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            {[
              { name: "QuickBooks", logo: "quickbooks" },
              { name: "Xero", logo: "xero" },
              { name: "Gmail", logo: "gmail" },
              { name: "Google Calendar", logo: "google-calendar" },
              { name: "Microsoft 365", logo: "microsoft-365" },
              { name: "Outlook", logo: "outlook" },
              { name: "CompanyCam", logo: "companycam" },
            ].map((it) => (
              <div key={it.name} className="flex w-36 flex-col items-center gap-3 rounded-2xl border border-white/10 bg-ink px-4 py-5">
                <span className="flex h-14 w-14 items-center justify-center rounded-xl bg-white/95 p-2">
                  <img src={`/img/integrations/${it.logo}.png`} alt={it.name} className="max-h-full max-w-full object-contain" />
                </span>
                <span className="text-center text-sm font-semibold text-slate-300">{it.name}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="mx-auto max-w-6xl px-5 py-20">
        <div className="text-center">
          <span className="inline-flex items-center rounded-full border border-brand/25 bg-brand/[0.08] px-3 py-1 text-[11px] font-bold uppercase tracking-widest text-brand">Pricing</span>
          <h2 className="mt-2 font-display text-3xl font-black text-white sm:text-4xl">Simple, per-vehicle pricing</h2>
          <p className="mx-auto mt-3 max-w-xl text-slate-400">
            One license per vehicle. The more drivers you run, the lower your per-license rate — automatically.
          </p>
        </div>

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {[
            {
              name: "Starter",
              range: "1–14 drivers",
              price: "30",
              cents: "00",
              tagline: "For growing fleets getting started.",
              integrations: "Basic integrations",
              integrationsNote: "",
              featured: false,
            },
            {
              name: "Growth",
              range: "15–49 drivers",
              price: "27",
              cents: "50",
              tagline: "Best value for scaling operations.",
              integrations: "All integrations included",
              integrationsNote: "",
              featured: true,
            },
            {
              name: "Enterprise",
              range: "50+ drivers",
              price: "25",
              cents: "00",
              tagline: "Lowest rate for large fleets.",
              integrations: "All integrations",
              integrationsNote:
                "Additional custom integrations for a fee (talk to your account manager for more details).",
              featured: false,
            },
          ].map((tier) => (
            <div
              key={tier.name}
              className={`relative flex flex-col rounded-3xl border p-8 transition ${
                tier.featured
                  ? "border-brand/60 bg-gradient-to-b from-brand/8 to-ink-2 shadow-[0_0_0_1px_rgba(14,165,233,0.3),0_24px_60px_-12px_rgba(14,165,233,0.25)] md:-translate-y-4"
                  : "border-white/[0.07] bg-ink-2 hover:border-brand/25 hover:bg-ink-3 transition-all duration-200"
              }`}
            >
              {tier.featured && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-brand px-4 py-1 text-xs font-bold uppercase tracking-wide text-ink shadow-lg shadow-brand/40">
                  Most popular
                </span>
              )}
              <div className="inline-flex items-center rounded-full border border-brand/25 bg-brand/[0.08] px-3 py-1 text-[11px] font-bold uppercase tracking-widest text-brand">{tier.name}</div>
              <div className="mt-1 text-lg font-semibold text-white">{tier.range}</div>
              <div className="mt-6 flex items-end gap-1">
                <span className="text-2xl font-bold text-slate-400">$</span>
                <span className="font-display text-6xl font-black leading-none text-white">{tier.price}</span>
                <span className="mb-1 text-2xl font-black text-white">.{tier.cents}</span>
              </div>
              <div className="mt-1 text-sm text-slate-400">per month, per license</div>
              <p className="mt-5 text-sm text-slate-400">{tier.tagline}</p>
              <ul className="mt-6 space-y-3 text-sm text-slate-300">
                <li className="flex items-start gap-2.5">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none text-brand" /> One license per vehicle
                </li>
                <li className="flex items-start gap-2.5">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none text-brand" /> Live tracking &amp; dispatch
                </li>
                <li className="flex items-start gap-2.5">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none text-brand" /> Client &amp; technician notifications
                </li>
                <li className="flex flex-col gap-1">
                  <span className="flex items-start gap-2.5">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none text-brand" /> {tier.integrations}
                  </span>
                  {tier.integrationsNote && (
                    <span className="pl-[26px] text-xs italic text-slate-500">{tier.integrationsNote}</span>
                  )}
                </li>
              </ul>
              <Link
                to="/sign-up"
                className={`mt-8 inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 font-semibold transition ${
                  tier.featured
                    ? "bg-brand text-ink shadow-lg shadow-brand/40 hover:bg-cyan-glow"
                    : "border border-white/15 bg-white/5 text-slate-200 hover:border-brand"
                }`}
              >
                Get started <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          ))}
        </div>
        <p className="mt-8 text-center text-xs text-slate-500">
          All prices in USD per vehicle/month. Volume rate applies automatically as your fleet grows.
        </p>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-5 py-20">
        <div className="relative grid items-center gap-8 overflow-hidden rounded-[28px] border border-brand/20 bg-gradient-to-br from-ink-2 to-ink shadow-2xl nvc-grid-bg md:grid-cols-2">
          <div className="absolute -right-20 -top-20 h-64 w-64 rounded-full bg-brand/20 blur-2xl" />
          <div className="px-8 py-14 text-center md:text-left">
            <h2 className="font-display text-4xl font-black text-white">Become a founding client.</h2>
            <p className="mt-3 max-w-md text-slate-400 md:mx-0 mx-auto">Reduce field costs by 20%. Eliminate the 4-hour window. Make your clients love you.</p>
            <div className="mt-8 flex flex-wrap justify-center gap-3 md:justify-start">
              <Link to="/sign-up" className="inline-flex items-center gap-2 rounded-full bg-brand px-8 py-3.5 font-semibold text-ink shadow-xl shadow-brand/40 transition hover:bg-cyan-glow">
                Request Demo <ArrowRight className="h-4 w-4" />
              </Link>
              <Link to="/sign-in" className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-8 py-3.5 font-semibold text-slate-200 transition hover:border-brand">
                Sign in
              </Link>
            </div>
            <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-slate-500 md:justify-start">
              <ShieldCheck className="h-3.5 w-3.5" /> Built by operators who ran 800+ field technicians
            </p>
          </div>
          <div className="relative hidden h-full min-h-[360px] md:block">
            <img src="/img/nvc-exec.jpg" alt="Business owner checking live operations on NVC360" className="absolute inset-0 h-full w-full object-cover object-top" />
            <div className="absolute inset-0 bg-gradient-to-r from-ink-2 via-transparent to-transparent" />
          </div>
        </div>
      </section>

      <footer className="border-t border-white/5 py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 md:flex-row">
          <Logo />
          <p className="text-sm text-slate-500">© 2026 NVC360 · Winnipeg, MB · Field Service Management.</p>
        </div>
      </footer>
    </div>
  );
}
