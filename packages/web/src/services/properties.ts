/**
 * Property resolution — turns a free-text job address into a stable property
 * record so every job at the same address accumulates into one service history.
 *
 * Deliberately forgiving: address normalisation is best-effort string work, not
 * geocoding. If we can't make sense of an address we return null and the job
 * simply has no property link — nothing breaks, it just doesn't appear in a
 * property hub. Never throw from here; a bad address must not block saving a
 * work order.
 */
import { db } from "../api/database";
import * as schema from "../api/database/schema";
import { and, eq } from "drizzle-orm";

/**
 * Dedupe key for an address.
 *
 * Lowercase, strip everything that isn't a letter/digit/space, collapse
 * whitespace, and fold the handful of street-type abbreviations that people
 * mix constantly ("123 Main Street" vs "123 Main St."). This is intentionally
 * conservative — we'd rather create two property rows for the same building
 * than merge two different buildings and leak one customer's history to
 * another.
 */
export function normalizeAddress(raw: string): string {
  if (!raw) return "";
  let s = raw.toLowerCase();
  // drop punctuation, keep alphanumerics and spaces
  s = s.replace(/[^a-z0-9\s]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return "";
  // fold common street-type abbreviations to a canonical short form
  const ABBREV: Record<string, string> = {
    street: "st",
    avenue: "ave",
    av: "ave",
    road: "rd",
    drive: "dr",
    boulevard: "blvd",
    court: "ct",
    crescent: "cres",
    place: "pl",
    lane: "ln",
    terrace: "terr",
    parkway: "pkwy",
    highway: "hwy",
    north: "n",
    south: "s",
    east: "e",
    west: "w",
    northeast: "ne",
    northwest: "nw",
    southeast: "se",
    southwest: "sw",
    apartment: "apt",
    unit: "apt",
    suite: "apt",
  };
  s = s
    .split(" ")
    .map((w) => ABBREV[w] ?? w)
    .join(" ");
  return s;
}

/**
 * Find the property for this address within a tenant, creating it if new.
 * Returns null when the address is unusable — callers should treat that as
 * "no property link" and carry on.
 */
export async function resolveProperty(opts: {
  companyId: string;
  address: string;
  lat?: number | null;
  lng?: number | null;
  customerId?: string | null;
}): Promise<{ id: string; publicToken: string } | null> {
  try {
    const addressNormalized = normalizeAddress(opts.address);
    // Guard against junk: a 2-character "address" is noise, not a property.
    if (addressNormalized.length < 4) return null;

    const [existing] = await db
      .select()
      .from(schema.properties)
      .where(
        and(
          eq(schema.properties.companyId, opts.companyId),
          eq(schema.properties.addressNormalized, addressNormalized),
        ),
      );

    if (existing) {
      // Backfill coordinates / customer if we've learned them since. Properties
      // outlive customers, so the most recent customer wins.
      const patch: Record<string, unknown> = {};
      if (existing.lat == null && opts.lat != null) patch.lat = opts.lat;
      if (existing.lng == null && opts.lng != null) patch.lng = opts.lng;
      if (opts.customerId && existing.customerId !== opts.customerId) {
        patch.customerId = opts.customerId;
      }
      if (Object.keys(patch).length) {
        patch.updatedAt = new Date();
        await db
          .update(schema.properties)
          .set(patch)
          .where(eq(schema.properties.id, existing.id));
      }
      return { id: existing.id, publicToken: existing.publicToken };
    }

    const [created] = await db
      .insert(schema.properties)
      .values({
        companyId: opts.companyId,
        addressNormalized,
        addressDisplay: opts.address.trim(),
        lat: opts.lat ?? null,
        lng: opts.lng ?? null,
        customerId: opts.customerId || null,
      })
      .returning();

    return created ? { id: created.id, publicToken: created.publicToken } : null;
  } catch (e) {
    // A property link is an enhancement, never a requirement. Log and move on.
    console.error("[properties] resolve failed", e);
    return null;
  }
}

/** Attach a booking to its property, resolving/creating the property as needed. */
export async function linkBookingToProperty(bookingId: string): Promise<string | null> {
  try {
    const [b] = await db
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, bookingId));
    if (!b) return null;
    if (b.propertyId) return b.propertyId; // already linked

    const prop = await resolveProperty({
      companyId: b.companyId,
      address: b.address,
      lat: b.lat,
      lng: b.lng,
      customerId: b.customerId,
    });
    if (!prop) return null;

    await db
      .update(schema.bookings)
      .set({ propertyId: prop.id })
      .where(eq(schema.bookings.id, bookingId));
    return prop.id;
  } catch (e) {
    console.error("[properties] linkBooking failed", e);
    return null;
  }
}

/** Public URL for a property hub link (mirrors sms.ts trackingUrl). */
export function propertyUrl(token: string): string {
  const base = (
    process.env.WEBSITE_URL ||
    process.env.APP_URL ||
    process.env.PUBLIC_URL ||
    ""
  ).replace(/\/$/, "");
  return `${base}/p/${token}`;
}
