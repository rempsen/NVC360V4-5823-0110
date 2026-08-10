import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite"
import path from "path";
import runableAnalyticsPlugin from "./vite/plugins/runable-analytics-plugin";
import honoDevPlugin from "./vite/plugins/hono-dev-plugin";

const root = path.resolve(__dirname, "../..");

export default defineConfig(({ command, mode }) => {
	const env = loadEnv(mode, root, '');

	// Load the monorepo root .env into process.env so the Hono dev plugin and
	// anything else running in the config/server process can read it.
	//
	// NEVER copy NODE_ENV across. That root .env is the SERVER's env file and it
	// carries NODE_ENV=development. Vite derives `isProduction` from
	// process.env.NODE_ENV, so assigning it here silently turned every
	// production build into a development build: `import.meta.env.DEV` compiled
	// to `true`, React was bundled in development mode (dev warnings, ~2-3x
	// slower renders), the AgentFeedback dev widget shipped to real users, and
	// Sentry's `if (!DSN || import.meta.env.DEV) return;` was constant-folded to
	// an unconditional return -- which tree-shook the entire @sentry/react SDK
	// out of the bundle, so web crash reporting could never work no matter what
	// DSN was configured.
	const { NODE_ENV: _rootNodeEnv, ...safeEnv } = env;
	Object.assign(process.env, safeEnv);

	// loadEnv() has a side effect that is easy to miss: when any .env file it
	// reads declares NODE_ENV, Vite stashes it in process.env.VITE_USER_NODE_ENV
	// and then applies it while resolving the config -- AFTER this function
	// returns. So simply not copying NODE_ENV above is not enough; the root
	// .env's `development` still wins unless we clear the stash too.
	delete process.env.VITE_USER_NODE_ENV;
	// Be explicit rather than relying on whatever NODE_ENV the shell happens to
	// carry: `vite build` is production unless someone asked for another mode.
	process.env.NODE_ENV = command === "build" && mode !== "development" ? "production" : "development";

	return {
		plugins: [honoDevPlugin(), react(), runableAnalyticsPlugin(), tailwind()],
		resolve: {
			alias: {
				"@": path.resolve(__dirname, "./src/web"),
			},
		},
		// NOTE: optimizeDeps only affects the dev server's esbuild pre-bundle
		// cache — it has ZERO effect on the production build, which is built by
		// Rollup. Keeping the include list below for faster dev cold-starts, but
		// it is NOT what prevents the production TDZ bug. The real fix is the
		// dedicated manualChunks entry for better-auth below (isolates it into
		// its own chunk instead of interleaving with the generic `vendor` chunk),
		// which is what actually resolves "Cannot access 'b' before
		// initialization" in production. See manualChunks() for the fix.
		optimizeDeps: {
			include: [
				"better-auth/react",
				"better-auth/client/plugins",
			],
		},
		server: {
			allowedHosts: true,
			hmr: { overlay: false, },
			cors: false
		},
		build: {
			// Split ONLY heavy, self-contained libraries into their own chunks so
			// they load lazily on the routes that use them. Everything else
			// (React, ReactDOM, scheduler, router, query, and their dependents)
			// stays in a single `vendor` chunk.
			//
			// NOTE: do NOT hand-split the React ecosystem across multiple chunks.
			// Packages like @tanstack/react-query and wouter import React, and a
			// fragile path-based split can land a dependent in `vendor` while React
			// sits in `vendor-react`, producing a cross-chunk circular init that
			// throws "Cannot read properties of undefined (reading 'exports')" at
			// runtime — a fully blank page. Keeping them together guarantees a
			// correct, deterministic init order.
			rollupOptions: {
				output: {
					manualChunks(id) {
						if (!id.includes("node_modules")) return;
						if (id.includes("leaflet")) return "vendor-maps";
						if (id.includes("recharts") || id.includes("d3-")) return "vendor-charts";
						if (id.includes("pdf-lib")) return "vendor-pdf";
						// better-auth lazily initializes its exports (only on first
						// method call, not on import). When Rollup interleaves it
						// with unrelated deps in the generic `vendor` chunk, the
						// cross-module init order it produces can throw a TDZ error
						// at runtime: "Cannot access 'b' before initialization"
						// (minified var name varies per build). Isolating it into
						// its own chunk gives it a deterministic, self-contained
						// top-to-bottom init order and eliminates the ordering
						// hazard entirely.
						if (id.includes("better-auth") || id.includes("better-call")) return "vendor-auth";
						return "vendor";
					},
				},
			},
			chunkSizeWarningLimit: 900,
		}
	};
});
