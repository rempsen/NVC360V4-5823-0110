import { hc } from "hono/client";
import type { AppType } from "../../api";
import { getToken } from "./auth";
import { ApiError, messageFromBody } from "./api-error";

/**
 * Shared auth/tenant headers for every API request.
 * Used by the typed hono client AND any raw `fetch` calls so they all carry
 * the bearer token + superadmin company-switch header consistently.
 */
export function apiHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  const token = getToken();
  if (token) h.Authorization = `Bearer ${token}`;
  const active =
    typeof localStorage !== "undefined"
      ? localStorage.getItem("active_company")
      : null;
  if (active) h["X-Company-Id"] = active;
  return h;
}

/**
 * Fetch wrapper that THROWS `ApiError` on any non-2xx response.
 *
 * This is the single choke point that fixes the app-wide silent-write-failure
 * bug. The hono client resolves non-2xx responses normally, so a 400/403/500
 * used to flow into react-query as a success. By throwing here — below the
 * client, above every call site — all ~161 `useMutation` calls start rejecting
 * correctly with no change to their code.
 *
 * The response body is consumed on the error path only. Success responses are
 * returned untouched so `.json()` at the call site still works exactly as
 * before, which is what makes this a non-breaking change.
 *
 * Deliberately NOT used by the raw `fetch` call sites that degrade gracefully
 * on a non-ok response (e.g. the fleet map falling back to an empty list, the
 * integrations "coming soon" state). Those check `res.ok` themselves and must
 * keep their current behaviour.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(input, init);
  if (res.ok) return res;

  // Read the error body once, defensively — it may be JSON, text, or empty.
  let body: unknown;
  const raw = await res.text().catch(() => "");
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }

  const envelope =
    body && typeof body === "object" ? (body as Record<string, any>) : undefined;

  throw new ApiError({
    status: res.status,
    message: messageFromBody(body, res.status),
    code: envelope?.error?.code ?? envelope?.code,
    requestId: envelope?.requestId ?? res.headers.get("x-request-id") ?? undefined,
    body,
  });
}

const client = hc<AppType>("/", {
  headers: () => apiHeaders(),
  fetch: apiFetch,
});

export const api = client.api;
