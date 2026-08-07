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
import { AppError } from "./errors";

/**
 * A 400 that carries a per-field map.
 *
 * It extends `AppError` on purpose: the global `onError` handler in
 * src/api/index.ts already turns AppError into the sanitized envelope, so
 * validation failures need no special casing there and — critically — routes
 * can *throw* instead of *returning* a Response. Returning a bare `Response`
 * from a Hono handler erases that route's typed JSON output, which silently
 * broke the RPC types on every client call site that touched a validated
 * route (measured: +111 phantom type errors across the web app).
 */
export class ValidationError extends AppError {
  constructor(
    public readonly fields: Record<string, string>,
    message: string,
  ) {
    super(400, "validation_failed", message, { expose: true, details: { fields } });
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
 * Back-compat shim for the `if (!parsed.ok) return parsed.response` shape.
 *
 * Prefer `parseBody` — it throws, so the route keeps its typed JSON return.
 * @deprecated
 */
export async function validate<S extends z.ZodTypeAny>(
  c: Context,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> }> {
  return { ok: true, data: await parseBody(c, schema) };
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

/** An id we received from a client. Non-empty, length-capped, no newlines. */
export const id = (label = "Id") =>
  z
    .string({ message: `${label} is required` })
    .trim()
    .min(1, `${label} is required`)
    .max(128, `${label} is not a valid id`);

/**
 * A date/time from a client, as an ISO string or an epoch number.
 *
 * This is the one that matters most: several routes did `new Date(body.x)` on
 * an unchecked value. `new Date("next tuesday")` is an Invalid Date, which
 * drizzle happily writes, and the row then breaks every screen that formats it.
 */
export const isoDate = (label = "Date") =>
  z
    .union([z.string(), z.number()])
    .refine((v) => !Number.isNaN(new Date(v as string | number).getTime()), {
      message: `${label} must be a valid date`,
    })
    .transform((v) => new Date(v as string | number));

export const latitude = z
  .number({ message: "Latitude must be a number" })
  .min(-90, "Latitude must be between -90 and 90")
  .max(90, "Latitude must be between -90 and 90");

export const longitude = z
  .number({ message: "Longitude must be a number" })
  .min(-180, "Longitude must be between -180 and 180")
  .max(180, "Longitude must be between -180 and 180");

/** 1–5 stars, whole numbers only. Unchecked ratings skew technician averages. */
export const rating = z
  .number({ message: "Rating must be a number" })
  .int("Rating must be a whole number")
  .min(1, "Rating must be between 1 and 5")
  .max(5, "Rating must be between 1 and 5");

/** Optional free text that should become "" rather than null when omitted. */
export const optText = (max = 2_000) => z.string().trim().max(max, `Must be ${max} characters or fewer`).optional();

/** An email address we might send to. */
export const email = (label = "Email") =>
  z.string({ message: `${label} is required` }).trim().toLowerCase().email(`${label} must be a valid email address`);

/** A phone number. Deliberately loose — international formats vary wildly. */
export const phone = z
  .string()
  .trim()
  .max(32, "Phone number is too long")
  .refine((v) => v === "" || /^[+\d][\d\s()\-.]{5,}$/.test(v), "Phone number doesn't look valid");

/** Work-order lifecycle states, as consumed by services/booking-status.ts. */
export const BOOKING_STATUSES = [
  "pending",
  "unassigned",
  "confirmed",
  "assigned",
  "declined",
  "enroute",
  "arrived",
  "onsite",
  "in_progress",
  "paused",
  "completed",
  "cancelled",
] as const;

export const bookingStatus = z.enum(BOOKING_STATUSES, {
  message: `Status must be one of: ${BOOKING_STATUSES.join(", ")}`,
});

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const priority = z.enum(PRIORITIES, {
  message: `Priority must be one of: ${PRIORITIES.join(", ")}`,
});

/**
 * Arbitrary JSON blobs (fieldData, rateModel, lineItems) that a route stores
 * with JSON.stringify. We can't schema every shape, but we CAN stop a 5 MB
 * payload or a deeply nested object from being written into a text column.
 */
export const jsonBlob = (maxChars = 200_000) =>
  z.unknown().refine((v) => {
    try {
      return JSON.stringify(v ?? null).length <= maxChars;
    } catch {
      return false; // circular / unserialisable
    }
  }, `Payload is too large (max ${maxChars} characters)`);

/**
 * Same size guard as `jsonBlob`, but the value must be a JSON object. Use this
 * when the route reads named keys off the payload (e.g. `fieldData._customFields`)
 * — `jsonBlob`'s `unknown` would force an `as any` at every read site, which is
 * exactly the un-typed access this whole pass exists to remove.
 */
export const jsonObject = (maxChars = 200_000) =>
  z
    .record(z.string(), z.unknown())
    .refine((v) => {
      try {
        return JSON.stringify(v).length <= maxChars;
      } catch {
        return false; // circular / unserialisable
      }
    }, `Payload is too large (max ${maxChars} characters)`);

/** A wall-clock time of day, as the quiet-hours UI writes it: "21:00". */
export const hhmm = (label = "Time") =>
  z
    .string()
    .trim()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, `${label} must be a 24-hour time like 21:00`);

/** A #rrggbb / #rgb colour, as the brand colour pickers emit. */
export const hexColor = (label = "Colour") =>
  z
    .string()
    .trim()
    .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, `${label} must be a hex colour like #06B6D4`);

/**
 * An outbound http(s) URL the SERVER will fetch — webhook endpoints, callbacks.
 *
 * Two separate problems here. `javascript:alert(1)` stored as a webhook URL is
 * a stored-XSS payload the moment any UI renders it as a link. And a URL
 * pointing at loopback / link-local / RFC1918 space turns our own webhook
 * test-ping into an SSRF probe of the host network from inside the container.
 * Both are rejected at the edge.
 */
const BLOCKED_HOST =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd])/i;
export const outboundUrl = (label = "URL") =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .min(1, `${label} is required`)
    .max(2_000, `${label} must be 2000 characters or fewer`)
    .superRefine((v, ctx) => {
      let u: URL;
      try {
        u = new URL(v);
      } catch {
        ctx.addIssue({ code: "custom", message: `${label} must be a full URL starting with https://` });
        return;
      }
      if (u.protocol !== "https:" && u.protocol !== "http:")
        ctx.addIssue({ code: "custom", message: `${label} must use http:// or https://` });
      if (BLOCKED_HOST.test(u.hostname) || !u.hostname.includes("."))
        ctx.addIssue({ code: "custom", message: `${label} must point at a public host` });
    });

/** A real boolean — never the string "no", which is truthy in JS. */
export const bool = (label: string) =>
  z.boolean({ error: `${label} must be true or false` });
