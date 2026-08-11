import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api } from "../../lib/api";
import { activate } from "../../lib/utils";
import { FullLoader } from "../../components/loader";
import { PageWrap } from "../../components/brand";
import { PageHead } from "./shell";
import { Modal, Field, inputCls, BtnPrimary, BtnGhost, ConfirmModal } from "../../components/modal";
import { MapPin, Pencil, Trash2, MousePointer2, Check, X, Pentagon, Square, Circle } from "lucide-react";
import { circleToPolygon, rectToPolygon } from "../../../shared/zone-utils";

type LatLng = [number, number];
type DrawMode = "polygon" | "rectangle" | "circle";
type Zone = {
  id: string;
  name: string;
  color: string;
  polygon: LatLng[];
  surgeMultiplier: number;
  active: boolean;
};

const FALLBACK_CENTER: LatLng = [49.8951, -97.1384]; // Winnipeg

export default function AdminZones() {
  const qc = useQueryClient();
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layersRef = useRef<Record<string, L.Layer>>({});
  const draftLayerRef = useRef<L.Layer | null>(null);
  const draftMarkersRef = useRef<L.CircleMarker[]>([]);

  const [drawing, setDrawing] = useState(false);
  const [drawMode, setDrawMode] = useState<DrawMode>("polygon");
  const [draft, setDraft] = useState<LatLng[]>([]); // polygon points
  const [rectA, setRectA] = useState<LatLng | null>(null); // rectangle first corner
  const [circleCenter, setCircleCenter] = useState<LatLng | null>(null); // circle center
  const [circleEdge, setCircleEdge] = useState<LatLng | null>(null); // circle radius point
  const [editor, setEditor] = useState<{ open: boolean; zone: Zone | null; polygon: LatLng[] }>({
    open: false,
    zone: null,
    polygon: [],
  });
  const [delZone, setDelZone] = useState<Zone | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // Tracks when the Leaflet map instance is actually mounted and ready to draw
  // on. The zone-rendering effect depends on this (not just on `zones`) so it
  // reliably retries once the map exists — fixes a race where zones finished
  // loading from the server BEFORE the map had finished initializing, silently
  // never got drawn, and would only reappear after some unrelated re-render.
  const [mapReady, setMapReady] = useState(false);
  const zonesFitDoneRef = useRef(false);

  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;
  const drawModeRef = useRef(drawMode);
  drawModeRef.current = drawMode;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const rectARef = useRef(rectA);
  rectARef.current = rectA;
  const circleCenterRef = useRef(circleCenter);
  circleCenterRef.current = circleCenter;

  // Fetch company settings for map center
  const settingsQ = useQuery({
    queryKey: ["settings"],
    queryFn: async () => (await api.settings.$get()).json(),
  });
  const _companyCenter: LatLng = useMemo(() => {
    const s = (settingsQ.data as any)?.settings;
    if (s?.lat && s?.lng && Math.abs(s.lat) > 0.001) return [s.lat, s.lng];
    return FALLBACK_CENTER;
  }, [settingsQ.data]);

  const zonesQ = useQuery({
    queryKey: ["zones"],
    queryFn: async () => (await api.zones.$get()).json(),
  });

  const createM = useMutation({
    mutationFn: async (body: Partial<Zone>) =>
      (await api.zones.$post({ json: body as any })).json(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["zones"] });
      closeEditor();
    },
  });
  const updateM = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: Partial<Zone> }) =>
      (await api.zones[":id"].$put({ param: { id }, json: body as any })).json(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["zones"] });
      closeEditor();
    },
  });
  const deleteM = useMutation({
    mutationFn: async (id: string) => api.zones[":id"].$delete({ param: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["zones"] });
      setDelZone(null);
    },
  });

  const zones: Zone[] = useMemo(
    () => (zonesQ.data as any)?.zones ?? [],
    [zonesQ.data],
  );

  // init map (runs once after settings resolve so we can use companyCenter)
  const mapInitRef = useRef(false);
  useEffect(() => {
    if (!elRef.current || mapInitRef.current || settingsQ.isLoading) return;
    mapInitRef.current = true;

    const el = elRef.current as HTMLDivElement & { _leaflet_id?: number };
    if (el._leaflet_id != null) {
      delete el._leaflet_id;
      while (el.firstChild) el.removeChild(el.firstChild);
    }

    const center: LatLng = (() => {
      const s = (settingsQ.data as any)?.settings;
      if (s?.lat && s?.lng && Math.abs(s.lat) > 0.001) return [s.lat, s.lng] as LatLng;
      return FALLBACK_CENTER;
    })();

    // fadeAnimation: false — Leaflet's tile fade-in relies on a tile's `load`
    // event to flip its opacity 0->1. When a tile is served from the browser
    // cache (e.g. switching tenants that resolve to the same/nearby fallback
    // coordinates), `complete` can already be true before Leaflet attaches its
    // listener, so `load` never fires and the tile stays invisible forever —
    // a blank map even though tiles are fully loaded and positioned correctly.
    // Disabling the fade removes the opacity transition entirely so a tile is
    // visible immediately regardless of cache timing.
    const map = L.map(el, { zoomControl: true, attributionControl: false, fadeAnimation: false }).setView(center, 11);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 19 }).addTo(map);

    map.on("click", (e: L.LeafletMouseEvent) => {
      if (!drawingRef.current) return;
      const pt: LatLng = [e.latlng.lat, e.latlng.lng];
      const mode = drawModeRef.current;

      if (mode === "polygon") {
        setDraft((d) => [...d, pt]);
      } else if (mode === "rectangle") {
        if (!rectARef.current) {
          setRectA(pt);
        } else {
          // second click — finish rectangle
          const poly = rectToPolygon(rectARef.current[0], rectARef.current[1], pt[0], pt[1]);
          setRectA(null);
          setDrawing(false);
          setEditor({ open: true, zone: null, polygon: poly });
        }
      } else if (mode === "circle") {
        if (!circleCenterRef.current) {
          setCircleCenter(pt);
        } else {
          // second click — finish circle
          const cx = circleCenterRef.current[0];
          const cy = circleCenterRef.current[1];
          // compute radius in meters
          const dx = (pt[1] - cy) * 111320 * Math.cos((cx * Math.PI) / 180);
          const dy = (pt[0] - cx) * 111320;
          const radiusM = Math.sqrt(dx * dx + dy * dy);
          const poly = circleToPolygon(cx, cy, radiusM);
          setCircleCenter(null);
          setCircleEdge(null);
          setDrawing(false);
          setEditor({ open: true, zone: null, polygon: poly });
        }
      }
    });

    // mousemove for live preview of rect/circle second point
    map.on("mousemove", (e: L.LeafletMouseEvent) => {
      if (!drawingRef.current) return;
      const mode = drawModeRef.current;
      if (mode === "rectangle" && rectARef.current) {
        // preview handled via state update — throttle via animation frame
        const pt: LatLng = [e.latlng.lat, e.latlng.lng];
        setDraft([pt]); // abuse draft to carry hover point for rect preview
      } else if (mode === "circle" && circleCenterRef.current) {
        const pt: LatLng = [e.latlng.lat, e.latlng.lng];
        setCircleEdge(pt);
      }
    });

    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 150);
    setMapReady(true);
    return () => {
      map.remove();
      mapRef.current = null;
      mapInitRef.current = false;
      setMapReady(false);
    };
  }, [settingsQ.isLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // render saved zones
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    Object.values(layersRef.current).forEach((l) => l.remove());
    layersRef.current = {};
    const drawnLayers: L.Polygon[] = [];
    zones.forEach((z) => {
      if (!z.polygon || z.polygon.length < 3) return;
      const poly = L.polygon(z.polygon as L.LatLngExpression[], {
        color: z.color,
        weight: 2,
        fillOpacity: z.active ? 0.18 : 0.05,
        dashArray: z.active ? undefined : "6 6",
      }).addTo(map);
      poly.on("click", () => {
        if (drawingRef.current) return;
        setSelected(z.id);
      });
      poly.bindTooltip(`${z.name}${z.surgeMultiplier !== 1 ? ` · ${z.surgeMultiplier}×` : ""}`, { sticky: true });
      layersRef.current[z.id] = poly;
      drawnLayers.push(poly);
    });
    // First time zones show up on a freshly-opened map, frame them all in view
    // instead of relying on the default company-center zoom — makes sure a
    // zone (or combination of zones) is always visible/identifiable on open,
    // even if it's far from the default center or larger/smaller than expected.
    if (drawnLayers.length && !zonesFitDoneRef.current && !drawingRef.current) {
      zonesFitDoneRef.current = true;
      const group = L.featureGroup(drawnLayers);
      map.fitBounds(group.getBounds(), { padding: [40, 40], maxZoom: 13 });
    }
  }, [zones, drawing, mapReady]);

  // render draft polygon preview
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    draftLayerRef.current?.remove();
    draftLayerRef.current = null;
    draftMarkersRef.current.forEach((m) => m.remove());
    draftMarkersRef.current = [];

    if (drawMode === "polygon") {
      if (draft.length >= 2) {
        draftLayerRef.current = L.polygon(draft as L.LatLngExpression[], {
          color: "#06b6d4",
          weight: 2,
          dashArray: "5 5",
          fillOpacity: 0.12,
        }).addTo(map);
      }
      draft.forEach((p) => {
        const m = L.circleMarker(p, { radius: 5, color: "#06b6d4", fillColor: "#0e7490", fillOpacity: 1, weight: 2 }).addTo(map);
        draftMarkersRef.current.push(m);
      });
    } else if (drawMode === "rectangle" && rectA && draft.length > 0) {
      const hoverPt = draft[0]; // hover point stored in draft
      const poly = rectToPolygon(rectA[0], rectA[1], hoverPt[0], hoverPt[1]);
      draftLayerRef.current = L.polygon(poly as L.LatLngExpression[], {
        color: "#f59e0b",
        weight: 2,
        dashArray: "5 5",
        fillOpacity: 0.12,
      }).addTo(map);
      const m = L.circleMarker(rectA, { radius: 6, color: "#f59e0b", fillColor: "#d97706", fillOpacity: 1, weight: 2 }).addTo(map);
      draftMarkersRef.current.push(m);
    } else if (drawMode === "circle" && circleCenter) {
      const edge = circleEdge;
      if (edge) {
        const cx = circleCenter[0], cy = circleCenter[1];
        const dx = (edge[1] - cy) * 111320 * Math.cos((cx * Math.PI) / 180);
        const dy = (edge[0] - cx) * 111320;
        const radiusM = Math.sqrt(dx * dx + dy * dy);
        const poly = circleToPolygon(cx, cy, radiusM, 64);
        draftLayerRef.current = L.polygon(poly as L.LatLngExpression[], {
          color: "#8b5cf6",
          weight: 2,
          dashArray: "5 5",
          fillOpacity: 0.12,
        }).addTo(map);
      }
      const m = L.circleMarker(circleCenter, { radius: 7, color: "#8b5cf6", fillColor: "#6d28d9", fillOpacity: 1, weight: 2 }).addTo(map);
      draftMarkersRef.current.push(m);
    }
  }, [draft, rectA, circleCenter, circleEdge, drawMode]);

  function startDraw(mode: DrawMode) {
    setSelected(null);
    setDraft([]);
    setRectA(null);
    setCircleCenter(null);
    setCircleEdge(null);
    setDrawMode(mode);
    setDrawing(true);
  }
  function cancelDraw() {
    setDrawing(false);
    setDraft([]);
    setRectA(null);
    setCircleCenter(null);
    setCircleEdge(null);
  }
  function finishPolygon() {
    if (draft.length < 3) return;
    setDrawing(false);
    setEditor({ open: true, zone: null, polygon: draft });
    setDraft([]);
  }
  function closeEditor() {
    setEditor({ open: false, zone: null, polygon: [] });
    setDraft([]);
    setRectA(null);
    setCircleCenter(null);
    setCircleEdge(null);
  }
  function editZone(z: Zone) {
    setEditor({ open: true, zone: z, polygon: z.polygon });
  }

  const loadingMap = zonesQ.isLoading || settingsQ.isLoading;
  if (loadingMap && !mapRef.current) return <FullLoader label="Loading service zones…" />;

  const sel = zones.find((z) => z.id === selected) || null;

  const drawingHint = () => {
    if (drawMode === "polygon") return `Click map to add points · ${draft.length} placed`;
    if (drawMode === "rectangle") return rectA ? "Click second corner to finish" : "Click first corner";
    if (drawMode === "circle") return circleCenter ? "Click any point to set radius" : "Click to set center";
    return "";
  };

  return (
    <PageWrap>
      <PageHead
        title="Service Zones"
        subtitle="Draw coverage areas & set surge pricing"
        actions={
          drawing ? (
            <div className="flex items-center gap-2">
              <BtnGhost onClick={cancelDraw}><X className="h-4 w-4 mr-1" /> Cancel</BtnGhost>
              {drawMode === "polygon" && (
                <BtnPrimary disabled={draft.length < 3} onClick={finishPolygon}>
                  <Check className="h-4 w-4 mr-1" /> Done ({draft.length} pts)
                </BtnPrimary>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <DrawBtn icon={<Pentagon className="h-3.5 w-3.5" />} label="Polygon" onClick={() => startDraw("polygon")} />
              <DrawBtn icon={<Square className="h-3.5 w-3.5" />} label="Rectangle" onClick={() => startDraw("rectangle")} />
              <DrawBtn icon={<Circle className="h-3.5 w-3.5" />} label="Circle" onClick={() => startDraw("circle")} />
            </div>
          )
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="nvc-card relative overflow-hidden p-0">
          {drawing && (
            <div className="absolute left-1/2 top-3 z-[500] -translate-x-1/2 rounded-full bg-brand/90 px-4 py-1.5 text-xs font-semibold text-white shadow-lg backdrop-blur flex items-center gap-2">
              <MousePointer2 className="h-3.5 w-3.5" />
              {drawingHint()}
            </div>
          )}
          <div ref={elRef} className="h-[560px] w-full" style={{ zIndex: 0 }} />
        </div>

        <div className="space-y-3">
          <div className="nvc-card p-4">
            <p className="mb-3 text-xs uppercase tracking-wide text-slate-500">{zones.length} zones</p>
            {zones.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-500">
                No zones yet. Use <strong className="text-slate-300">Polygon</strong>,{" "}
                <strong className="text-slate-300">Rectangle</strong>, or{" "}
                <strong className="text-slate-300">Circle</strong> to draw a coverage area.
              </p>
            ) : (
              <div className="space-y-2">
                {zones.map((z) => (
                  <div
                    key={z.id}
                    {...activate(() => {
                      setSelected(z.id);
                      const l = layersRef.current[z.id] as L.Polygon | undefined;
                      if (l && mapRef.current) mapRef.current.fitBounds((l as L.Polygon).getBounds(), { padding: [40, 40] });
                    })}
                    aria-label={`View zone ${z.name}`}
                    className={`group flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 transition ${
                      selected === z.id ? "border-brand/50 bg-brand/10" : "border-white/5 bg-white/[0.02] hover:bg-white/[0.05]"
                    }`}
                  >
                    <span className="h-3.5 w-3.5 flex-shrink-0 rounded-sm" style={{ background: z.color }} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-white">{z.name}</p>
                      <p className="text-[11px] text-slate-500">
                        {z.surgeMultiplier !== 1 ? `${z.surgeMultiplier}× surge · ` : ""}
                        {z.active ? "Active" : "Inactive"}
                      </p>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); editZone(z); }} aria-label={`Edit ${z.name}`} title={`Edit ${z.name}`} className="rounded-lg p-1.5 text-slate-400 opacity-0 transition hover:bg-white/10 hover:text-white group-hover:opacity-100">
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); setDelZone(z); }} aria-label={`Delete ${z.name}`} title={`Delete ${z.name}`} className="rounded-lg p-1.5 text-slate-400 opacity-0 transition hover:bg-rose-500/15 hover:text-rose-400 group-hover:opacity-100">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {sel && (
            <div className="nvc-card p-4">
              <div className="mb-2 flex items-center gap-2">
                <MapPin className="h-4 w-4" style={{ color: sel.color }} />
                <p className="font-semibold text-white">{sel.name}</p>
              </div>
              <dl className="space-y-1 text-sm">
                <Row k="Surge multiplier" v={`${sel.surgeMultiplier}×`} />
                <Row k="Status" v={sel.active ? "Active" : "Inactive"} />
                <Row k="Boundary pts" v={String(sel.polygon.length)} />
              </dl>
              <button onClick={() => editZone(sel)} className="mt-3 w-full rounded-xl bg-white/5 py-2 text-sm font-semibold text-white hover:bg-white/10">
                Edit zone
              </button>
            </div>
          )}

          <div className="nvc-card p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500 mb-2">Zone enforcement</p>
            <p className="text-xs text-slate-400 leading-relaxed">
              {zones.filter((z) => z.active).length === 0
                ? "No active zones — work orders accepted from any address."
                : `${zones.filter((z) => z.active).length} active zone${zones.filter((z) => z.active).length !== 1 ? "s" : ""}. Work orders and intake submissions outside these zones will be rejected.`}
            </p>
          </div>
        </div>
      </div>

      <ZoneEditor
        state={editor}
        onClose={closeEditor}
        saving={createM.isPending || updateM.isPending}
        onSave={(body) => {
          if (editor.zone) updateM.mutate({ id: editor.zone.id, body });
          else createM.mutate(body);
        }}
      />

      <ConfirmModal
        open={!!delZone}
        onClose={() => setDelZone(null)}
        onConfirm={() => delZone && deleteM.mutate(delZone.id)}
        title="Delete zone?"
        message={`"${delZone?.name}" will be permanently removed.`}
        confirmLabel="Delete"
        danger
      />
    </PageWrap>
  );
}

function DrawBtn({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-white/10 hover:text-white transition"
    >
      {icon} {label}
    </button>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-slate-500">{k}</dt>
      <dd className="font-medium text-slate-200">{v}</dd>
    </div>
  );
}

const PALETTE = ["#06b6d4", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#3b82f6", "#14b8a6"];

function ZoneEditor({
  state,
  onClose,
  onSave,
  saving,
}: {
  state: { open: boolean; zone: Zone | null; polygon: LatLng[] };
  onClose: () => void;
  onSave: (body: Partial<Zone>) => void;
  saving: boolean;
}) {
  const [form, setForm] = useState({ name: "", color: "#06b6d4", surgeMultiplier: 1, active: true });

  useEffect(() => {
    if (state.open) {
      setForm({
        name: state.zone?.name ?? "",
        color: state.zone?.color ?? "#06b6d4",
        surgeMultiplier: state.zone?.surgeMultiplier ?? 1,
        active: state.zone?.active ?? true,
      });
    }
  }, [state.open, state.zone]);

  return (
    <Modal
      open={state.open}
      onClose={onClose}
      title={state.zone ? "Edit zone" : "New service zone"}
      subtitle={`${state.polygon.length} boundary points`}
      footer={
        <>
          <BtnGhost onClick={onClose}>Cancel</BtnGhost>
          <BtnPrimary
            disabled={saving || !form.name.trim()}
            onClick={() => onSave({ ...form, polygon: state.polygon } as Partial<Zone>)}
          >
            {saving ? "Saving…" : state.zone ? "Save changes" : "Create zone"}
          </BtnPrimary>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Zone name">
          <input aria-label="Zone name" className={inputCls} value={form.name} placeholder="Downtown Core" onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Color">
          <div className="flex flex-wrap gap-2">
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Select color ${c}`}
                onClick={() => setForm({ ...form, color: c })}
                className={`h-8 w-8 rounded-lg border-2 transition ${form.color === c ? "border-white" : "border-transparent"}`}
                style={{ background: c }}
              />
            ))}
          </div>
        </Field>
        <Field label="Surge multiplier" hint="1 = normal pricing, 1.5 = +50%">
          <input
            aria-label="Surge multiplier"
            type="number"
            step="0.1"
            min="1"
            className={inputCls}
            value={form.surgeMultiplier}
            onChange={(e) => setForm({ ...form, surgeMultiplier: parseFloat(e.target.value) || 1 })}
          />
        </Field>
        <label className="flex cursor-pointer items-center gap-2.5 rounded-xl bg-white/[0.03] px-3 py-2.5">
          <input aria-label="Active" type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} className="h-4 w-4 accent-cyan-500" />
          <span className="text-sm text-slate-200">Zone active</span>
        </label>
      </div>
    </Modal>
  );
}
