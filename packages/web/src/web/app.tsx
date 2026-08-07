import { lazy, Suspense } from "react";
import { Route, Switch } from "wouter";
import Index from "./pages/index";
import AuthPage from "./pages/auth";
import { Provider } from "./components/provider";
import { ProtectedRoute } from "./components/protected-route";
import { AgentFeedback } from "@runablehq/website-runtime";
import { RootErrorBoundary, RouteErrorBoundary } from "./components/error-boundary";

// The global + per-route error boundaries now live in components/error-boundary.tsx.
// The old inline class here caught crashes but reported them nowhere and tore
// down the whole app; RouteErrorBoundary keeps the shell alive and reports to
// Sentry.

// Route-level code-splitting. The public landing + auth pages stay in the main
// bundle (needed on first paint), while the heavy authenticated apps
// (customer / rider / admin) and rarely-hit public pages load on demand. This
// is the core cold-start win: a first-time visitor no longer downloads the
// entire admin console + maps + charts before the landing page renders.
const ForgotPasswordPage = lazy(() => import("./pages/forgot-password"));
const ResetPasswordPage = lazy(() => import("./pages/reset-password"));
const TrackPublic = lazy(() => import("./pages/track-public"));
const SelectionsPublic = lazy(() => import("./pages/selections-public"));
const PropertyPublic = lazy(() => import("./pages/property-public"));
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
    <RootErrorBoundary>
    <Provider>
      <Suspense fallback={<RouteFallback />}>
        <RouteErrorBoundary name="public">
        <Switch>
          <Route path="/" component={Index} />
          <Route path="/sign-in">{() => <AuthPage mode="sign-in" />}</Route>
          <Route path="/sign-up">{() => <AuthPage mode="sign-up" />}</Route>
          <Route path="/forgot-password" component={ForgotPasswordPage} />
          <Route path="/reset-password" component={ResetPasswordPage} />
          <Route path="/t/:token" component={TrackPublic} />
          <Route path="/s/:token" component={SelectionsPublic} />
          {/* Persistent, no-login property service history hub */}
          <Route path="/p/:token" component={PropertyPublic} />
          <Route path="/f/:companyId/:slug" component={IntakeForm} />
          <Route path="/join/:token" component={JoinTech} />

          <Route path="/app/*?">
            <ProtectedRoute roles={["customer"]}>
              <RouteErrorBoundary name="customer">
                <CustomerApp />
              </RouteErrorBoundary>
            </ProtectedRoute>
          </Route>
          <Route path="/rider/*?">
            <ProtectedRoute roles={["rider"]}>
              <RouteErrorBoundary name="rider">
                <RiderApp />
              </RouteErrorBoundary>
            </ProtectedRoute>
          </Route>
          <Route path="/admin/*?">
            <ProtectedRoute roles={["admin", "superadmin"]}>
              <RouteErrorBoundary name="admin">
                <AdminApp />
              </RouteErrorBoundary>
            </ProtectedRoute>
          </Route>
          <Route>
            <NotFound />
          </Route>
        </Switch>
        </RouteErrorBoundary>
      </Suspense>
      {/* Do not remove — off by default, activated by parent iframe via postMessage */}
      {import.meta.env.DEV && <AgentFeedback />}
    </Provider>
    </RootErrorBoundary>
  );
}

export default App;
