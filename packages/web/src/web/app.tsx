import { lazy, Suspense, Component, type ReactNode } from "react";
import { Route, Switch } from "wouter";
import Index from "./pages/index";
import AuthPage from "./pages/auth";
import { Provider } from "./components/provider";
import { ProtectedRoute } from "./components/protected-route";
import { AgentFeedback } from "@runablehq/website-runtime";

// ─── Global error boundary — catches any component crash, shows a recovery
//     card instead of a blank white screen. ──────────────────────────────────
class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null };
  static getDerivedStateFromError(e: Error) {
    return { error: e };
  }
  componentDidCatch(e: Error, info: { componentStack: string }) {
    // Log to console for Runable devtools visibility
    console.error("[ErrorBoundary]", e, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#070b12",
            padding: "2rem",
          }}
        >
          <div
            style={{
              maxWidth: 480,
              width: "100%",
              background: "#0f1a2e",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 16,
              padding: "2rem",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 36, marginBottom: "0.75rem" }}>⚠️</div>
            <h2
              style={{
                color: "#f8fafc",
                fontWeight: 700,
                fontSize: "1.125rem",
                marginBottom: "0.5rem",
              }}
            >
              Something went wrong
            </h2>
            <p
              style={{
                color: "#64748b",
                fontSize: "0.875rem",
                marginBottom: "1.5rem",
                lineHeight: 1.6,
              }}
            >
              {(this.state.error as Error).message || "An unexpected error occurred."}
            </p>
            <button
              onClick={() => {
                this.setState({ error: null });
                window.location.reload();
              }}
              style={{
                background: "#0ea5e9",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                padding: "0.5rem 1.5rem",
                fontWeight: 600,
                fontSize: "0.875rem",
                cursor: "pointer",
              }}
            >
              Reload page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Route-level code-splitting. The public landing + auth pages stay in the main
// bundle (needed on first paint), while the heavy authenticated apps
// (customer / rider / admin) and rarely-hit public pages load on demand. This
// is the core cold-start win: a first-time visitor no longer downloads the
// entire admin console + maps + charts before the landing page renders.
const ForgotPasswordPage = lazy(() => import("./pages/forgot-password"));
const ResetPasswordPage = lazy(() => import("./pages/reset-password"));
const TrackPublic = lazy(() => import("./pages/track-public"));
const SelectionsPublic = lazy(() => import("./pages/selections-public"));
const IntakeForm = lazy(() => import("./pages/intake-form"));
const JoinTech = lazy(() => import("./pages/join-tech"));
const CustomerApp = lazy(() => import("./pages/customer"));
const RiderApp = lazy(() => import("./pages/rider"));
const AdminApp = lazy(() => import("./pages/admin"));

function NotFound() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#070b12",
        padding: "2rem",
        textAlign: "center",
      }}
    >
      <div>
        <div style={{ fontSize: 48, fontWeight: 800, color: "#0ea5e9", marginBottom: "0.5rem" }}>
          404
        </div>
        <p style={{ color: "#94a3b8", marginBottom: "1.5rem" }}>
          This page doesn't exist or the link is out of date.
        </p>
        <a
          href="/"
          style={{
            background: "#0ea5e9",
            color: "#fff",
            borderRadius: 8,
            padding: "0.5rem 1.5rem",
            fontWeight: 600,
            fontSize: "0.875rem",
            textDecoration: "none",
          }}
        >
          Go home
        </a>
      </div>
    </div>
  );
}

function RouteFallback() {
  return (
    <div
      style={{
        minHeight: "60vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        aria-label="Loading"
        style={{
          width: 28,
          height: 28,
          border: "3px solid rgba(0,0,0,0.12)",
          borderTopColor: "rgba(0,0,0,0.55)",
          borderRadius: "50%",
          animation: "rb-spin 0.7s linear infinite",
        }}
      />
      <style>{"@keyframes rb-spin{to{transform:rotate(360deg)}}"}</style>
    </div>
  );
}

function App() {
  return (
    <ErrorBoundary>
    <Provider>
      <Suspense fallback={<RouteFallback />}>
        <Switch>
          <Route path="/" component={Index} />
          <Route path="/sign-in">{() => <AuthPage mode="sign-in" />}</Route>
          <Route path="/sign-up">{() => <AuthPage mode="sign-up" />}</Route>
          <Route path="/forgot-password" component={ForgotPasswordPage} />
          <Route path="/reset-password" component={ResetPasswordPage} />
          <Route path="/t/:token" component={TrackPublic} />
          <Route path="/s/:token" component={SelectionsPublic} />
          <Route path="/f/:companyId/:slug" component={IntakeForm} />
          <Route path="/join/:token" component={JoinTech} />

          <Route path="/app/*?">
            <ProtectedRoute roles={["customer"]}>
              <CustomerApp />
            </ProtectedRoute>
          </Route>
          <Route path="/rider/*?">
            <ProtectedRoute roles={["rider"]}>
              <RiderApp />
            </ProtectedRoute>
          </Route>
          <Route path="/admin/*?">
            <ProtectedRoute roles={["admin", "superadmin"]}>
              <AdminApp />
            </ProtectedRoute>
          </Route>
          <Route>
            <NotFound />
          </Route>
        </Switch>
      </Suspense>
      {/* Do not remove — off by default, activated by parent iframe via postMessage */}
      {import.meta.env.DEV && <AgentFeedback />}
    </Provider>
    </ErrorBoundary>
  );
}

export default App;
