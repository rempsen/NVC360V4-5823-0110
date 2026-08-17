/**
 * "Choose a time" — one day at a time.
 *
 * Both places a customer picks an appointment (the booking page and the
 * reschedule modal) render this. Before, the booking page laid every slot out
 * flat: up to 25 buttons reading "Mon, Aug 18, 9 AM", "Mon, Aug 18, 11 AM"…
 * where the only thing that mattered — the day — was buried mid-label. People
 * pick the right time on the wrong day, and then a truck shows up on the wrong
 * day.
 *
 * So: pick a day, then pick a time. The day row is the only place a date is
 * written, and the times underneath are just times, which is how anyone actually
 * thinks about booking an appointment.
 *
 * Day selection is *derived*, never blindly stored (see resolveSelectedDay):
 * slots expire while the page is open, so the day the customer was looking at
 * can disappear underneath them. And a slot they already picked always wins over
 * the tab, so the picker can never show a different day than their appointment.
 */
import { useMemo, useState } from "react";
import { groupSlotsByDay, resolveSelectedDay, type Slot } from "../../shared/slot-days";
import { cn } from "../lib/utils";

export function SlotPicker({
  slots,
  timezone,
  value,
  onChange,
  className,
}: {
  slots: Slot[];
  timezone: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const days = useMemo(() => groupSlotsByDay(slots, timezone), [slots, timezone]);
  const [dayKey, setDayKey] = useState("");
  const activeKey = resolveSelectedDay(days, dayKey, value);
  const active = days.find((d) => d.key === activeKey);

  if (days.length === 0)
    return (
      <p className={cn("text-sm text-slate-400", className)}>
        No open times in the next few days — give us a call and we'll fit you in.
      </p>
    );

  return (
    <div className={className}>
      {/* Day row. Scrolls sideways on a phone instead of wrapping into a block
          of chips that looks like the wall this replaced. */}
      <div
        role="tablist"
        aria-label="Choose a day"
        className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {days.map((d) => {
          const on = d.key === activeKey;
          return (
            <button
              key={d.key}
              type="button"
              role="tab"
              aria-selected={on}
              // The visible text is "Tue 18"; on its own that is thin for a
              // screen reader, so the full date goes on the label.
              aria-label={d.relative ? `${d.relative}, ${d.label}` : d.label}
              onClick={() => setDayKey(d.key)}
              className={cn(
                "min-h-[62px] shrink-0 rounded-xl border px-3.5 py-2 text-center transition",
                on
                  ? "border-brand bg-brand/15 text-white"
                  : "border-white/10 bg-ink-3 text-slate-300 hover:border-white/20",
              )}
            >
              <span className="block text-[11px] font-semibold uppercase tracking-wide opacity-70">
                {d.relative || d.weekday}
              </span>
              <span className="block text-lg font-extrabold leading-tight">{d.dayNum}</span>
            </button>
          );
        })}
      </div>

      {active && (
        <>
          <p className="mt-3 text-xs font-bold uppercase tracking-wide text-slate-500">
            {active.label}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {active.times.map((t) => (
              <button
                key={t.value}
                type="button"
                aria-pressed={value === t.value}
                onClick={() => onChange(t.value)}
                className={cn(
                  // 44px tall: a thumb target, not a mouse target.
                  "min-h-[44px] rounded-xl border-2 px-4 text-sm font-semibold transition",
                  value === t.value
                    ? "border-brand bg-brand/10 text-cyan-glow"
                    : "border-white/10 bg-ink-3 text-slate-300 hover:border-white/20",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
