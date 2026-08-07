/**
 * The error every failed API call throws.
 *
 * Background: the hono RPC client does NOT throw on a non-2xx response — it
 * resolves normally and hands the error body to the caller. Because ~130 of the
 * app's `useMutation` calls had no `onError`, react-query treated those rejected
 * writes as successes: `onSuccess` fired, the list invalidated, the modal
 * closed, and the user believed their change had saved when the server had
 * refused it. That is the silent-data-loss class this file exists to kill.
 *
 * `apiFetch` (see ./api.ts) now throws one of these for any non-2xx, so every
 * existing mutation starts failing correctly without touching its call site.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  /** Parsed response body, when it was JSON. */
  readonly body?: unknown;

  constructor(args: {
    status: number;
    message: string;
    code?: string;
    requestId?: string;
    body?: unknown;
  }) {
    super(args.message);
    this.name = "ApiError";
    this.status = args.status;
    this.code = args.code;
    this.requestId = args.requestId;
    this.body = args.body;
  }

  /** 401/403 — the user is signed out or lacks permission. */
  get isAuth() {
    return this.status === 401 || this.status === 403;
  }
  /** 4xx that the user can potentially fix by changing their input. */
  get isUserFixable() {
    return this.status >= 400 && this.status < 500 && this.status !== 401 && this.status !== 403;
  }
}

/**
 * Human-readable message for any thrown value.
 *
 * The API's error envelope is `{ error: { code, message }, requestId }`, but
 * several older routes return a bare `{ message }`. Both are handled, plus a
 * status-based fallback so the user never sees "[object Object]" or a raw
 * "Failed to fetch".
 */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Your session expired — please sign in again.";
    if (err.status === 403) return "You don't have permission to do that.";
    if (err.status === 404) return "That item no longer exists — it may have been deleted.";
    if (err.status === 409) return err.message || "That conflicts with an existing record.";
    if (err.status === 413) return "That file is too large.";
    if (err.status === 429) return "Too many requests — wait a moment and try again.";
    if (err.status >= 500)
      return err.requestId
        ? `Server error — nothing was saved. Reference: ${err.requestId}`
        : "Server error — nothing was saved. Please try again.";
    return err.message || "That didn't save.";
  }
  if (err instanceof TypeError && /fetch|network/i.test(err.message))
    return "Can't reach the server — check your connection.";
  if (err instanceof Error) return err.message || "Something went wrong.";
  return "Something went wrong.";
}

/** Pull the best available message out of a parsed error body. */
export function messageFromBody(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, any>;
    if (b.error && typeof b.error === "object" && typeof b.error.message === "string")
      return b.error.message;
    if (typeof b.message === "string") return b.message;
    if (typeof b.error === "string") return b.error;
  }
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 300);
  return `Request failed (${status})`;
}
