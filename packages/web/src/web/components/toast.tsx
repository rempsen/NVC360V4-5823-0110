import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from "lucide-react";

/**
 * The app's toast system.
 *
 * Before this existed the only failure feedback in the admin platform was a
 * native `alert()` (12 call sites) and, for ~130 mutations, nothing at all.
 * Toasts are the delivery mechanism for the global mutation-error handler in
 * lib/query-client.ts, so a rejected write is now always visible.
 *
 * Deliberate choices:
 * - Errors DO NOT auto-dismiss. A dispatcher who looks away must still find out
 *   the save failed; a 4-second error toast is barely better than none.
 * - `key` de-dupes bursts. Invalidating a list can fire several failing
 *   mutations at once; showing the same message six times is noise.
 * - `role="status"` + `aria-live` so screen readers announce it.
 */

export type ToastKind = "success" | "error" | "warning" | "info";

export type Toast = {
  id: number;
  kind: ToastKind;
  message: string;
  /** Optional detail line, e.g. a request id for support. */
  detail?: string;
  /** De-dupe identity. Repeat pushes with the same key refresh, not stack. */
  key?: string;
};

type ToastInput = Omit<Toast, "id">;

type ToastApi = {
  push: (t: ToastInput) => void;
  success: (message: string, detail?: string) => void;
  error: (message: string, detail?: string) => void;
  warning: (message: string, detail?: string) => void;
  info: (message: string, detail?: string) => void;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

/** Auto-dismiss delay per kind. `null` = sticky until dismissed. */
const TTL: Record<ToastKind, number | null> = {
  success: 3500,
  info: 4500,
  warning: 7000,
  error: null,
};

/**
 * Module-level bridge so non-React code (the react-query global error handler)
 * can raise a toast. Set by ToastProvider on mount.
 */
let externalPush: ((t: ToastInput) => void) | null = null;

/** Raise a toast from outside the React tree. No-op before mount. */
export function toast(t: ToastInput) {
  if (externalPush) externalPush(t);
  else console.warn("[toast] dropped (provider not mounted):", t.message);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
    const h = timers.current.get(id);
    if (h) {
      clearTimeout(h);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (input: ToastInput) => {
      setItems((prev) => {
        // De-dupe: same key (or same kind+message) already showing → refresh it.
        const identity = input.key ?? `${input.kind}:${input.message}`;
        const existing = prev.find((t) => (t.key ?? `${t.kind}:${t.message}`) === identity);
        if (existing) return prev;

        const id = ++seq.current;
        const ttl = TTL[input.kind];
        if (ttl != null) {
          timers.current.set(
            id,
            setTimeout(() => dismiss(id), ttl),
          );
        }
        // Cap the stack so a storm of failures can't cover the screen.
        return [...prev, { ...input, id }].slice(-4);
      });
    },
    [dismiss],
  );

  useEffect(() => {
    externalPush = push;
    return () => {
      externalPush = null;
    };
  }, [push]);

  // Clear pending timers on unmount.
  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      timers.current.clear();
    },
    [],
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      dismiss,
      success: (message, detail) => push({ kind: "success", message, detail }),
      error: (message, detail) => push({ kind: "error", message, detail }),
      warning: (message, detail) => push({ kind: "warning", message, detail }),
      info: (message, detail) => push({ kind: "info", message, detail }),
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport items={items} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

const STYLES: Record<
  ToastKind,
  { icon: typeof CheckCircle2; ring: string; iconColor: string }
> = {
  success: {
    icon: CheckCircle2,
    ring: "border-emerald-500/30 bg-emerald-500/[0.07]",
    iconColor: "text-emerald-400",
  },
  error: {
    icon: XCircle,
    ring: "border-red-500/35 bg-red-500/[0.08]",
    iconColor: "text-red-400",
  },
  warning: {
    icon: AlertTriangle,
    ring: "border-amber-500/30 bg-amber-500/[0.07]",
    iconColor: "text-amber-400",
  },
  info: {
    icon: Info,
    ring: "border-sky-500/30 bg-sky-500/[0.07]",
    iconColor: "text-sky-400",
  },
};

function ToastViewport({
  items,
  onDismiss,
}: {
  items: Toast[];
  onDismiss: (id: number) => void;
}) {
  if (!items.length) return null;
  return (
    <div
      // z-index sits above the modal layer (z-[1050], see components/modal.tsx)
      // so a failed save inside a dialog is still visible.
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[1200] flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-4 sm:items-end"
      role="status"
      aria-live="polite"
      aria-atomic="false"
    >
      {items.map((t) => {
        const s = STYLES[t.kind];
        const Icon = s.icon;
        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border px-3.5 py-3 shadow-2xl backdrop-blur-md ${s.ring}`}
            style={{ background: "rgba(14,20,32,0.92)" }}
          >
            <Icon className={`mt-0.5 h-4.5 w-4.5 shrink-0 ${s.iconColor}`} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold leading-snug text-slate-100">
                {t.message}
              </p>
              {t.detail && (
                <p className="mt-0.5 break-words text-[11px] leading-snug text-slate-400">
                  {t.detail}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              aria-label="Dismiss notification"
              className="-mr-1 shrink-0 rounded-md p-1 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
