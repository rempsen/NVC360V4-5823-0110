/**
 * Service-zone enforcement, in one place.
 *
 * This lived inline in the admin work-order create route only, which meant the
 * CUSTOMER booking route (POST /api/bookings) accepted an address anywhere on
 * earth even when the tenant had active zones drawn — a customer 3,000 km
 * outside the service area got a "confirmed" booking, an invoice, and a
 * dispatch notification. Both create paths now call this.
 *
 * Semantics (unchanged from the original admin implementation):
 *   - No active zones (none drawn, or all toggled off) => everything allowed.
 *     A tenant that hasn't set zones up is not opted in to enforcement.
 *   - Zones exist => the point must fall inside at least one ACTIVE zone.
 *   - A zone needs >= 3 points to be a polygon; malformed rows are ignored.
 */
import * as schema from "../api/database/schema";
import { tdb } from "../api/database/tenant";
import { isInAnyZone } from "../shared/zone-utils";

export const OUTSIDE_ZONE_MESSAGE =
  "That address is outside our service area. Please check the address or contact us.";

/** Admin-facing wording (the office can fix either side of the problem). */
export const OUTSIDE_ZONE_MESSAGE_ADMIN =
  "Address is outside all active service zones. Please update the client address or adjust your service zones.";

export interface ZoneCheck {
  /** true = allowed to proceed. */
  ok: boolean;
  /** true when the tenant has at least one active, well-formed zone. */
  enforced: boolean;
}

/**
 * Is this point serviceable for this tenant?
 * Pass finite coordinates only — callers that have no coordinates must decide
 * for themselves whether to geocode first or skip the check.
 */
export async function checkServiceZone(
  companyId: string,
  lat: number,
  lng: number,
): Promise<ZoneCheck> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: true, enforced: false };

  const rows = await tdb(companyId).select(schema.serviceZones);
  const parsed = rows.map((z) => {
    let polygon: [number, number][] = [];
    try {
      const p = JSON.parse(z.polygon || "[]");
      if (Array.isArray(p)) polygon = p as [number, number][];
    } catch {
      /* malformed zone row — ignored, same as before */
    }
    return { polygon, active: z.active };
  });

  const active = parsed.filter((z) => z.active && z.polygon.length >= 3);
  if (active.length === 0) return { ok: true, enforced: false };

  return { ok: isInAnyZone(lat, lng, parsed), enforced: true };
}
