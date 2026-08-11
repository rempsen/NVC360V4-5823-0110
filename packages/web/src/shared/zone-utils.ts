/**
 * Shared zone utilities — used by API routes (enforcement) and reports (attribution).
 * No external deps — pure math only.
 */

export type LatLng = [number, number]; // [lat, lng]

/**
 * Ray-casting point-in-polygon test. poly is [[lat,lng], ...].
 *
 * The previous implementation mixed up its axes: it took the polygon vertices as
 * (y=lat, x=lng) but compared them against the TEST point as (y=lng, x=lat).
 * Because the two operands were in different coordinate frames, the crossing
 * test `yi > lng !== yj > lng` compared a latitude with a longitude — in Canada
 * (lat ~+50, lng ~-97) that is true for every vertex, so it never counted a
 * crossing and this function returned FALSE FOR EVERY POINT. Every service zone
 * therefore contained nothing: any tenant who activated a zone had all bookings
 * rejected as "outside all active service zones", and zone attribution in
 * reports matched no jobs at all.
 *
 * Now both the vertices and the test point use (x = lng, y = lat).
 */
export function inPoly(lat: number, lng: number, poly: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [latI, lngI] = poly[i]!;
    const [latJ, lngJ] = poly[j]!;
    const straddles = latI > lat !== latJ > lat;
    if (!straddles) continue;
    // longitude of the edge at this latitude
    const lngAtLat = ((lngJ - lngI) * (lat - latI)) / (latJ - latI) + lngI;
    if (lng < lngAtLat) inside = !inside;
  }
  return inside;
}

/** Returns true if [lat,lng] is inside at least one active zone (polygon). */
export function isInAnyZone(lat: number, lng: number, zones: Array<{ polygon: LatLng[]; active: boolean }>): boolean {
  const active = zones.filter((z) => z.active && z.polygon.length >= 3);
  if (active.length === 0) return true; // no zones defined → unrestricted
  return active.some((z) => inPoly(lat, lng, z.polygon));
}

/**
 * Approximate a circle as a closed polygon (n points).
 * center: [lat, lng], radiusM: meters, n: vertex count (default 64).
 */
export function circleToPolygon(centerLat: number, centerLng: number, radiusM: number, n = 64): LatLng[] {
  const pts: LatLng[] = [];
  const latRad = (centerLat * Math.PI) / 180;
  // 111320 m is already one DEGREE of latitude, so the quotient is degrees —
  // the old code then multiplied by 180/PI as if it were radians, inflating
  // every circle zone by 57.3x (a "5 km" radius covered ~286 km).
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos(latRad));
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n;
    pts.push([centerLat + dLat * Math.sin(angle), centerLng + dLng * Math.cos(angle)]);
  }
  return pts;
}

/**
 * Convert two opposite corners to a 4-point rectangle polygon.
 */
export function rectToPolygon(lat1: number, lng1: number, lat2: number, lng2: number): LatLng[] {
  return [
    [lat1, lng1],
    [lat1, lng2],
    [lat2, lng2],
    [lat2, lng1],
  ];
}
