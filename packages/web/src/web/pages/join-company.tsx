import { useEffect, useState } from "react";
import { useParams, useLocation } from "wouter";
import { Building2, Check, AlertTriangle, LogIn } from "lucide-react";
import { apiHeaders } from "../lib/api";
import { getToken } from "../lib/auth";
import { switchCompany } from "../lib/tenant";

/**
 * "Company X wants to add you to their team."
 *
 * This page is ONLY for people who already have an NVC360 login — a technician
 * being added to a second company's roster. There is deliberately no password
 * field anywhere on it: they accept using the account they already have, which
 * is what stops the inviting company from gaining any control over their
 * existing login.
 *
 * (The separate /join/:token page is the other case: a brand-new technician
 * creating their first account.)
 */
type Invite = { email: string; company: string; companyId: string; role: string };

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  manager: "Manager",
  dispatcher: "Dispatcher",
  project_manager: "Project manager",
  rider: "Technician",
  customer: "Client",
};

export default function JoinCompany() {
  const params = useParams();
  const membershipId = (params as { membershipId?: string }).membershipId ?? "";
  const [, navigate] = useLocation();

  const [invite, setInvite] = useState<Invite | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/me/join-company/${membershipId}`);
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setError(body?.message ?? "This invite is no longer valid.");
        } else {
          setInvite(body.invite as Invite);
        }
      } catch {
        if (!cancelled) setError("Couldn't load this invite. Check your connection and retry.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [membershipId]);

  const signedIn = !!getToken();

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/me/join-company/${membershipId}`, {
        method: "POST",
        headers: { ...apiHeaders(), "Content-Type": "application/json" },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.message ?? "Couldn't accept this invite.");
        setBusy(false);
        return;
      }
      setDone(true);
      // Land them IN the company they just joined rather than wherever they
      // happened to be — switchCompany reloads, so give the success state a
      // beat to render first.
      setTimeout(() => switchCompany(body.companyId), 900);
    } catch {
      setError("Couldn't accept this invite. Check your connection and retry.");
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink p-6">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-ink-2 p-8">
        {loading ? (
          <p className="text-center text-sm text-slate-400">Loading invite…</p>
        ) : error && !invite ? (
          <div className="text-center">
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-amber-500/10 text-amber-400">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <h1 className="font-display text-lg font-bold text-white">Invite unavailable</h1>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">{error}</p>
            <a
              href="/sign-in"
              className="mt-6 inline-block rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-deep"
            >
              Go to sign in
            </a>
          </div>
        ) : done ? (
          <div className="text-center">
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-emerald-500/10 text-emerald-400">
              <Check className="h-6 w-6" />
            </div>
            <h1 className="font-display text-lg font-bold text-white">
              You've joined {invite?.company}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              Taking you there now. You can switch between your companies any time
              from the menu.
            </p>
          </div>
        ) : (
          <>
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-brand/10 text-brand">
              <Building2 className="h-6 w-6" />
            </div>
            <h1 className="text-center font-display text-lg font-bold text-white">
              Join {invite?.company}
            </h1>
            <p className="mt-2 text-center text-sm leading-relaxed text-slate-400">
              <b className="text-slate-200">{invite?.company}</b> would like to add you
              to their team
              {invite?.role ? (
                <>
                  {" "}
                  as a{" "}
                  <b className="text-slate-200">
                    {ROLE_LABEL[invite.role] ?? invite.role}
                  </b>
                </>
              ) : null}
              .
            </p>

            <div className="mt-5 rounded-xl border border-white/10 bg-white/5 p-4">
              <p className="text-xs leading-relaxed text-slate-400">
                You already have an NVC360 account
                {invite?.email ? (
                  <>
                    {" "}
                    (<span className="text-slate-300">{invite.email}</span>)
                  </>
                ) : null}
                , so there's nothing new to set up —{" "}
                <b className="text-slate-300">keep your existing password</b>. Joining
                doesn't give {invite?.company} access to your work at any other company.
              </p>
            </div>

            {error && (
              <p className="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {error}
              </p>
            )}

            {signedIn ? (
              <button
                onClick={accept}
                disabled={busy}
                className="mt-6 w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-deep disabled:opacity-60"
              >
                {busy ? "Joining…" : `Accept & join ${invite?.company ?? ""}`}
              </button>
            ) : (
              <>
                <p className="mt-6 text-center text-sm text-slate-400">
                  Sign in as {invite?.email} to accept.
                </p>
                <button
                  onClick={() =>
                    navigate(`/sign-in?next=${encodeURIComponent(`/join-company/${membershipId}`)}`)
                  }
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-deep"
                >
                  <LogIn className="h-4 w-4" />
                  Sign in to continue
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
