import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

interface LatLng {
  lat: number;
  lng: number;
}

interface LiveMapProps {
  rider?: LatLng | null;
  destination?: LatLng | null;
  /** road-following route points from driver -> destination (Uber-style) */
  route?: LatLng[] | null;
  /** live ETA in minutes, rendered as a badge on the driver marker */
  etaMins?: number | null;
  riderLabel?: string;
  className?: string;
}

// driver marker with an Uber/Lyft-style ETA pill floating above the pin
function makeRiderIcon(etaMins?: number | null) {
  const badge =
    etaMins != null
      ? `<div style="position:absolute;bottom:46px;left:50%;transform:translateX(-50%);white-space:nowrap;background:#0b1220;color:#fff;font:700 11px/1 system-ui,sans-serif;padding:5px 9px;border-radius:9px;box-shadow:0 4px 14px rgba(0,0,0,0.45);border:1px solid rgba(255,255,255,0.12)">
        ${etaMins} min
        <div style="position:absolute;top:100%;left:50%;transform:translateX(-50%);width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:5px solid #0b1220"></div>
      </div>`
      : "";
  return L.divIcon({
    className: "",
    html: `<div style="position:relative;width:44px;height:44px;display:flex;align-items:center;justify-content:center">
      ${badge}
      <div style="position:absolute;width:44px;height:44px;border-radius:9999px;background:rgba(14,165,233,0.25);animation:pulse-ring 1.8s ease-out infinite"></div>
      <div style="position:relative;width:34px;height:34px;border-radius:9999px;background:#0ea5e9;border:3px solid #fff;box-shadow:0 4px 12px rgba(0,0,0,0.25);display:flex;align-items:center;justify-content:center;color:#fff">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>
      </div>
    </div>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
}

const homeIcon = L.divIcon({
  className: "",
  html: `<div style="width:36px;height:36px;border-radius:50% 50% 50% 0;background:#2563eb;transform:rotate(-45deg);border:3px solid #fff;box-shadow:0 4px 12px rgba(0,0,0,0.25);display:flex;align-items:center;justify-content:center">
    <svg xmlns="http://www.w3.org/2000/svg" style="transform:rotate(45deg)" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
  </div>`,
  iconSize: [36, 36],
  iconAnchor: [18, 36],
});

export function LiveMap({ rider, destination, route, etaMins, className }: LiveMapProps) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const riderMarker = useRef<L.Marker | null>(null);
  const destMarker = useRef<L.Marker | null>(null);
  const lineRef = useRef<L.Polyline | null>(null);
  const lastEta = useRef<number | null | undefined>(undefined);
  const animRef = useRef<number | null>(null);

  // smoothly slide the driver marker between GPS fixes instead of teleporting
  function animateMarker(to: L.LatLngExpression) {
    const m = riderMarker.current;
    const map = mapRef.current;
    if (!m || !map) return;
    const from = m.getLatLng();
    const target = L.latLng(to);
    // skip animation for big jumps (first fix / GPS glitch)
    if (map.distance(from, target) > 2000) {
      m.setLatLng(target);
      return;
    }
    const start = performance.now();
    const dur = 900;
    if (animRef.current) cancelAnimationFrame(animRef.current);
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const e = t * (2 - t); // easeOutQuad
      m.setLatLng([
        from.lat + (target.lat - from.lat) * e,
        from.lng + (target.lng - from.lng) * e,
      ]);
      if (t < 1) animRef.current = requestAnimationFrame(step);
    };
    animRef.current = requestAnimationFrame(step);
  }

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const center = destination ?? rider ?? { lat: 43.6532, lng: -79.3832 };
    // fadeAnimation: false — avoids a Leaflet bug where cached tiles never
    // fire `load` (already `complete` before the listener attaches), leaving
    // the tile stuck at opacity:0 forever (blank map). See zones.tsx for detail.
    const map = L.map(elRef.current, {
      zoomControl: true,
      attributionControl: false,
      zoomAnimation: true,
      fadeAnimation: false,
    }).setView([center.lat, center.lng], 13);
    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      { maxZoom: 19 },
    ).addTo(map);
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 200);
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      map.remove();
      mapRef.current = null;
      // reset layer refs so they get re-created on the fresh map (StrictMode remount)
      riderMarker.current = null;
      destMarker.current = null;
      lineRef.current = null;
      lastEta.current = undefined;
    };
    // Map is initialised exactly once (guarded by mapRef.current). Re-running
    // on rider/destination changes would tear down and rebuild the whole map
    // on every position update, so this effect is intentionally mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (destination) {
      if (!destMarker.current) {
        destMarker.current = L.marker([destination.lat, destination.lng], {
          icon: homeIcon,
        }).addTo(map);
      } else {
        destMarker.current.setLatLng([destination.lat, destination.lng]);
      }
    }

    if (rider) {
      if (!riderMarker.current) {
        riderMarker.current = L.marker([rider.lat, rider.lng], {
          icon: makeRiderIcon(etaMins),
        }).addTo(map);
        lastEta.current = etaMins;
      } else {
        animateMarker([rider.lat, rider.lng]);
        // refresh the ETA badge only when the value actually changes
        if (etaMins !== lastEta.current) {
          riderMarker.current.setIcon(makeRiderIcon(etaMins));
          lastEta.current = etaMins;
        }
      }
    }

    // road-following route line (falls back to straight 2-pt line server-side)
    if (rider && destination) {
      const pts: [number, number][] =
        route && route.length > 1
          ? route.map((p) => [p.lat, p.lng])
          : [
              [rider.lat, rider.lng],
              [destination.lat, destination.lng],
            ];
      if (!lineRef.current) {
        lineRef.current = L.polyline(pts, {
          color: "#0ea5e9",
          weight: 5,
          opacity: 0.9,
          lineJoin: "round",
          lineCap: "round",
        }).addTo(map);
      } else {
        lineRef.current.setLatLngs(pts);
      }
      map.fitBounds(L.latLngBounds(pts).pad(0.25), { animate: true });
    } else if (rider) {
      map.panTo([rider.lat, rider.lng], { animate: true });
    }
  }, [
	rider?.lat,
	rider?.lng,
	destination?.lat,
	destination?.lng,
	etaMins,
	route,
	rider,
	destination
]);

  return <div ref={elRef} className={className} style={{ zIndex: 0 }} />;
}
