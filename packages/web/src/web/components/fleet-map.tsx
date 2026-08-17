import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useWorkerNoun } from "../lib/use-brand";

export interface FleetTech {
  id: string;
  name: string;
  color: string;
  photoUrl?: string | null;
  status: string;
  lat?: number | null;
  lng?: number | null;
  skillClass?: string;
  task?: { title?: string; destLat?: number; destLng?: number; eta?: string | null; address?: string | null } | null;
  phone?: string | null;
  jobsToday?: number | null;
}

export interface FleetJob {
  id: string;
  title: string;
  status: string;
  color: string;
  lat?: number | null;
  lng?: number | null;
  address?: string | null;
  customerName?: string | null;
  techName?: string | null;
  scheduledAt?: string | null;
  priority?: string | null;
  total?: number | null;
}

interface FleetMapProps {
  techs: FleetTech[];
  jobs?: FleetJob[];
  showTechs?: boolean;
  showJobs?: boolean;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onSelectJob?: (id: string) => void;
  className?: string;
}

function techIcon(
  color: string,
  initials: string,
  active: boolean,
  dim: boolean,
  photoUrl?: string | null,
) {
  // Bigger + high-contrast: a white ring (photo avatars) / white border
  // (initials) makes the status-colored circle pop against the dark map
  // tiles instead of blending in, and the dot itself is now noticeably
  // larger than before.
  const SIZE = 52;
  const DOT = 38;
  const pulse = active
    ? `<div style="position:absolute;width:${SIZE + 10}px;height:${SIZE + 10}px;border-radius:9999px;background:${color}40;animation:pulse-ring 1.8s ease-out infinite"></div>`
    : "";
  const inner = photoUrl
    ? `<div style="position:relative;width:${DOT}px;height:${DOT}px;border-radius:9999px;border:4px solid ${color};box-shadow:0 0 0 2px #0c1220,0 4px 14px rgba(0,0,0,0.6);background-image:url('${photoUrl}');background-size:cover;background-position:center"></div>`
    : `<div style="position:relative;width:${DOT}px;height:${DOT}px;border-radius:9999px;background:${color};border:3px solid #ffffff;box-shadow:0 0 0 2px ${color}99,0 4px 14px rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;color:#051018;font-weight:800;font-size:13px;font-family:Inter,sans-serif">${initials}</div>`;
  return L.divIcon({
    className: "",
    html: `<div style="position:relative;width:${SIZE}px;height:${SIZE}px;display:flex;align-items:center;justify-content:center;opacity:${dim ? 0.45 : 1}">
      ${pulse}
      ${inner}
    </div>`,
    iconSize: [SIZE, SIZE],
    iconAnchor: [SIZE / 2, SIZE / 2],
  });
}

function esc(s: string | null | undefined) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );
}

function jobTooltip(j: FleetJob) {
  const when = j.scheduledAt
    ? new Date(j.scheduledAt).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;
  const statusLabel = (j.status ?? "").replace(/_/g, " ");
  const rows: string[] = [];
  if (when) rows.push(`<div style="display:flex;gap:6px;align-items:center"><span style="opacity:.6">🕑</span>${esc(when)}</div>`);
  if (j.customerName) rows.push(`<div style="display:flex;gap:6px;align-items:center"><span style="opacity:.6">👤</span>${esc(j.customerName ?? "")}</div>`);
  if (j.address) rows.push(`<div style="display:flex;gap:6px;align-items:flex-start"><span style="opacity:.6">📍</span><span>${esc(j.address ?? "")}</span></div>`);
  if (j.techName) rows.push(`<div style="display:flex;gap:6px;align-items:center"><span style="opacity:.6">👷</span>${esc(j.techName ?? "")}</div>`);
  else rows.push(`<div style="display:flex;gap:6px;align-items:center;color:#fbbf24"><span style="opacity:.6">👷</span>Unassigned</div>`);
  if (j.total != null) rows.push(`<div style="display:flex;gap:6px;align-items:center"><span style="opacity:.6">💲</span>${Number(j.total).toFixed(2)}</div>`);
  return `<div style="min-width:200px;max-width:260px;font-family:Inter,sans-serif;line-height:1.45">
    <div style="display:flex;align-items:center;gap:7px;margin-bottom:6px">
      <span style="width:8px;height:8px;border-radius:9999px;background:${j.color};flex:0 0 auto"></span>
      <b style="font-size:13px;color:#fff">${esc(j.title)}</b>
    </div>
    <div style="display:inline-block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:${j.color};background:${j.color}22;border-radius:6px;padding:2px 7px;margin-bottom:6px">${esc(statusLabel)}${j.priority ? " · " + esc(j.priority) : ""}</div>
    <div style="display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:#cbd5e1">${rows.join("")}</div>
    <div style="margin-top:7px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08);font-size:10.5px;color:#67e8f9;font-weight:600">Click to open work order →</div>
  </div>`;
}

function jobIcon(color: string) {
  return L.divIcon({
    className: "",
    html: `<div style="position:relative;width:30px;height:38px;display:flex;align-items:flex-start;justify-content:center;filter:drop-shadow(0 4px 8px rgba(0,0,0,0.55))">
      <svg width="30" height="38" viewBox="0 0 24 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 0C5.37 0 0 5.37 0 12c0 8.5 12 20 12 20s12-11.5 12-20C24 5.37 18.63 0 12 0z" fill="${color}" stroke="#0c1220" stroke-width="1.5"/>
        <circle cx="12" cy="12" r="4.5" fill="#0c1220"/>
      </svg>
    </div>`,
    iconSize: [30, 38],
    iconAnchor: [15, 36],
  });
}

const STATUS_META: Record<string, { label: string; color: string }> = {
  enroute: { label: "En route", color: "#38bdf8" },
  onsite: { label: "On site", color: "#f59e0b" },
  busy: { label: "Busy", color: "#ef4444" },
  available: { label: "Available", color: "#22c55e" },
  idle: { label: "Idle", color: "#94a3b8" },
  offline: { label: "Offline", color: "#64748b" },
};

function techTooltip(t: FleetTech, noun = "Technician") {
  const meta = STATUS_META[t.status] ?? { label: (t.status ?? "unknown").replace(/_/g, " "), color: t.color };
  const rows: string[] = [];
  if (t.skillClass) rows.push(`<div style="display:flex;gap:6px;align-items:center"><span style="opacity:.6">🛠️</span>${esc(t.skillClass)}</div>`);
  if (t.task?.title) {
    rows.push(`<div style="display:flex;gap:6px;align-items:flex-start"><span style="opacity:.6">📋</span><span>${esc(t.task.title)}</span></div>`);
    if (t.task.address) rows.push(`<div style="display:flex;gap:6px;align-items:flex-start"><span style="opacity:.6">📍</span><span>${esc(t.task.address)}</span></div>`);
    if (t.task.eta) rows.push(`<div style="display:flex;gap:6px;align-items:center;color:#67e8f9"><span style="opacity:.6">⏱️</span>ETA ${esc(t.task.eta)}</div>`);
  } else {
    rows.push(`<div style="display:flex;gap:6px;align-items:center;opacity:.7"><span style="opacity:.6">📋</span>No active task</div>`);
  }
  if (t.jobsToday != null) rows.push(`<div style="display:flex;gap:6px;align-items:center"><span style="opacity:.6">✅</span>${t.jobsToday} job${t.jobsToday === 1 ? "" : "s"} today</div>`);
  const initials2 = (t.name || "?").split(" ").map((s) => s[0] || "").slice(0, 2).join("");
  const avatar = t.photoUrl
    ? `<div style="width:30px;height:30px;border-radius:9999px;background-image:url('${t.photoUrl}');background-size:cover;background-position:center;flex:0 0 auto"></div>`
    : `<div style="width:30px;height:30px;border-radius:9999px;background:${t.color};display:flex;align-items:center;justify-content:center;color:#051018;font-weight:800;font-size:11px;flex:0 0 auto">${esc(initials2)}</div>`;
  return `<div style="min-width:210px;max-width:270px;font-family:Inter,sans-serif;line-height:1.45">
    <div style="display:flex;align-items:center;gap:9px;margin-bottom:7px">
      ${avatar}
      <div style="min-width:0">
        <b style="font-size:13px;color:#fff;display:block">${esc(t.name)}</b>
        <span style="display:inline-block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:${meta.color};background:${meta.color}22;border-radius:6px;padding:1px 7px;margin-top:2px">● ${esc(meta.label)}</span>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:#cbd5e1">${rows.join("")}</div>
    <div style="margin-top:7px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08);font-size:10.5px;color:#67e8f9;font-weight:600">Click to open ${noun.toLowerCase()} →</div>
  </div>`;
}

export function FleetMap({
  techs,
  jobs = [],
  showTechs = true,
  showJobs = true,
  selectedId,
  onSelect,
  onSelectJob,
  className,
}: FleetMapProps) {
  const { noun } = useWorkerNoun();
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markers = useRef<Record<string, L.Marker>>({});
  const jobMarkers = useRef<Record<string, L.Marker>>({});

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    // fadeAnimation: false — avoids a Leaflet bug where cached tiles never
    // fire `load` (already `complete` before the listener attaches), leaving
    // the tile stuck at opacity:0 forever (blank map). See zones.tsx for detail.
    // zoomControl: false + an explicit bottom-left control. Leaflet's default
    // puts +/- at the TOP LEFT, exactly where this page floats its glass
    // toolbar (Map / Drivers-Jobs-Both / date range / status legend), so the
    // white 44x88 zoom stack sat underneath the pills and poked out at every
    // window width. Bottom left is clear of both the toolbar and the tech
    // detail panel (top right) at every breakpoint.
    const map = L.map(elRef.current, {
      zoomControl: false,
      attributionControl: false,
      fadeAnimation: false,
    }).setView([43.6532, -79.3832], 12);
    L.control.zoom({ position: "bottomleft" }).addTo(map);
    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      { maxZoom: 19 },
    ).addTo(map);
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 200);
    return () => {
      map.remove();
      mapRef.current = null;
      markers.current = {};
      jobMarkers.current = {};
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const seen = new Set<string>();
    const pts: [number, number][] = [];

    for (const t of showTechs ? techs : []) {
      if (t.lat == null || t.lng == null) continue;
      seen.add(t.id);
      pts.push([t.lat, t.lng]);
      const initials = (t.name || "?")
        .split(" ")
        .map((s) => s[0] || "")
        .slice(0, 2)
        .join("");
      const active = ["enroute", "onsite", "busy"].includes(t.status);
      const dim = t.status === "offline";
      // Marker color reflects LIVE STATUS (green = available, red = busy,
      // etc.) — not the tech's fixed per-person identity color (t.color),
      // which is assigned once at random when they're added to the team and
      // has nothing to do with whether they're actually free right now. That
      // mismatch is what made an available tech's dot look like a faint,
      // arbitrary color instead of a clear, unmistakable "available" signal.
      const statusColor = STATUS_META[t.status]?.color ?? t.color;
      const icon = techIcon(statusColor, initials, active, dim && selectedId !== t.id, t.photoUrl);
      const tip = techTooltip(t, noun);
      if (markers.current[t.id]) {
        markers.current[t.id].setLatLng([t.lat, t.lng]).setIcon(icon);
        markers.current[t.id].setTooltipContent(tip);
        markers.current[t.id].off("click");
        markers.current[t.id].on("click", () => onSelect?.(t.id));
      } else {
        const m = L.marker([t.lat, t.lng], { icon, riseOnHover: true }).addTo(map);
        m.on("click", () => onSelect?.(t.id));
        m.on("mouseover", function (this: L.Marker) { this.setZIndexOffset(1000); });
        m.on("mouseout", function (this: L.Marker) { this.setZIndexOffset(0); });
        m.bindTooltip(tip, { direction: "top", offset: [0, -24], className: "nvc-tip", sticky: false });
        markers.current[t.id] = m;
      }
    }
    // remove stale
    for (const id of Object.keys(markers.current)) {
      if (!seen.has(id)) {
        map.removeLayer(markers.current[id]);
        delete markers.current[id];
      }
    }
    if (pts.length && !(mapRef.current as unknown as { _loaded_once?: boolean })._loaded_once) {
      map.fitBounds(L.latLngBounds(pts).pad(0.25));
      (mapRef.current as any)._loaded_once = true;
    }
  }, [
	techs,
	selectedId,
	showTechs,
	onSelect,
	noun
]);

  // job markers
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const seen = new Set<string>();
    for (const j of showJobs ? jobs : []) {
      if (j.lat == null || j.lng == null) continue;
      seen.add(j.id);
      const icon = jobIcon(j.color);
      const tip = jobTooltip(j);
      if (jobMarkers.current[j.id]) {
        jobMarkers.current[j.id].setLatLng([j.lat, j.lng]).setIcon(icon);
        jobMarkers.current[j.id].setTooltipContent(tip);
        jobMarkers.current[j.id].off("click");
        jobMarkers.current[j.id].on("click", () => onSelectJob?.(j.id));
      } else {
        const m = L.marker([j.lat, j.lng], { icon, riseOnHover: true }).addTo(map);
        m.on("click", () => onSelectJob?.(j.id));
        m.on("mouseover", function (this: L.Marker) { this.setZIndexOffset(1000); });
        m.on("mouseout", function (this: L.Marker) { this.setZIndexOffset(0); });
        m.bindTooltip(tip, { direction: "top", offset: [0, -34], className: "nvc-tip", sticky: false });
        jobMarkers.current[j.id] = m;
      }
    }
    for (const id of Object.keys(jobMarkers.current)) {
      if (!seen.has(id)) {
        map.removeLayer(jobMarkers.current[id]);
        delete jobMarkers.current[id];
      }
    }
  }, [
	jobs,
	showJobs,
	onSelectJob
]);

  // pan to selected
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedId) return;
    const t = techs.find((x) => x.id === selectedId);
    if (t?.lat != null && t.lng != null) {
      map.flyTo([t.lat, t.lng], 14, { duration: 0.6 });
    }
  }, [selectedId, techs]);

  return <div ref={elRef} className={className} style={{ zIndex: 0 }} />;
}
