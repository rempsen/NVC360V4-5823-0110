import { useEffect, useId, useRef } from "react";

/**
 * Accessible-dialog behaviour, in one hook.
 *
 * The shared <Modal> is only about half the dialogs in this app — the work
 * order editor, the payment sheet, the email editor's confirms, the rider's
 * job sheet and a dozen admin drawers are all hand-rolled `fixed inset-0`
 * overlays. Rewriting them all onto <Modal> would be a risky refactor of very
 * different layouts, so instead they get the same behaviour by spreading this
 * hook's props onto their existing panel element.
 *
 * What it provides:
 * - `role="dialog"` + `aria-modal="true"` + a wired-up `aria-labelledby`
 * - focus moved into the panel on open, restored to the opener on close
 * - Tab / Shift+Tab trapped inside the panel
 * - Escape closes — but only the TOPMOST dialog, so a confirm stacked on a
 *   modal doesn't tear down both
 * - background scroll locked while open
 *
 * Usage:
 *   const { panelRef, dialogProps, titleId } = useDialog({ open, onClose });
 *   <div {...dialogProps} ref={panelRef}>
 *     <h2 id={titleId}>Edit work order</h2>
 *   </div>
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDialog({
  open,
  onClose,
  /** Set false for a panel that labels itself with aria-label instead. */
  autoLabel = true,
  /** Set false to keep the page scrollable behind (e.g. a toast-like sheet). */
  lockScroll = true,
}: {
  open: boolean;
  onClose: () => void;
  autoLabel?: boolean;
  lockScroll?: boolean;
}) {
  // Deliberately loose: callers attach this to whatever element wraps their
  // panel (div, section, form), and the hook only ever reads DOM methods.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const panelRef = useRef<any>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // onClose is nearly always an inline arrow at the call site, so it changes
  // identity every render. Keeping it in a ref means the effect below depends
  // only on `open` — otherwise the effect would re-run on every keystroke and
  // yank focus back to the first field mid-typing.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus({ preventScroll: true });

    const isTopmost = () => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      return !dialogs.length || dialogs[dialogs.length - 1] === panel;
    };

    const onKey = (e: KeyboardEvent) => {
      if (!isTopmost()) return;
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel) return;

      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (!items.length) {
        e.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (e.shiftKey && (active === firstEl || !panel.contains(active))) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && (active === lastEl || !panel.contains(active))) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    window.addEventListener("keydown", onKey, true);
    const prevOverflow = document.body.style.overflow;
    if (lockScroll) document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (lockScroll) document.body.style.overflow = prevOverflow;
      const active = document.activeElement;
      if (!active || active === document.body) {
        restoreRef.current?.focus({ preventScroll: true });
      }
    };
  }, [open, lockScroll]);

  return {
    panelRef,
    titleId,
    dialogProps: {
      role: "dialog" as const,
      "aria-modal": true as const,
      "aria-labelledby": autoLabel ? titleId : undefined,
      tabIndex: -1,
    },
  };
}
