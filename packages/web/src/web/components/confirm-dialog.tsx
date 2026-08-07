import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { ConfirmModal } from "./modal";

/**
 * Promise-based confirmation, so destructive actions can stop using the browser's
 * native `confirm()`.
 *
 * There were 12 native `confirm()` / `alert()` calls left in the admin console —
 * archiving a work order, deleting a service, regenerating a calendar link. Three
 * problems with the native ones:
 * - They look nothing like the app, which makes a serious destructive prompt read
 *   as a browser glitch, and they're the classic "site says" phishing shape.
 * - They're synchronous and block the whole page, and some embedded/webview
 *   contexts suppress them outright — the click then just silently does nothing.
 * - They can't say anything richer than one line of plain text: no danger styling,
 *   no pending state while the delete is in flight.
 *
 * The app already has `<ConfirmModal>`, but wiring it up means adding state and a
 * pending-target ref at every call site. This provider keeps the ergonomics of
 * `confirm()`:
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: "Archive this work order?" }))) return;
 */

type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  /** Red confirm button. Default true — nearly every use here is destructive. */
  danger?: boolean;
};

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((o) => {
    return new Promise<boolean>((resolve) => {
      // A second prompt while one is open: resolve the first as cancelled rather
      // than leaving its promise dangling forever.
      resolver.current?.(false);
      resolver.current = resolve;
      setOpts(o);
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setOpts(null);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmModal
        open={!!opts}
        title={opts?.title ?? ""}
        message={opts?.message ?? ""}
        confirmLabel={opts?.confirmLabel ?? "Delete"}
        danger={opts?.danger ?? true}
        onClose={() => settle(false)}
        onConfirm={() => settle(true)}
      />
    </ConfirmContext.Provider>
  );
}

/**
 * Returns an async confirm. Falls back to the native `confirm()` if used outside
 * the provider so a stray call site can never silently auto-approve a delete.
 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  return (
    ctx ??
    (async (o) => {
      console.warn("[useConfirm] no ConfirmProvider mounted — falling back to native confirm");
      return window.confirm(o.message ? `${o.title}\n\n${o.message}` : o.title);
    })
  );
}
