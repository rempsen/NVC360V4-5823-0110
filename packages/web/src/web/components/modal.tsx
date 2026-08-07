import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useDialog } from "../hooks/use-dialog";

/**
 * The app's modal.
 *
 * Accessibility (added in the platform review pass — the dialog previously had
 * none of it) lives in `hooks/use-dialog.ts` so the dozen hand-rolled overlays
 * elsewhere in the app can get identical behaviour: role/aria-modal/labelling,
 * focus into the dialog on open and back to the opener on close, a Tab trap,
 * topmost-only Escape, and a scroll lock.
 *
 * The backdrop is a plain div, not a <button>. A full-screen button is
 * announced as a control and lands in the tab order ahead of the real ones;
 * Escape and the header X are the accessible ways to dismiss.
 */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const { panelRef, dialogProps, titleId } = useDialog({ open, onClose });

  if (!open) return null;
  const maxW =
    size === "sm" ? "max-w-sm" : size === "lg" ? "max-w-2xl" : "max-w-lg";

  return createPortal(
    // z-[1050]: must sit above slide-in side drawers (z-[1000] — Directory's
    // ClientDrawer, Technicians & Managers' detail panel) so opening a work
    // order (or any Modal) from within one of those drawers doesn't render
    // invisibly behind it. Still below the nested modal-over-modal pattern
    // used elsewhere (z-[9999], e.g. a confirm dialog on top of a modal).
    <div className="fixed inset-0 z-[1050] flex items-end justify-center sm:items-center">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        {...dialogProps}
        className={`relative z-10 flex max-h-[92vh] w-full ${maxW} flex-col overflow-hidden rounded-t-2xl border border-white/10 bg-ink-2 shadow-2xl outline-none sm:rounded-2xl`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/5 px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="font-display text-lg font-bold text-white">
              {title}
            </h2>
            {subtitle && (
              <p className="mt-0.5 text-sm text-slate-400">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-white/5 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-white/5 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-600">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "w-full rounded-lg border border-white/10 bg-ink-3/60 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-brand focus:outline-none";

export function BtnPrimary({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className="flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-deep disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function BtnGhost({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className="rounded-lg border border-white/10 px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-white/5"
    >
      {children}
    </button>
  );
}

/** Lightweight confirm dialog */
export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "Delete",
  danger = true,
  pending = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  pending?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <BtnGhost onClick={onClose}>Cancel</BtnGhost>
          <button
            onClick={onConfirm}
            disabled={pending}
            className={`rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 ${
              danger ? "bg-red-500 hover:bg-red-600" : "bg-brand hover:bg-brand-deep"
            }`}
          >
            {pending ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-sm text-slate-300">{message}</p>
    </Modal>
  );
}
