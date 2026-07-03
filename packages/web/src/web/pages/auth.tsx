import { useState } from "react";
import { Link } from "wouter";
import { authClient, captureToken } from "../lib/auth";
import { Logo } from "../components/brand";
import { Loader } from "../components/loader";
import {
  User,
  Wrench,
  Mail,
  Lock,
  Phone,
  ArrowRight,
  Radar,
  Route as RouteIcon,
  Bot,
} from "lucide-react";

type Role = "customer" | "rider" | "admin" | "superadmin";

// Public sign-up is client-only. Technicians join via admin invite (/join/:token).


function dest(role: Role) {
  return role === "admin" || role === "superadmin" ? "/admin" : role === "rider" ? "/rider" : "/app";
}

export default function AuthPage({ mode }: { mode: "sign-in" | "sign-up" }) {
  const isSignUp = mode === "sign-up";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [role] = useState<Role>("customer");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (isSignUp) {
        const { error } = await authClient.signUp.email(
          { name, email, password, role, phone } as any,
          {
            onSuccess: (ctx) => {
              captureToken(ctx);
              // navigate AFTER token is written to localStorage
              window.location.assign(dest(role));
            },
          },
        );
        if (error) throw new Error(error.message);
      } else {
        // IMPORTANT: read the signed-in user from `ctx.data` (the onSuccess
        // callback's own argument), NOT from the outer `const { data }`
        // destructured below. better-auth invokes onSuccess as part of this
        // same call, before the outer `const` assignment finishes — closing
        // over the outer `data` here throws a TDZ ReferenceError in
        // production ("Cannot access '<minified data>' before
        // initialization"), because `data` is still uninitialized when
        // onSuccess runs.
        const { error } = await authClient.signIn.email(
          { email, password },
          {
            onSuccess: (ctx) => {
              captureToken(ctx);
              const r = ((ctx.data?.user as any)?.role ?? "customer") as Role;
              window.location.assign(dest(r));
            },
          },
        );
        if (error) throw new Error(error.message);
      }
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid min-h-screen bg-ink md:grid-cols-2">
      {/* left visual */}
      <div className="nvc-grid-bg relative hidden overflow-hidden bg-ink-2 md:block">
        <div className="absolute -right-20 top-20 h-80 w-80 rounded-full bg-brand/20 blur-3xl" />
        <div className="absolute bottom-0 left-0 h-72 w-72 rounded-full bg-cyan-glow/10 blur-3xl" />
        <div className="relative flex h-full flex-col justify-between p-12 text-white">
          <Logo light />
          <div>
            <h1 className="font-display text-4xl font-extrabold leading-tight">
              The command center for
              <br /> <span className="text-glow text-cyan-glow">field service.</span>
            </h1>
            <p className="mt-4 max-w-sm text-slate-400">
              Dispatch smarter, track every technician live, and keep clients in
              the loop — end to end.
            </p>
            <div className="mt-8 space-y-3">
              {[
                { t: "Live fleet tracking & GPS", i: Radar },
                { t: "AI smart dispatch & routing", i: Bot },
                { t: "Automated client notifications", i: RouteIcon },
              ].map((x) => (
                <div key={x.t} className="flex items-center gap-3">
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand/15 text-cyan-glow">
                    <x.i className="h-4 w-4" />
                  </span>
                  <span className="text-slate-200">{x.t}</span>
                </div>
              ))}
            </div>
          </div>
          <p className="text-xs text-slate-600">
            Trusted by HVAC, plumbing, electrical & facilities teams.
          </p>
        </div>
      </div>

      {/* form */}
      <div className="flex items-center justify-center px-5 py-10">
        <div className="w-full max-w-md">
          <div className="mb-6 md:hidden">
            <Logo light />
          </div>
          <h2 className="font-display text-3xl font-extrabold text-white">
            {isSignUp ? "Create your account" : "Welcome back"}
          </h2>
          <p className="mt-1 text-slate-400">
            {isSignUp
              ? "Get your team online in under a minute."
              : "Sign in to your console."}
          </p>

          {isSignUp && (
            <div className="mt-6 flex items-start gap-3 rounded-xl border border-white/10 bg-ink-2 p-3.5">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand/15 text-cyan-glow">
                <Wrench className="h-4 w-4" />
              </div>
              <p className="text-xs text-slate-400">
                Are you a technician? Field staff join by <span className="font-semibold text-slate-200">invitation only</span>. Ask your dispatch office to send your invite link.
              </p>
            </div>
          )}

          <form onSubmit={submit} className="mt-5 space-y-4">
            {isSignUp && (
              <Field icon={User} placeholder="Full name" value={name} onChange={setName} required />
            )}
            <Field icon={Mail} type="email" placeholder="Email address" value={email} onChange={setEmail} required />
            {isSignUp && (
              <Field icon={Phone} type="tel" placeholder="Phone number" value={phone} onChange={setPhone} />
            )}
            <Field icon={Lock} type="password" placeholder="Password" value={password} onChange={setPassword} required />

            {!isSignUp && (
              <div className="flex justify-end -mt-1">
                <Link
                  to="/forgot-password"
                  className="text-sm font-medium text-slate-400 transition hover:text-cyan-glow"
                >
                  Forgot password?
                </Link>
              </div>
            )}

            {error && (
              <div className="rounded-lg bg-red-500/10 px-4 py-3 text-sm font-medium text-red-400">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand py-3.5 font-semibold text-white shadow-lg shadow-brand/30 transition hover:bg-brand-deep disabled:opacity-60"
            >
              {loading ? (
                <Loader className="h-5 w-5 border-white/40 border-t-white" />
              ) : (
                <>
                  {isSignUp ? "Create account" : "Sign in"}
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
          </form>

          <p className="mt-5 text-center text-sm text-slate-500">
            {isSignUp ? "Already have an account? " : "New to NVC360? "}
            <Link
              to={isSignUp ? "/sign-in" : "/sign-up"}
              className="font-semibold text-cyan-glow hover:underline"
            >
              {isSignUp ? "Sign in" : "Create one"}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

function Field({
  icon: Icon,
  type = "text",
  placeholder,
  value,
  onChange,
  required,
}: {
  icon: any;
  type?: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}) {
  return (
    <div className="relative">
      <Icon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
      <input aria-label={placeholder}
        type={type}
        placeholder={placeholder}
        value={value}
        required={required}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-white/10 bg-ink-2 py-3 pl-11 pr-4 text-white outline-none transition placeholder:text-slate-600 focus:border-brand focus:ring-2 focus:ring-brand/20"
      />
    </div>
  );
}
