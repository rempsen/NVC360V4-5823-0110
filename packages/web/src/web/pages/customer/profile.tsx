import { useAuth } from "../../hooks/use-auth";
import { authClient, clearToken } from "../../lib/auth";
import { useLocation } from "wouter";
import { Mail, Phone, Shield, LogOut, User as UserIcon } from "lucide-react";
import { useState } from "react";

export default function ProfilePage() {
  const { user, role } = useAuth();
  const [, navigate] = useLocation();
  const [signingOut, setSigningOut] = useState(false);

  /**
   * Sign out locally no matter what the server says.
   *
   * This used to be `await authClient.signOut()` followed by clearToken(): if
   * that call failed — offline, expired session, 500 — the throw skipped the
   * token clear AND the redirect, so tapping Sign out on a shared or public
   * machine appeared to do nothing and left the session live on the device.
   */
  async function logout() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await authClient.signOut();
    } catch {
      // Best-effort server revoke; the local session is cleared regardless.
    } finally {
      clearToken();
      navigate("/sign-in");
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-5">
      <h1 className="text-2xl font-extrabold text-white">Profile</h1>
      <div className="rounded-2xl border border-white/5 bg-ink-2 p-6 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-brand to-brand-deep text-2xl font-bold text-white">
            {user?.name?.[0]?.toUpperCase() ?? "U"}
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">{user?.name}</h2>
            <span className="inline-flex items-center gap-1 rounded-full bg-brand/15 px-2.5 py-0.5 text-xs font-semibold capitalize text-cyan-glow">
              <Shield className="h-3 w-3" /> {role}
            </span>
          </div>
        </div>
        <div className="mt-6 space-y-3">
          {/* Email and phone are verbatim values — CSS capitalize was rendering
              the customer's own address back at them as "Dan@nvc360.com". */}
          <Item icon={Mail} label="Email" value={user?.email ?? ""} />
          <Item icon={Phone} label="Phone" value={user?.phone || "Not set"} />
          <Item icon={UserIcon} label="Account type" value={role} capitalize />
        </div>
      </div>
      <button
        onClick={logout}
        disabled={signingOut}
        className="flex w-full items-center justify-center gap-2 rounded-2xl border border-red-500/20 bg-ink-2 py-3.5 font-semibold text-red-400 transition hover:bg-red-500/10 disabled:opacity-60"
      >
        <LogOut className="h-5 w-5" /> {signingOut ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}

function Item({
  icon: Icon,
  label,
  value,
  capitalize,
}: { icon: any; label: string; value: string; capitalize?: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-ink px-4 py-3">
      <Icon className="h-5 w-5 text-slate-500" />
      <div>
        <div className="text-xs text-slate-500">{label}</div>
        <div className={`font-medium text-slate-100 ${capitalize ? "capitalize" : "break-all"}`}>
          {value}
        </div>
      </div>
    </div>
  );
}
