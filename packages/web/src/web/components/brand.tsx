import { Link } from "wouter";
import { cn } from "../lib/utils";
import { STATUS_META } from "../lib/utils";

export function Logo({
  className,
  to = "/",
  light = true,
  showText = true,
}: {
  className?: string;
  to?: string;
  light?: boolean;
  showText?: boolean;
}) {
  return (
    <Link to={to} className={cn("inline-flex items-center gap-2.5 py-1 lg:py-0", className)}>
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand to-brand-deep shadow-lg shadow-brand/30">
        <img
          src="/nvc-logo-white.png"
          alt="NVC360"
          className="h-7 w-7 object-contain"
        />
      </span>
      {showText && (
        <span
          className={cn(
            "font-display text-xl font-extrabold tracking-tight",
            light ? "text-white" : "text-slate-900",
          )}
        >
          NVC<span className="text-brand">360</span>
        </span>
      )}
    </Link>
  );
}

/** Standard padded content wrapper for dispatcher console pages */
export function PageWrap({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 pb-24 md:px-8">{children}</div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const m = STATUS_META[status] ?? {
    label: status,
    color: "#475569",
    bg: "#f1f5f9",
  };
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
      style={{ color: m.color, background: m.bg }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: m.color }}
      />
      {m.label}
    </span>
  );
}
