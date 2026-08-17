/**
 * Response unwrapping for the typed Hono RPC client.
 *
 * Deliberately a standalone module with NO browser dependencies (api.ts pulls in
 * localStorage-backed auth at import time), so the type-level tests can import
 * it directly under bun test.
 */

/** The API's error envelope, as Hono types it on 4xx/5xx JSON returns. */
type ErrEnvelope = { message: string };

/**
 * Drop the error branch from a Hono RPC response union.
 *
 * `apiFetch` above THROWS on every non-2xx, so an error body can never reach a
 * call site — but Hono still types `.json()` as `success | { message: string }`.
 * That union is why ~109 real type errors existed across the app: every
 * `data.bookings` was "does not exist on type ..." and, worse, the degraded
 * union silently made `.map((b) => ...)` callbacks implicitly `any`, so the
 * inside of those callbacks was completely unchecked.
 *
 * The guard is deliberately two-sided: a branch is dropped only when it is
 * assignable to `{ message: string }` AND `{ message: string }` is assignable
 * back to it — i.e. it is EXACTLY the error envelope. A legitimate success body
 * that happens to carry a `message` field (plus anything else) is kept.
 */
export type SuccessOf<T> = T extends ErrEnvelope
  ? ErrEnvelope extends T
    ? never
    : T
  : T;

/** The JSON body a (possibly union-typed) client response resolves to. */
type JsonOf<R> = R extends { json(): Promise<infer T> } ? T : never;

/**
 * Read a typed JSON body, narrowed to the success shape.
 *
 * `const { bookings } = await ok(await api.bookings.$get());`
 *
 * The generic is over the RESPONSE, not the body: the Hono client returns a
 * union of `ClientResponse<Body, Status, "json">` (one member per status code),
 * and inferring `T` directly from `{ json(): Promise<T> }` would silently pick
 * a single member (in practice the 401 error branch). `JsonOf` distributes over
 * the response union instead, so every status' body is collected and only then
 * is the error envelope dropped.
 */
export async function ok<R extends { json(): Promise<unknown> }>(
  res: R,
): Promise<SuccessOf<JsonOf<R>>> {
  return (await res.json()) as SuccessOf<JsonOf<R>>;
}
