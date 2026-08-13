import type { LucideIcon } from "lucide-react";

/**
 * Shared empty state for the console.
 *
 * Every list in the app used to hit zero rows and render one line of grey text
 * in the middle of a large blank panel. That reads as a page that failed to
 * load, not as a page with nothing in it -- the difference matters most in the
 * operations modules, where "no work orders" is a normal, good state at 7am and
 * a worrying one at 2pm.
 *
 * So the shape is always: an icon in a soft plate (gives the void a centre of
 * gravity), a short title in near-white (tells you WHAT is empty), one line of
 * muted copy (tells you WHY, or what to do), and an optional action.
 *
 * Deliberately not a card: it is always rendered inside one.
 */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  tone = "neutral",
  compact = false,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  action?: React.ReactNode;
  /** "good" for states that are a success (all caught up), not a lack of data. */
  tone?: "neutral" | "good";
  compact?: boolean;
}) {
  const plate =
    tone === "good"
      ? "bg-emerald-500/10 text-emerald-400 ring-emerald-500/20"
      : "bg-white/[0.04] text-slate-500 ring-white/[0.06]";
  return (
    <div
      className={`flex flex-col items-center justify-center px-6 text-center ${
        compact ? "py-8" : "py-14"
      }`}
    >
      <div
        className={`grid place-items-center rounded-full ring-1 ${plate} ${
          compact ? "h-9 w-9" : "h-12 w-12"
        }`}
      >
        <Icon className={compact ? "h-4 w-4" : "h-5 w-5"} aria-hidden="true" />
      </div>
      <p
        className={`font-semibold text-slate-200 ${
          compact ? "mt-2.5 text-[13px]" : "mt-3.5 text-sm"
        }`}
      >
        {title}
      </p>
      {hint && (
        <p className="mt-1 max-w-[42ch] text-xs leading-relaxed text-slate-500">
          {hint}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
