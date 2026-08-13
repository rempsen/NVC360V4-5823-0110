import { useState } from "react";
import { Link } from "wouter";
import { authClient } from "../lib/auth";
import { Logo } from "../components/brand";
import { Loader } from "../components/loader";
import { Mail, ArrowRight, ArrowLeft, MailCheck } from "lucide-react";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { error } = await authClient.requestPasswordReset({
        email,
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw new Error(error.message);
      setSent(true);
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid min-h-screen bg-ink md:grid-cols-2">
      <div className="nvc-grid-bg relative hidden overflow-hidden bg-ink-2 md:block">
        <div className="absolute -right-20 top-20 h-80 w-80 rounded-full bg-brand/20 blur-3xl" />
        <div className="absolute bottom-0 left-0 h-72 w-72 rounded-full bg-cyan-glow/10 blur-3xl" />
        <div className="relative flex h-full flex-col justify-between p-12 text-white">
          <Logo light />
          <div>
            <h1 className="font-display text-4xl font-extrabold leading-tight">
              Locked out?
              <br /> <span className="text-glow text-cyan-glow">We've got you.</span>
            </h1>
            <p className="mt-4 max-w-sm text-slate-400">
              Enter your email and we'll send a secure link to reset your
              password. The link expires in one hour.
            </p>
          </div>
          <p className="text-xs text-slate-600">
            Trusted by HVAC, plumbing, electrical &amp; facilities teams.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-center px-5 py-10">
        <div className="w-full max-w-md">
          <div className="mb-6 md:hidden">
            <Logo light />
          </div>

          {sent ? (
            <div className="text-center">
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-brand/15 text-cyan-glow">
                <MailCheck className="h-7 w-7" />
              </div>
              <h2 className="mt-5 font-display text-3xl font-extrabold text-white">
                Check your inbox
              </h2>
              <p className="mt-2 text-slate-400">
                If an account exists for <span className="font-semibold text-slate-200">{email}</span>,
                we've sent a password reset link. Don't see it? Check your spam folder.
              </p>
              <Link
                to="/sign-in"
                className="mt-6 inline-flex min-h-[32px] items-center gap-2 px-1 font-semibold text-cyan-glow hover:underline"
              >
                <ArrowLeft className="h-4 w-4" /> Back to sign in
              </Link>
            </div>
          ) : (
            <>
              <h2 className="font-display text-3xl font-extrabold text-white">
                Forgot your password?
              </h2>
              <p className="mt-1 text-slate-400">
                No worries — enter your email and we'll send you a reset link.
              </p>

              <form onSubmit={submit} className="mt-6 space-y-4">
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                  <input aria-label="Email address"
                    type="email"
                    placeholder="Email address"
                    value={email}
                    required
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-xl border border-white/10 bg-ink-2 py-3 pl-11 pr-4 text-white outline-none transition placeholder:text-slate-600 focus:border-brand focus:ring-2 focus:ring-brand/20"
                  />
                </div>

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
                      Send reset link
                      <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </button>
              </form>

              <p className="mt-5 text-center text-sm text-slate-500">
                <Link
                  to="/sign-in"
                  className="inline-flex min-h-[32px] items-center gap-1.5 px-1 font-semibold text-cyan-glow hover:underline"
                >
                  <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
