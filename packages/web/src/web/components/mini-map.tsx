import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const pin = L.divIcon({
  className: "",
  html: `<div style="position:relative;width:30px;height:30px;display:flex;align-items:center;justify-content:center">
    <div style="position:absolute;width:30px;height:30px;border-radius:9999px;background:rgba(6,182,212,0.25)"></div>
    <div style="position:relative;width:18px;height:18px;border-radius:9999px;background:#06b6d4;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.4)"></div>
  </div>`,
  iconSize: [30, 30],
  iconAnchor: [15, 15],
});

export function MiniMap({
  lat,
  lng,
  className = "h-40 w-full rounded-lg overflow-hidden",
  zoom = 15,
}: {
  lat: number | null;
  lng: number | null;
  className?: string;
  zoom?: number;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    // fadeAnimation: false — avoids a Leaflet bug where cached tiles never
    // fire `load` (already `complete` before the listener attaches), leaving
    // the tile stuck at opacity:0 forever (blank map). See zones.tsx for detail.
    const map = L.map(elRef.current, {
      zoomControl: false,
      attributionControl: false,
      dragging: true,
      scrollWheelZoom: false,
      fadeAnimation: false,
    }).setView([lat ?? 49.8951, lng ?? -97.1384], zoom);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19,
    }).addTo(map);
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 150);
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // One-time map init (guarded by mapRef.current); position updates are
    // handled by the separate marker effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || lat == null || lng == null) return;
    map.setView([lat, lng], zoom, { animate: true });
    if (!markerRef.current) {
      markerRef.current = L.marker([lat, lng], { icon: pin }).addTo(map);
    } else {
      markerRef.current.setLatLng([lat, lng]);
    }
  }, [lat, lng, zoom]);

  return <div ref={elRef} className={className} style={{ zIndex: 0 }} />;
}
