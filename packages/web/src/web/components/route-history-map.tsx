// ─── Driven route replay map ──────────────────────────────────────────────
// Static (non-live) map for the completed-job report: draws the technician's
// actual GPS breadcrumb trail as a colored polyline (blue = en route to the
// job, amber = moving around on site, green = return leg), with start/end
// pins. Distinct from live-map.tsx, which animates a single live position —
// this replays history that already happened.
import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export interface RoutePing {
  lat: number;
  lng: number;
  phase: string;
  createdAt: string | number | Date;
}

const PHASE_COLOR: Record<string, string> = {
  enroute: "#0ea5e9",
  onsite: "#f59e0b",
  return: "#22c55e",
};

function pinIcon(color: string, label: string) {
  return L.divIcon({
    className: "",
    html: `<div style="position:relative;width:30px;height:30px;border-radius:9999px;background:${color};border:3px solid #fff;box-shadow:0 3px 10px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:12px;font-family:Inter,sans-serif">${label}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

export function RouteHistoryMap({
  pings,
  destination,
  className,
}: {
  pings: RoutePing[];
  destination?: { lat: number; lng: number } | null;
  className?: string;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layersRef = useRef<L.Layer[]>([]);

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, {
      zoomControl: true,
      attributionControl: false,
    }).setView([pings[0]?.lat ?? 0, pings[0]?.lng ?? 0], 13);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19,
    }).addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    layersRef.current.forEach((l) => map.removeLayer(l));
    layersRef.current = [];

    if (!pings.length) return;

    // Split into contiguous same-phase segments so the polyline color
    // changes exactly where the driver's phase changed (enroute -> onsite ->
    // return), instead of one flat-colored line for the whole trip.
    const segments: { phase: string; pts: [number, number][] }[] = [];
    for (const p of pings) {
      const last = segments[segments.length - 1];
      if (last && last.phase === p.phase) last.pts.push([p.lat, p.lng]);
      else segments.push({ phase: p.phase, pts: [[p.lat, p.lng]] });
    }
    // connect segments so the line doesn't have visible gaps at the boundary
    for (let i = 1; i < segments.length; i++) {
      segments[i].pts.unshift(segments[i - 1].pts[segments[i - 1].pts.length - 1]);
    }
    const allBounds: [number, number][] = [];
    for (const seg of segments) {
      if (seg.pts.length < 2) continue;
      const line = L.polyline(seg.pts, {
        color: PHASE_COLOR[seg.phase] ?? "#94a3b8",
        weight: 4,
        opacity: 0.9,
      }).addTo(map);
      layersRef.current.push(line);
      allBounds.push(...seg.pts);
    }

    const start = pings[0];
    const end = pings[pings.length - 1];
    const startMarker = L.marker([start.lat, start.lng], { icon: pinIcon("#0ea5e9", "A") }).addTo(map);
    layersRef.current.push(startMarker);
    allBounds.push([start.lat, start.lng]);

    if (destination) {
      const destMarker = L.marker([destination.lat, destination.lng], { icon: pinIcon("#ef4444", "B") }).addTo(map);
      layersRef.current.push(destMarker);
      allBounds.push([destination.lat, destination.lng]);
    } else {
      const endMarker = L.marker([end.lat, end.lng], { icon: pinIcon("#ef4444", "B") }).addTo(map);
      layersRef.current.push(endMarker);
      allBounds.push([end.lat, end.lng]);
    }

    if (allBounds.length > 1) map.fitBounds(L.latLngBounds(allBounds).pad(0.15));
    else map.setView(allBounds[0], 15);
  }, [pings, destination]);

  return <div ref={elRef} className={className ?? "h-full w-full"} />;
}
