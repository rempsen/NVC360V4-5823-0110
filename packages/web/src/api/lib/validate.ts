/**
 * Request-body validation.
 *
 * The API previously had ZERO schema validation — 93 raw `c.req.json()` calls
 * wrote request bodies straight to the database. A live probe created a real
 * service with an empty name, `basePrice: -99999`, `durationMins: -5` and a
 * 50,000-character description, and the API returned 201. Negative prices flow
 * into subtotal/total and technician pay, so this was a data-integrity hole
 * feeding the carefully unit-tested pricing logic in shared/pricing.ts.
 *
 * Design notes:
 * - Returns a 400 with the SAME envelope shape the rest of the API uses
 *   (`{ error: { code, message }, ... }`) plus a `fields` map, so the new
 *   throwing client on the web side surfaces a usable message automatically.
 * - `.strict()` is deliberately NOT the default: several existing clients send
 *   extra keys, and rejecting them would break working screens. Unknown keys are
 *   stripped instead, which also removes the mass-assignment surface.
 */
import type { Context } from "hono";
import { z } from "zod";

export class ValidationError extends Error {
  constructor(
    public readonly fields: Record<string, string>,
    message: string,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Flatten a ZodError into `{ fieldPath: firstMessage }`. */
function toFieldMap(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.length ? issue.path.join(".") : "_";
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

/** First human-readable problem, for the toast/message line. */
function summarize(fields: Record<string, string>): string {
  const entries = Object.entries(fields);
  if (!entries.length) return "Invalid request";
  const [k, v] = entries[0];
  const rest = entries.length - 1;
  const base = k === "_" ? v : `${k}: ${v}`;
  return rest > 0 ? `${base} (and ${rest} more ${rest === 1 ? "problem" : "problems"})` : base;
}

/**
 * Parse and validate a JSON body. Throws `ValidationError` on failure, which
 * the route helper below converts into a 400.
 */
export async function parseBody<S extends z.ZodTypeAny>(
  c: Context,
  schema: S,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ValidationError({ _: "Request body must be valid JSON" }, "Request body must be valid JSON");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const fields = toFieldMap(result.error);
    throw new ValidationError(fields, summarize(fields));
  }
  return result.data;
}

/**
 * Validate a body and return either the parsed value or a ready-to-return 400
 * response. Lets routes stay flat without a try/catch:
 *
 *   const parsed = await validate(c, ServiceCreate);
 *   if (!parsed.ok) return parsed.response;
 *   const body = parsed.data;
 */
export async function validate<S extends z.ZodTypeAny>(
  c: Context,
  schema: S,
): Promise<
  | { ok: true; data: z.infer<S>; response?: undefined }
  | { ok: false; data?: undefined; response: Response }
> {
  try {
    return { ok: true, data: await parseBody(c, schema) };
  } catch (err) {
    if (err instanceof ValidationError) {
      return {
        ok: false,
        response: c.json(
          {
            error: { code: "validation_failed", message: err.message },
            fields: err.fields,
            // kept for the older clients that read a bare `message`
            message: err.message,
          },
          400,
        ),
      };
    }
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*  Reusable field primitives                                                 */
/* -------------------------------------------------------------------------- */

/** Money in cents/dollars — never negative, never absurd, never NaN. */
export const money = (label = "Amount") =>
  z
    .number({ message: `${label} must be a number` })
    .finite(`${label} must be a real number`)
    .min(0, `${label} can't be negative`)
    .max(10_000_000, `${label} is unrealistically large`);

/** A duration in minutes — positive, capped at 30 days. */
export const durationMins = z
  .number({ message: "Duration must be a number" })
  .int("Duration must be a whole number of minutes")
  .min(1, "Duration must be at least 1 minute")
  .max(43_200, "Duration can't exceed 30 days");

/** Required human-entered short text. */
export const shortText = (label: string, max = 200) =>
  z
    .string({ message: `${label} is required` })
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be ${max} characters or fewer`);

/** Optional longer free text, length-capped to stop 50k-char payloads. */
export const longText = (max = 5_000) => z.string().trim().max(max, `Must be ${max} characters or fewer`);

/** Percentage 0–100. */
export const percent = (label = "Percentage") =>
  z.number({ message: `${label} must be a number` }).min(0, `${label} can't be negative`).max(100, `${label} can't exceed 100`);
