import { useDialog } from "../hooks/use-dialog";

/**
 * Drop-in accessible panel for the dialogs that aren't built on <Modal>.
 *
 * About a dozen surfaces in this app (the assign-technician sheet, the service
 * and catalog editors, the payment sheet, the email template library, the
 * technician/client side drawers) render their own `fixed inset-0` overlay.
 * They all shared the same three defects: no `role="dialog"`, keyboard focus
 * free to Tab out into the page behind the overlay, and an Escape key that only
 * worked if you happened to have focused the backdrop first.
 *
 * Rather than rewrite each layout onto <Modal>, swap the panel's plain `<div>`
 * for this: identical markup and classes, plus the full dialog behaviour from
 * useDialog. Because it only mounts while the dialog is open, `open` is always
 * true here and the caller doesn't have to hoist a hook.
 */
export function DialogPanel({
  onClose,
  label,
  className,
  children,
  lockScroll = true,
  ...rest
}: {
  /** Escape / dismiss handler. */
  onClose: () => void;
  /** Accessible name announced when the dialog opens. */
  label: string;
  className?: string;
  children: React.ReactNode;
  lockScroll?: boolean;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "className" | "children">) {
  const { panelRef, dialogProps } = useDialog({ open: true, onClose, autoLabel: false, lockScroll });
  return (
    <div
      ref={panelRef}
      {...dialogProps}
      aria-label={label}
      className={`outline-none ${className ?? ""}`}
      {...rest}
    >
      {children}
    </div>
  );
}
