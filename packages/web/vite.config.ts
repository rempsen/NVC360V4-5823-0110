import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite"
import path from "path";
import runableAnalyticsPlugin from "./vite/plugins/runable-analytics-plugin";
import honoDevPlugin from "./vite/plugins/hono-dev-plugin";

const root = path.resolve(__dirname, "../..");

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, root, '');
	Object.assign(process.env, env);

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
