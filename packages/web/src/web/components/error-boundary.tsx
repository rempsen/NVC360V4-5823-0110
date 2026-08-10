import { Component, type ReactNode } from "react";
import { useLocation } from "wouter";
import { AlertTriangle, RotateCw } from "lucide-react";
import { reportError } from "../lib/sentry";

/**
 * Scoped error boundaries.
 *
 * The app had exactly one boundary, at the very root of <App>. That is better
 * than a white screen, but it means a render crash inside (say) the scheduler's
 * week grid tears down the entire console — nav, sidebar and all — and the only
 * way back is a full reload.
 *
 * `RouteErrorBoundary` catches the crash at the route level instead: the shell
 * survives, the user can click another page, and "Try again" re-mounts just the
 * broken subtree. It also resets automatically when the URL changes, so
 * navigating away from a broken page genuinely fixes it.
 *
 * Every catch reports to Sentry (a no-op when no DSN is configured) with the
 * boundary name and component stack, which is what turns "a customer says it
 * crashed" into an actionable stack trace.
 */

type Props = {
  children: ReactNode;
  /** Shows up in the Sentry tag — e.g. "admin", "rider", "customer". */
  name: string;
  /** Reset key: when this changes, the boundary clears itself. */
  resetKey?: string;
  /** Render full-viewport (root boundary) instead of inline (route boundary). */
  fullScreen?: boolean;
};

type State = { error: Error | null; resetKey?: string };

class Boundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  /**
   * Navigating away from a crashed page should clear the crash. Derived during
   * render rather than in componentDidUpdate + setState, which would render the
   * crash screen once more before clearing it (and trip react/no-did-update-set-state).
   */
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey === state.resetKey) return null;
    return state.error
      ? { error: null, resetKey: props.resetKey }
      : { resetKey: props.resetKey };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    reportError(error, {
      boundary: this.props.name,
      componentStack: info.componentStack ?? undefined,
      path: typeof window !== "undefined" ? window.location.pathname : undefined,
    });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const wrap = this.props.fullScreen
      ? "min-h-screen bg-ink"
      : "min-h-[60vh]";

    return (
      <div className={`flex items-center justify-center p-8 ${wrap}`}>
        <div className="w-full max-w-md rounded-2xl border border-white/10 bg-ink-2 p-8 text-center">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-red-500/10 text-red-400">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <h2 className="font-display text-lg font-bold text-white">
            This page hit a problem
          </h2>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-slate-400">
            {error.message || "An unexpected error occurred."}
          </p>
          <p className="mt-2 text-xs text-slate-600">
            The rest of the app is still working — you can switch pages or try again.
          </p>
          <div className="mt-6 flex items-center justify-center gap-2">
            <button
              onClick={() => this.setState({ error: null })}
              className="flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-deep"
            >
              <RotateCw className="h-4 w-4" />
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="rounded-lg border border-white/10 px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-white/5"
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}

/** Route-level boundary: auto-resets on navigation, keeps the app shell alive. */
export function RouteErrorBoundary({
  name,
  children,
}: {
  name: string;
  children: ReactNode;
}) {
  const [location] = useLocation();
  return (
    <Boundary name={name} resetKey={location}>
      {children}
    </Boundary>
  );
}

/** Root boundary: last line of defence, renders full-viewport. */
export function RootErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <Boundary name="root" fullScreen>
      {children}
    </Boundary>
  );
}
