/**
 * Pure export helpers with NO database import, so they can be unit-tested
 * without booting a libsql client: filename slugs and the Google Static Maps
 * route/site basemaps used in the job PDF.
 */
export type JobRoutePoint = { lat: number; lng: number; phase: string };

/* --------------------- tenant-aware export filenames ---------------------- */

/** Company name -> safe filename token ("BMD Materials" -> "bmd-materials").
 *  Strips anything that isn't a-z/0-9 so the result is safe in a
 *  Content-Disposition header and on every OS. */
export function slugifyName(name?: string | null): string {
  const s = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
  return s || "";
}

/* ------------------------- route basemap (static map) --------------------- */

/** Google encoded-polyline. Lets us put a few hundred GPS pings in a Static
 *  Maps URL without blowing the ~8k URL limit. */
function encodePolyline(points: { lat: number; lng: number }[]): string {
  let out = "";
  let prevLat = 0, prevLng = 0;
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (n >= 0x20) { s += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
    s += String.fromCharCode(n + 63);
    return s;
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5), lng = Math.round(p.lng * 1e5);
    out += enc(lat - prevLat) + enc(lng - prevLng);
    prevLat = lat; prevLng = lng;
  }
  return out;
}

/** Close-in basemap of the job site itself (zoom 17), so the report shows the
 *  actual street, driveway and building the tech stopped at — the wide route
 *  overview is fit to the whole trip, which is too zoomed out to read
 *  individual street names. Centered on the on-site pings when there are any,
 *  otherwise the last known position. Returns null on any failure. */
export async function fetchSiteBasemap(route: JobRoutePoint[]): Promise<Buffer | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  const clean = (route || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (!key || !clean.length) return null;
  const onsite = clean.filter((p) => p.phase === "onsite");
  const pool = onsite.length ? onsite : [clean[clean.length - 1]];
  const lat = pool.reduce((s, p) => s + p.lat, 0) / pool.length;
  const lng = pool.reduce((s, p) => s + p.lng, 0) / pool.length;
  const center = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  const params = [
    `center=${center}`,
    "zoom=17",
    "size=640x260",
    "scale=2",
    "format=png",
    "maptype=roadmap",
    `markers=${encodeURIComponent(`color:0xef4444|size:mid|${center}`)}`,
  ];
  if (onsite.length > 1) {
    const pts = thin(onsite, 60);
    params.push(`path=color:0xf59e0bff%7Cweight:4%7Cenc:${encodeURIComponent(encodePolyline(pts))}`);
  }
  const url = `https://maps.googleapis.com/maps/api/staticmap?${params.join("&")}&key=${key}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!resp.ok) return null;
    if (!(resp.headers.get("content-type") || "").includes("image/png")) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    return buf.length > 1000 ? buf : null;
  } catch {
    return null;
  }
}

/** Even-spaced downsample keeping the first and last point. */
function thin<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = (arr.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

const PHASE_HEX: Record<string, string> = {
  enroute: "0x0ea5e9",
  onsite: "0xf59e0b",
  return: "0x22c55e",
};

/** Real street-level basemap of the driven route, rendered by Google Static
 *  Maps at scale=2 (1280x800 px into a ~530pt box, so ~2.4x print density)
 *  with street names, and the GPS track drawn on top as one colored path per
 *  phase plus A/B start/finish markers.
 *
 *  The old PDF drew only a naked vector squiggle on a dark box — no streets,
 *  no scale, no context — which is unusable as evidence of where a tech
 *  actually drove. Returns null (caller falls back to that sketch) when the
 *  API key is missing or Google doesn't return an image, so an export never
 *  fails because of the map. */
export async function fetchRouteBasemap(
  route: JobRoutePoint[],
  jobAddress?: string,
): Promise<Buffer | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key || route.length < 2) return null;
  const clean = route.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (clean.length < 2) return null;

  // one path per contiguous phase run, so color changes where the phase does
  const runs: { phase: string; pts: JobRoutePoint[] }[] = [];
  for (const p of clean) {
    const last = runs[runs.length - 1];
    if (last && last.phase === p.phase) last.pts.push(p);
    else runs.push({ phase: p.phase, pts: last ? [last.pts[last.pts.length - 1], p] : [p] });
  }
  // budget the total number of points across all paths so the URL stays sane
  const budget = 300;
  const params: string[] = [
    "size=640x400",
    "scale=2",
    "format=png",
    "maptype=roadmap",
  ];
  for (const r of runs) {
    if (r.pts.length < 2) continue;
    const pts = thin(r.pts, Math.max(2, Math.floor(budget / runs.length)));
    const color = PHASE_HEX[r.phase] ?? "0x94a3b8";
    params.push(`path=color:${color}ff%7Cweight:5%7Cenc:${encodeURIComponent(encodePolyline(pts))}`);
  }
  const a = clean[0], b = clean[clean.length - 1];
  params.push(`markers=${encodeURIComponent(`color:0x0ea5e9|label:A|${a.lat.toFixed(6)},${a.lng.toFixed(6)}`)}`);
  params.push(`markers=${encodeURIComponent(`color:0xef4444|label:B|${b.lat.toFixed(6)},${b.lng.toFixed(6)}`)}`);
  void jobAddress; // reserved: could add a job-site marker once geocoded server-side
  const url = `https://maps.googleapis.com/maps/api/staticmap?${params.join("&")}&key=${key}`;
  if (url.length > 8000) return null;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!resp.ok) return null;
    if (!(resp.headers.get("content-type") || "").includes("image/png")) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    return buf.length > 1000 ? buf : null;
  } catch {
    return null;
  }
}

