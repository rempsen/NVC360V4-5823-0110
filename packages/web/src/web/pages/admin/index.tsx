import { lazy, Suspense } from "react";
import { Route, Switch } from "wouter";
import { AdminShell } from "./shell";

// Admin sub-pages are lazy-loaded so opening the dashboard doesn't also pull in
// the scheduler, reports (charts), zones (maps), catalog, etc. Each page splits
// into its own chunk and loads only when its route is visited.
const AdminDashboard = lazy(() => import("./dashboard"));
const FleetPage = lazy(() => import("./fleet"));
const SchedulerPage = lazy(() => import("./scheduler"));
const WorkOrdersPage = lazy(() => import("./bookings"));
const BuilderPage = lazy(() => import("./builder"));
const TechsPage = lazy(() => import("./riders"));
const ClientsPage = lazy(() => import("./users"));
const AutomationPage = lazy(() => import("./automation"));
const MaintenancePage = lazy(() => import("./maintenance"));
const InboxPage = lazy(() => import("./inbox"));
const IntegrationsPage = lazy(() => import("./integrations"));
const ReportsPage = lazy(() => import("./reports"));
const SettingsPage = lazy(() => import("./settings"));
const TagsPage = lazy(() => import("./tags"));
const PayoutsPage = lazy(() => import("./payouts"));
const AuditPage = lazy(() => import("./audit"));
const ZonesPage = lazy(() => import("./zones"));
const ServicesPage = lazy(() => import("./services"));
const CatalogPage = lazy(() => import("./catalog"));
const OptionsCatalogPage = lazy(() => import("./options-catalog"));
const ReviewsPage = lazy(() => import("./reviews"));
const NotificationsPage = lazy(() => import("./notifications"));
const ApiAccessPage = lazy(() => import("./api-access"));
const IntakeFormsPage = lazy(() => import("./intake-forms"));
const CompaniesPage = lazy(() => import("./companies"));
const JobReportPage = lazy(() => import("./job-report"));

function AdminNotFound() {
  return (
    <div style={{ padding: "4rem 2rem", textAlign: "center", color: "#94a3b8" }}>
      <div style={{ fontSize: 40, fontWeight: 800, color: "#0ea5e9", marginBottom: "0.5rem" }}>
        404
      </div>
      <p style={{ marginBottom: "1rem" }}>This admin page doesn't exist or the link is out of date.</p>
      <a href="/admin" style={{ color: "#0ea5e9", fontWeight: 600, textDecoration: "none" }}>
        ← Back to Dashboard
      </a>
    </div>
  );
}

function PageFallback() {
  return (
    <div style={{ padding: 32, display: "flex", justifyContent: "center" }}>
      <div
        aria-label="Loading"
        style={{
          width: 24,
          height: 24,
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

export default function AdminApp() {
  return (
    <AdminShell>
      <Suspense fallback={<PageFallback />}>
        <Switch>
          <Route path="/admin" component={AdminDashboard} />
          <Route path="/admin/fleet" component={FleetPage} />
          <Route path="/admin/scheduler" component={SchedulerPage} />
          <Route path="/admin/work-orders" component={WorkOrdersPage} />
          <Route path="/admin/jobs/:id/report" component={JobReportPage} />
          <Route path="/admin/builder" component={BuilderPage} />
          <Route path="/admin/techs" component={TechsPage} />
          <Route path="/admin/clients" component={ClientsPage} />
          <Route path="/admin/automation" component={AutomationPage} />
          <Route path="/admin/maintenance" component={MaintenancePage} />
          <Route path="/admin/inbox" component={InboxPage} />
          <Route path="/admin/integrations" component={IntegrationsPage} />
          <Route path="/admin/api-access" component={ApiAccessPage} />
          <Route path="/admin/intake-forms" component={IntakeFormsPage} />
          <Route path="/admin/reports" component={ReportsPage} />
          <Route path="/admin/zones" component={ZonesPage} />
          <Route path="/admin/payouts" component={PayoutsPage} />
          <Route path="/admin/tags" component={TagsPage} />
          <Route path="/admin/audit" component={AuditPage} />
          <Route path="/admin/settings" component={SettingsPage} />
          <Route path="/admin/catalog" component={CatalogPage} />
          <Route path="/admin/options" component={OptionsCatalogPage} />
          <Route path="/admin/services" component={ServicesPage} />
          <Route path="/admin/reviews" component={ReviewsPage} />
          <Route path="/admin/notifications" component={NotificationsPage} />
          <Route path="/admin/companies" component={CompaniesPage} />
          <Route>
            <AdminNotFound />
          </Route>
        </Switch>
      </Suspense>
    </AdminShell>
  );
}
