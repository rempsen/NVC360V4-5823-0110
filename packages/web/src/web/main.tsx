import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Router } from "wouter";
import "./styles.css";
import App from "./app.tsx";
import { initSentry, reportError } from "./lib/sentry";
import { installGlobalErrorHandlers } from "./lib/global-errors";

// Crash reporting first, so anything that blows up during boot is still caught.
initSentry();
installGlobalErrorHandlers();

// NOTE: the QueryClientProvider lives inside <App> (see components/provider.tsx)
// as a single shared client. There used to be a second QueryClient created here
// that wrapped App — because Provider nested inside it, the inner client won and
// this one was dead weight that also made client-level config here a no-op.
const rootEl = document.getElementById("root");
if (!rootEl) {
	reportError(new Error("Root element #root missing from document"));
} else {
	createRoot(rootEl).render(
		<StrictMode>
			<Router>
				<App />
			</Router>
		</StrictMode>,
	);
}
