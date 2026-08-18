/** Great-circle distance in km between two lat/lng points (Haversine). */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // km
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Geofence test: is a point within `radiusMeters` of a target?
 * Pure helper shared by the tracking auto-arrive/clock logic so the threshold
 * decision is unit-testable independently of the request/DB path.
 */
export function isInsideGeofence(
  lat: number,
  lng: number,
  targetLat: number,
  targetLng: number,
  radiusMeters: number,
): boolean {
  const radiusKm = (radiusMeters || 0) / 1000;
  return haversineKm(lat, lng, targetLat, targetLng) <= radiusKm;
}

/** Sum consecutive pings into total path distance (km). Filters GPS jitter < 5m and jumps > 5km. */
export function pathDistanceKm(points: { lat: number; lng: number }[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = haversineKm(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
    if (d > 0.005 && d < 5) total += d;
  }
  return Math.round(total * 100) / 100;
}

/* -------------------------------------------------------------------------- */
/*  Geofence radius                                                            */
/* -------------------------------------------------------------------------- */
/**
 * Auto-arrive radius when a company hasn't configured one.
 *
 * This constant exists because the number used to be written in four places
 * and disagreed in three of them: the DB column defaulted to 150, the tracking
 * route fell back to 20, the admin settings form coerced blanks to 20, and the
 * driver app told technicians "auto-arrives within 150m". A company with no
 * settings row therefore needed a driver inside 20 m of a geocoded pin — which
 * essentially never happens on a commercial site — while the app promised
 * 150 m. Auto check-in looked broken and drivers stopped trusting it.
 */
export const DEFAULT_GEOFENCE_RADIUS_M = 150;

/** Below consumer GPS accuracy — a radius this small can never trigger. */
const MIN_GEOFENCE_RADIUS_M = 10;
/** Beyond this, "arrived" stops meaning anything (auto-arrive across town). */
const MAX_GEOFENCE_RADIUS_M = 2000;

/**
 * A usable radius in metres from whatever the settings row holds.
 *
 * Zero, negative and unparseable values fall back to the default rather than
 * being trusted: `radius = 0` disables auto-arrive completely and the driver
 * has no way to tell that's what happened.
 */
export function resolveGeofenceRadiusM(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_GEOFENCE_RADIUS_M;
  return Math.min(MAX_GEOFENCE_RADIUS_M, Math.max(MIN_GEOFENCE_RADIUS_M, Math.round(n)));
}
