import type { requestLogger } from "./lib/logger";

/**
 * Per-request context values shared by every router.
 *
 * These are the keys `c.set(...)` writes (see `middleware/auth.ts` and the
 * request-id middleware in `index.ts`). Sub-routers MUST be created as
 * `new Hono<AppEnv>()` — a bare `new Hono()` has an empty Variables map, which
 * makes `c.get("user")` resolve to the `(key: never)` overload and produces a
 * wall of bogus "No overload matches this call" errors.
 */
export type Variables = {
  user: {
    id: string;
    role?: string;
    email: string;
    name: string;
    companyId?: string;
    permissions?: string | null;
    staffType?: string | null;
    managerId?: string | null;
  } | null;
  session: unknown;
  companyId: string;
  /** Every active company this person can act as (see middleware/auth.ts). */
  memberships: {
    companyId: string;
    role: string;
    permissions: string | null;
    staffType: string | null;
    managerId: string | null;
  }[];
  apiKey?: { id: string; label: string; scopes: string[] };
  requestId: string;
  log: ReturnType<typeof requestLogger>;
};

/** Hono env for this app. Use as `new Hono<AppEnv>()`. */
export type AppEnv = { Variables: Variables };
