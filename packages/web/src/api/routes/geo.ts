import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { forwardGeocode } from "../../services/geocode";

const KEY = process.env.GOOGLE_MAPS_API_KEY;

const AVG_KMH = 32; // urban average, used for haversine fallback

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/**
 * Compute live driving ETA from origin -> destination.
 * Uses Google Distance Matrix (traffic-aware) when a key is set,
 * otherwise falls back to a haversine + average-speed estimate.
 * Returns null when coords are invalid.
 */
export async function computeEta(
  oLat: number,
  oLng: number,
  dLat: number,
  dLng: number,
): Promise<{ etaMins: number; distanceKm: number; durationText: string; provider: string } | null> {
  if (
    [oLat, oLng, dLat, dLng].some(
      (n) => typeof n !== "number" || Number.isNaN(n),
    )
  )
    return null;

  if (KEY) {
    try {
      const url = new URL(
        "https://maps.googleapis.com/maps/api/distancematrix/json",
      );
      url.searchParams.set("origins", `${oLat},${oLng}`);
      url.searchParams.set("destinations", `${dLat},${dLng}`);
      url.searchParams.set("mode", "driving");
      url.searchParams.set("departure_time", "now"); // enables traffic model
      url.searchParams.set("key", KEY);
      const r = await fetch(url);
      const data = await r.json();
      const el = data.rows?.[0]?.elements?.[0];
      if (el?.status === "OK") {
        const dur = el.duration_in_traffic ?? el.duration;
        return {
          etaMins: Math.max(1, Math.round((dur.value ?? 0) / 60)),
          distanceKm: Math.round(((el.distance?.value ?? 0) / 1000) * 10) / 10,
          durationText: dur.text ?? "",
          provider: "google",
        };
      }
    } catch {
      // fall through to estimate
    }
  }

  const km = haversineKm(oLat, oLng, dLat, dLng);
  const etaMins = Math.max(1, Math.round((km / AVG_KMH) * 60));
  return {
    etaMins,
    distanceKm: Math.round(km * 10) / 10,
    durationText: `${etaMins} min`,
    provider: "estimate",
  };
}

/**
 * Compute a road-following driving route from origin -> destination.
 * Uses Google Directions API (traffic-aware) for an Uber/Lyft-style route line
 * plus live ETA. Returns the decoded path as [lat,lng] points so the client can
 * draw the actual streets the driver will take, not a straight line.
 * Falls back to a 2-point straight line + haversine ETA when no key/route.
 */
export async function computeRoute(
  oLat: number,
  oLng: number,
  dLat: number,
  dLng: number,
): Promise<{
  path: [number, number][];
  etaMins: number;
  distanceKm: number;
  durationText: string;
  provider: string;
} | null> {
  if ([oLat, oLng, dLat, dLng].some((n) => typeof n !== "number" || Number.isNaN(n)))
    return null;

  if (KEY) {
    try {
      const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
      url.searchParams.set("origin", `${oLat},${oLng}`);
      url.searchParams.set("destination", `${dLat},${dLng}`);
      url.searchParams.set("mode", "driving");
      url.searchParams.set("departure_time", "now");
      url.searchParams.set("key", KEY);
      const r = await fetch(url);
      const data = await r.json();
      const route = data.routes?.[0];
      const leg = route?.legs?.[0];
      if (route?.overview_polyline?.points && leg) {
        const path = decodePolyline(route.overview_polyline.points);
        const dur = leg.duration_in_traffic ?? leg.duration;
        return {
          path,
          etaMins: Math.max(1, Math.round((dur?.value ?? 0) / 60)),
          distanceKm: Math.round(((leg.distance?.value ?? 0) / 1000) * 10) / 10,
          durationText: dur?.text ?? "",
          provider: "google",
        };
      }
    } catch {
      // fall through to straight-line estimate
    }
  }

  const km = haversineKm(oLat, oLng, dLat, dLng);
  const etaMins = Math.max(1, Math.round((km / AVG_KMH) * 60));
  return {
    path: [
      [oLat, oLng],
      [dLat, dLng],
    ],
    etaMins,
    distanceKm: Math.round(km * 10) / 10,
    durationText: `${etaMins} min`,
    provider: "estimate",
  };
}

/** Decode a Google encoded polyline into [lat,lng] pairs. */
function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let b: number;
    let shift = 0;
    let result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

/**
 * Server-side proxy for Google Places so the API key never reaches the browser.
 * Falls back to OpenStreetMap Nominatim if no key is configured.
 */
export const geoRoutes = new Hono()
  // autocomplete: ?q=423 main
  .get("/autocomplete", requireAuth, async (c) => {
    const q = c.req.query("q")?.trim();
    if (!q || q.length < 3) return c.json({ predictions: [] }, 200);

    if (KEY) {
      const url = new URL("https://maps.googleapis.com/maps/api/place/autocomplete/json");
      url.searchParams.set("input", q);
      url.searchParams.set("key", KEY);
      url.searchParams.set("components", "country:ca|country:us");
      const r = await fetch(url);
      const data = await r.json();
      const predictions = (data.predictions || []).map((p: any) => ({
        placeId: p.place_id,
        description: p.description,
        main: p.structured_formatting?.main_text ?? p.description,
        secondary: p.structured_formatting?.secondary_text ?? "",
      }));
      return c.json({ predictions, provider: "google" }, 200);
    }

    // Nominatim fallback
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", q);
    url.searchParams.set("format", "json");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("limit", "6");
    const r = await fetch(url, { headers: { "User-Agent": "NVC360/1.0" } });
    const data = await r.json();
    const predictions = (data || []).map((p: any) => ({
      placeId: `osm:${p.lat},${p.lon}`,
      description: p.display_name,
      main: p.display_name.split(",")[0],
      secondary: p.display_name.split(",").slice(1).join(",").trim(),
      lat: parseFloat(p.lat),
      lng: parseFloat(p.lon),
    }));
    return c.json({ predictions, provider: "osm" }, 200);
  })
  // resolve a placeId to coordinates + formatted address
  .get("/details", requireAuth, async (c) => {
    const placeId = c.req.query("placeId");
    if (!placeId) return c.json({ message: "placeId required" }, 400);

    if (placeId.startsWith("osm:")) {
      const [lat, lng] = placeId.slice(4).split(",").map(Number);
      return c.json({ lat, lng, address: c.req.query("description") || "" }, 200);
    }

    if (KEY) {
      const url = new URL("https://maps.googleapis.com/maps/api/place/details/json");
      url.searchParams.set("place_id", placeId);
      url.searchParams.set("key", KEY);
      url.searchParams.set("fields", "geometry,formatted_address");
      const r = await fetch(url);
      const data = await r.json();
      const loc = data.result?.geometry?.location;
      return c.json({
        lat: loc?.lat ?? null,
        lng: loc?.lng ?? null,
        address: data.result?.formatted_address ?? "",
        provider: "google",
      }, 200);
    }
    return c.json({ message: "No geocoder configured" }, 500);
  })
  // forward geocode a free-text address. Delegates to services/geocode.ts so
  // this route and the booking-create paths share ONE implementation (and one
  // timeout policy) instead of two copies that can drift.
  .get("/geocode", requireAuth, async (c) => {
    const address = c.req.query("address")?.trim();
    if (!address) return c.json({ message: "address required" }, 400);
    const hit = await forwardGeocode(address);
    return c.json({ lat: hit?.lat ?? null, lng: hit?.lng ?? null, address: hit?.address ?? address }, 200);
  })
  // live driving ETA: ?oLat=&oLng=&dLat=&dLng=
  .get("/eta", requireAuth, async (c) => {
    const oLat = parseFloat(c.req.query("oLat") ?? "");
    const oLng = parseFloat(c.req.query("oLng") ?? "");
    const dLat = parseFloat(c.req.query("dLat") ?? "");
    const dLng = parseFloat(c.req.query("dLng") ?? "");
    const res = await computeEta(oLat, oLng, dLat, dLng);
    if (!res) return c.json({ message: "valid oLat,oLng,dLat,dLng required" }, 400);
    return c.json(res, 200);
  })
  // expose whether google is available (no key leak)
  .get("/config", requireAuth, (c) => c.json({ provider: KEY ? "google" : "osm" }, 200));
