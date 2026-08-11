/**
 * Forward geocoding, server-side.
 *
 * Extracted from routes/geo.ts so the booking-create paths can resolve an
 * address to real coordinates themselves. They need this because a booking's
 * lat/lng column is NOT NULL with a default of downtown Toronto — so any create
 * that arrives without coordinates silently records the job at 43.6532,-79.3832,
 * where it then shows up on the fleet map, feeds distance/ETA, and (worse)
 * skips service-zone enforcement entirely because the route only zone-checks
 * when coordinates were supplied.
 *
 * Uses Google when GOOGLE_MAPS_API_KEY is set, otherwise Nominatim. Never
 * throws and never hangs a request: on timeout, network failure, or no match it
 * returns null and the caller decides what to do.
 */

const KEY = process.env.GOOGLE_MAPS_API_KEY;

/** Hard cap so a slow geocoder can't stall a booking POST. */
const TIMEOUT_MS = 4_000;

export interface GeocodeHit {
  lat: number;
  lng: number;
  /** Provider's formatted address, or the input when it didn't supply one. */
  address: string;
  provider: "google" | "osm";
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

async function fetchJson(url: URL, headers?: Record<string, string>): Promise<any | null> {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null; // timeout / DNS / malformed JSON — treated as "no result"
  }
}

/** Resolve free-text address -> coordinates. Returns null when it can't. */
export async function forwardGeocode(address: string): Promise<GeocodeHit | null> {
  const q = (address || "").trim();
  if (!q) return null;

  if (KEY) {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", q);
    url.searchParams.set("key", KEY);
    const data = await fetchJson(url);
    const loc = data?.results?.[0]?.geometry?.location;
    if (finite(loc?.lat) && finite(loc?.lng)) {
      return {
        lat: loc.lat,
        lng: loc.lng,
        address: data.results[0].formatted_address ?? q,
        provider: "google",
      };
    }
    return null;
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", q);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  const data = await fetchJson(url, { "User-Agent": "NVC360/1.0" });
  const hit = Array.isArray(data) ? data[0] : null;
  const lat = hit ? parseFloat(hit.lat) : NaN;
  const lng = hit ? parseFloat(hit.lon) : NaN;
  if (!finite(lat) || !finite(lng)) return null;
  return { lat, lng, address: hit.display_name ?? q, provider: "osm" };
}
