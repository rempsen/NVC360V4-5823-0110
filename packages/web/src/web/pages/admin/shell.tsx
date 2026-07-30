import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Logo } from "../../components/brand";
import { DispatchMessenger } from "../../components/dispatch-messenger";
import { TenantSwitcher } from "../../components/tenant-switcher";
import { useAuth } from "../../hooks/use-auth";
import { useWorkerNoun, useCustomerNoun, useJobNoun } from "../../lib/use-brand";
import { authClient, clearToken } from "../../lib/auth";
import { cn } from "../../lib/utils";
import {
  LayoutDashboard,
  Map as MapIcon,
  CalendarClock,
  ClipboardList,
  LayoutTemplate,
  Package,
  Layers,
  Users,
  Wrench,
  BarChart3,
  LogOut,
  Settings,
  Map as MapPin,
  Wallet,
  Tags,
  Star,
  BellRing,
  Building2,
  FileText,
  Menu,
  X,
} from "lucide-react";

type NavItem = { to: string; label: string; icon: typeof LayoutDashboard };
type NavGroup = { heading: string; items: NavItem[] };

// Human-readable label for the footer, driven by the signed-in user's role.
const ROLE_LABELS: Record<string, string> = {
  superadmin: "Super Admin",
  admin: "Admin",
  manager: "Manager",
  dispatcher: "Dispatcher",
  rider: "Field Staff",
  customer: "Client",
};
function roleLabel(role?: string): string {
  if (!role) return "—";
  return ROLE_LABELS[role] ?? role.charAt(0).toUpperCase() + role.slice(1);
}

// Grouped IA — collapses 19 flat items into 5 scannable sections.
const NAV_GROUPS: NavGroup[] = [
  {
    heading: "Operations",
    items: [
      { to: "/admin", label: "Dashboard", icon: LayoutDashboard },
      { to: "/admin/fleet", label: "Map", icon: MapIcon },
      { to: "/admin/scheduler", label: "Scheduler", icon: CalendarClock },
      { to: "/admin/work-orders", label: "__JOB_PLURAL__", icon: ClipboardList },
    ],
  },
  {
    heading: "Catalog & Forms",
    items: [
      { to: "/admin/catalog", label: "Catalog", icon: Package },
      { to: "/admin/options", label: "Options & Tiers", icon: Layers },
      { to: "/admin/builder", label: "Form Builder Templates", icon: LayoutTemplate },
      { to: "/admin/intake-forms", label: "Intake Forms", icon: FileText },
    ],
  },
  {
    heading: "People",
    items: [
      { to: "/admin/techs", label: "__WORKER_PLURAL__ & Managers", icon: Wrench },
      // Static label, not the per-industry customerNoun: this page (Directory)
      // lists customers AND staff/admins together, so the customer-specific
      // term was misleading here even though it's correct on pages that only
      // show customers.
      { to: "/admin/clients", label: "People", icon: Users },
      { to: "/admin/reviews", label: "Reviews", icon: Star },
    ],
  },
  {
    heading: "Money",
    items: [
      { to: "/admin/payouts", label: "Payouts", icon: Wallet },
      { to: "/admin/reports", label: "Reports", icon: BarChart3 },
    ],
  },
  {
    heading: "Setup",
    items: [
      { to: "/admin/zones", label: "Service Zones", icon: MapPin },
      { to: "/admin/notifications", label: "Notifications", icon: BellRing },
      { to: "/admin/tags", label: "Tags & Fields", icon: Tags },
      { to: "/admin/settings", label: "Settings", icon: Settings },
    ],
  },
];

export function AdminShell({ children }: { children: React.ReactNode }) {
  const [loc, navigate] = useLocation();
  const { user, role } = useAuth();
  const { nounPlural: workerPlural } = useWorkerNoun();
  const { nounPlural: customerPlural } = useCustomerNoun();
  const { nounPlural: jobPlural } = useJobNoun();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // superadmins get a "Companies" (tenant registry) entry under Operations.
  const groups: NavGroup[] =
    role === "superadmin"
      ? NAV_GROUPS.map((g, i) =>
          i === 0
            ? {
                ...g,
                items: [
                  g.items[0],
                  {
                    to: "/admin/companies",
                    label: "Companies",
                    icon: Building2,
                  },
                  ...g.items.slice(1),
                ],
              }
            : g,
        )
      : NAV_GROUPS;

  // close the mobile drawer whenever the route changes
  useEffect(() => {
    setDrawerOpen(false);
  }, [loc]);

  // lock body scroll while the drawer is open
  useEffect(() => {
    document.body.style.overflow = drawerOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [drawerOpen]);

  async function logout() {
    await authClient.signOut();
    clearToken();
    navigate("/sign-in");
  }

  function NavLinks() {
    return (
      <>
        {groups.map((g) => (
          <div key={g.heading} className="mb-3">
            <p className="px-3 pb-1.5 pt-3 text-[9px] font-bold uppercase tracking-[0.12em] text-slate-600/80">
              {g.heading}
            </p>
            <div className="space-y-px">
              {g.items.map((n) => {
                const active =
                  n.to === "/admin" ? loc === "/admin" : loc.startsWith(n.to);
                return (
                  <Link
                    key={n.to}
                    to={n.to}
                    className={cn(
                      "relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all duration-150",
                      active
                        ? "bg-brand/12 font-semibold text-white"
                        : "font-medium text-slate-500 hover:bg-white/[0.04] hover:text-slate-300",
                    )}
                  >
                    {active && (
                      <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-brand" />
                    )}
                    <n.icon className={cn("h-[17px] w-[17px] shrink-0 transition-colors", active ? "text-brand" : "text-slate-600 group-hover:text-slate-400")} />{" "}
                    {n.label
                      .replace("__WORKER_PLURAL__", workerPlural)
                      .replace("__CUSTOMER_PLURAL__", customerPlural)
                      .replace("__JOB_PLURAL__", jobPlural)}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </>
    );
  }

  function UserFooter() {
    return (
      <div className="border-t border-white/[0.06] p-3">
        <div className="flex items-center gap-2.5 rounded-xl bg-white/[0.03] px-2.5 py-2 ring-1 ring-white/[0.05]">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand/20 text-xs font-bold text-brand">
            {user?.name?.[0]?.toUpperCase() ?? "D"}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-slate-100 leading-tight">
              {user?.name}
            </p>
            <p className="truncate text-[11px] text-slate-500 leading-tight mt-0.5">{roleLabel(role)}</p>
          </div>
          <button
            onClick={logout}
            title="Sign out"
            aria-label="Sign out"
            className="grid h-7 w-7 place-items-center rounded-md text-slate-600 transition-colors hover:bg-red-500/10 hover:text-red-400"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen overflow-x-hidden bg-ink text-slate-200">
      {/* desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[228px] flex-col border-r border-white/[0.06] bg-ink-2 md:flex">
        <div className="flex h-16 items-center border-b border-white/5 px-5">
          <Logo to="/admin" />
        </div>
        <TenantSwitcher />
        <nav className="flex-1 overflow-y-auto p-3">
          <NavLinks />
        </nav>
        <UserFooter />
      </aside>

      {/* mobile top bar with hamburger */}
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-white/5 bg-ink-2 px-4 md:hidden">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
            className="grid h-9 w-9 place-items-center rounded-lg text-slate-300 hover:bg-white/5"
          >
            <Menu className="h-5 w-5" />
          </button>
          <Logo to="/admin" />
        </div>
      </header>

      {/* mobile slide-in drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-white/5 bg-ink-2 shadow-2xl">
            <div className="flex h-16 items-center justify-between gap-2 border-b border-white/5 px-4">
              <Logo to="/admin" />
              <button
                onClick={() => setDrawerOpen(false)}
                aria-label="Close menu"
                className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-white/5"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <TenantSwitcher />
            <nav className="flex-1 overflow-y-auto p-3">
              <NavLinks />
            </nav>
            <UserFooter />
          </div>
        </div>
      )}

      <main className="md:pl-[228px]">{children}</main>

      {/* persistent dispatch messaging — available on every admin screen */}
      <DispatchMessenger />
    </div>
  );
}

/** Shared page header used by dispatcher pages */
export function PageHead({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight text-white">
          {title}
        </h1>
        {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}
