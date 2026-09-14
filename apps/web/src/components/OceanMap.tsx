import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react';
import {
  Map as MapLibreMap,
  Marker,
  setWorkerUrl,
  type GeoJSONSource,
  type StyleSpecification,
} from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
// The SDK's stylesheet travels with this lazy chunk, so sign-in never fetches map assets.
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature } from 'geojson';
import type { GeoPoint } from '@mib/shared';
import { prefersReducedMotion } from '../lib/format.js';
import {
  assertMapStylePolicy,
  boundsOf,
  geoAlong,
  interpolatedProgress,
  lineFeature,
  unwrapAntimeridian,
  type MapRoute,
} from '../lib/mapGeometry.js';

export type { MapRoute };

// MapLibre resolves its module worker relative to its own chunk URL, which a bundled build never
// emits; let Vite bundle the worker (and the shared chunk it imports) and hand MapLibre that URL.
setWorkerUrl(maplibreWorkerUrl);

export interface MapAnchor {
  id: string;
  name: string;
  geo: GeoPoint;
  role: 'origin' | 'destination' | 'shore';
}

type MapDebugHost = HTMLDivElement & { __mibMap?: MapLibreMap };

export interface OceanMapHandle {
  zoomIn(): void;
  zoomOut(): void;
  recenter(): void;
}

interface Props {
  routes: MapRoute[];
  anchors: MapAnchor[];
  // Bottles whose route is highlighted; several when a shared route is selected.
  selectedRouteIds?: string[];
  selectedAnchorId?: string | null;
  // Shore pins as tappable DOM markers, clustered when they crowd and labelled from LABEL_ZOOM.
  showAnchorLabels?: boolean;
  // Glide the camera to this anchor (e.g. a search result) whenever it changes.
  focusAnchorId?: string | null;
  fitKey?: string;
  bottomPadding?: number;
  onSelectRoute?: (id: string) => void;
  onSelectAnchor?: (id: string) => void;
  handle?: Ref<OceanMapHandle>;
}

const MIN_ZOOM = 1.6;
const MAX_ZOOM = 7;
// Shore pins: neighbours closer than this (screen px) fold into one cluster; names appear from
// this zoom (the selected pin is always named). With ~400 harbours worldwide, names only make
// sense once a region fills the screen.
const CLUSTER_PX = 44;
const LABEL_ZOOM = 4.5;
const FOCUS_ZOOM = 5;
const EMPTY_SELECTION: string[] = [];
const LAND_URL = '/map/land-50m.geojson';
// Interior country boundaries (Natural Earth admin-0, 1:50m, public domain via world-atlas).
// Drawn as thin lines only: no fills, no names (spec §6.2).
const BORDERS_URL = '/map/borders-50m.geojson';

// Map style policy (MAP_DESIGN.md): land geometry, thin border lines and nothing else. The
// default source is the bundled Natural Earth land polygons (public domain, offline, no
// credentials). A licensed vector source can be supplied with VITE_MIB_MAP_TILES_URL — only its
// land layer is ever drawn; borders always come from the bundled file.
function buildStyle(): StyleSpecification {
  const tiles = import.meta.env.VITE_MIB_MAP_TILES_URL;
  const sourceLayer = import.meta.env.VITE_MIB_MAP_SOURCE_LAYER;
  const usingTiles = Boolean(tiles && sourceLayer);
  const source: StyleSpecification['sources'][string] = usingTiles
    ? { type: 'vector', url: tiles!, attribution: import.meta.env.VITE_MIB_MAP_ATTRIBUTION ?? '' }
    : { type: 'geojson', data: LAND_URL };
  const landRef = usingTiles
    ? { source: 'world', 'source-layer': sourceLayer! }
    : { source: 'world' };
  return {
    version: 8,
    sources: { world: source, borders: { type: 'geojson', data: BORDERS_URL } },
    layers: [
      { id: 'sea', type: 'background', paint: { 'background-color': '#092331' } },
      {
        id: 'land',
        type: 'fill',
        ...landRef,
        paint: { 'fill-color': '#26313a', 'fill-outline-color': '#26313a' },
      },
      {
        id: 'coast',
        type: 'line',
        ...landRef,
        paint: { 'line-color': '#6f8f92', 'line-width': 0.8, 'line-opacity': 0.45 },
      },
      {
        id: 'borders',
        type: 'line',
        source: 'borders',
        layout: { 'line-join': 'round' },
        paint: {
          'line-color': '#8ea3ab',
          'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.45, 5, 0.9],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 1.6, 0.22, 4, 0.38],
        },
      },
    ],
  };
}

export function isWebGLAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}

export function OceanMap({
  routes,
  anchors,
  selectedRouteIds = EMPTY_SELECTION,
  selectedAnchorId = null,
  showAnchorLabels = false,
  focusAnchorId = null,
  fitKey = '',
  bottomPadding = 280,
  onSelectRoute,
  onSelectAnchor,
  handle,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef(new globalThis.Map<string, Marker>());
  const anchorMarkersRef = useRef(new globalThis.Map<string, Marker>());
  const [loaded, setLoaded] = useState(false);
  const [unsupported] = useState(() => !isWebGLAvailable());
  const latest = useRef({
    routes,
    anchors,
    selectedRouteIds,
    selectedAnchorId,
    showAnchorLabels,
    onSelectRoute,
    onSelectAnchor,
  });
  useEffect(() => {
    latest.current = {
      routes,
      anchors,
      selectedRouteIds,
      selectedAnchorId,
      showAnchorLabels,
      onSelectRoute,
      onSelectAnchor,
    };
  });
  const reduced = useMemo(() => prefersReducedMotion(), []);

  const fitToSelection = (animate: boolean) => {
    const map = mapRef.current;
    if (!map) return;
    const { routes: rs, anchors: as, selectedRouteIds: sel } = latest.current;
    const chosen = rs.filter((r) => sel.includes(r.id));
    const shown = chosen.length > 0 ? chosen : rs;
    const points =
      shown.length > 0 ? shown.flatMap((r) => unwrapAntimeridian(r.points)) : as.map((a) => a.geo);
    const b = boundsOf(points);
    if (!b) return;
    const wide = map.getContainer().clientWidth >= 900;
    // Keep routes clear of the header, the mode switch / zoom cluster and the sheet; scale the
    // paddings down on short viewports so they never exceed the container.
    let top = wide ? 170 : 250;
    let bottom = wide ? 80 : bottomPadding;
    const spare = map.getContainer().clientHeight - 80;
    if (top + bottom > spare) {
      const k = spare / (top + bottom);
      top = Math.floor(top * k);
      bottom = Math.floor(bottom * k);
    }
    map.fitBounds(b, {
      padding: { top, bottom, left: 48, right: 76 },
      maxZoom: 5.2,
      duration: animate && !reduced ? 900 : 0,
      easing: (t: number) => 1 - Math.pow(1 - t, 3),
    });
  };

  useImperativeHandle(handle, () => ({
    zoomIn: () => mapRef.current?.zoomIn({ duration: reduced ? 0 : 300 }),
    zoomOut: () => mapRef.current?.zoomOut({ duration: reduced ? 0 : 300 }),
    recenter: () => fitToSelection(true),
  }));

  // Shore pins as DOM markers. Pins whose screen positions overlap fold into a numbered cluster
  // that zooms in when tapped; names are shown only from LABEL_ZOOM so a dense coast stays
  // readable. Re-run after every camera move because membership depends on the projection.
  const layoutPins = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const { anchors: as, selectedAnchorId: sel, showAnchorLabels: pins } = latest.current;
    const keep = new Set<string>();
    if (pins) {
      const zoom = map.getZoom();
      const projected = as.map((a) => ({ a, p: map.project([a.geo.lng, a.geo.lat]) }));
      const clusters: Array<{ members: MapAnchor[]; x: number; y: number }> = [];
      for (const { a, p } of projected) {
        const near = clusters.find((c) => Math.hypot(c.x - p.x, c.y - p.y) < CLUSTER_PX);
        if (near) {
          near.members.push(a);
          near.x = (near.x * (near.members.length - 1) + p.x) / near.members.length;
          near.y = (near.y * (near.members.length - 1) + p.y) / near.members.length;
        } else clusters.push({ members: [a], x: p.x, y: p.y });
      }
      for (const c of clusters) {
        const single = c.members.length === 1 ? c.members[0]! : null;
        const key = single
          ? single.id
          : `cluster:${c.members
              .map((m) => m.id)
              .sort()
              .join('|')}`;
        keep.add(key);
        let m = anchorMarkersRef.current.get(key);
        if (!m) {
          const el = document.createElement('button');
          el.type = 'button';
          if (single) {
            el.className = 'map-shore-pin';
            el.innerHTML = `<span class="dot"></span><span class="label"></span>`;
            el.addEventListener('click', (ev) => {
              ev.stopPropagation();
              latest.current.onSelectAnchor?.(single.id);
            });
          } else {
            el.className = 'map-shore-cluster';
            el.textContent = String(c.members.length);
            el.setAttribute('aria-label', `${c.members.length} shores, tap to zoom in`);
            const center = map.unproject([c.x, c.y]);
            el.addEventListener('click', (ev) => {
              ev.stopPropagation();
              map.easeTo({
                center,
                zoom: Math.min(MAX_ZOOM, map.getZoom() + 1.6),
                duration: reduced ? 0 : 500,
              });
            });
          }
          const lngLat = single
            ? [single.geo.lng, single.geo.lat]
            : map.unproject([c.x, c.y]).toArray();
          m = new Marker({ element: el, anchor: single ? 'top' : 'center' })
            .setLngLat(lngLat as [number, number])
            .addTo(map);
          anchorMarkersRef.current.set(key, m);
        } else if (!single) {
          m.setLngLat(map.unproject([c.x, c.y]));
        }
        if (single) {
          const el = m.getElement();
          el.querySelector('.label')!.textContent = single.name;
          el.setAttribute('aria-label', `Shore: ${single.name}`);
          el.setAttribute('aria-pressed', String(single.id === sel));
          el.classList.toggle('selected', single.id === sel);
          el.classList.toggle('compact', zoom < LABEL_ZOOM && single.id !== sel);
        }
      }
    }
    for (const [id, m] of anchorMarkersRef.current) {
      if (!keep.has(id)) {
        m.remove();
        anchorMarkersRef.current.delete(id);
      }
    }
  }, [reduced]);

  // Create the map once.
  useEffect(() => {
    if (!containerRef.current || unsupported) return;
    const style = buildStyle();
    assertMapStylePolicy(style);
    const map = new MapLibreMap({
      container: containerRef.current,
      style,
      center: [-40, 42],
      zoom: 2.35,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      attributionControl: false,
      fadeDuration: 240,
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.enable();
    mapRef.current = map;
    // Development-only handle so browser checks can inspect layers; absent from production.
    if (import.meta.env.DEV) (containerRef.current as MapDebugHost).__mibMap = map;
    map.on('load', () => {
      map.addSource('planned', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'planned',
        type: 'line',
        source: 'planned',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#cfe3e0',
          'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1.6, 5, 2.4],
          'line-opacity': ['case', ['boolean', ['get', 'selected'], false], 0.55, 0.28],
          'line-dasharray': [1.6, 2.6],
        },
      });
      map.addSource('trail', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'trail',
        type: 'line',
        source: 'trail',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#8fd3cc',
          'line-width': ['interpolate', ['linear'], ['zoom'], 2, 2.6, 5, 3.6],
          'line-opacity': ['case', ['boolean', ['get', 'selected'], false], 0.95, 0.5],
        },
      });
      map.addSource('anchors', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'anchor-halo',
        type: 'circle',
        source: 'anchors',
        paint: { 'circle-radius': 11, 'circle-color': '#8fd3cc', 'circle-opacity': 0.14 },
      });
      map.addLayer({
        id: 'anchor',
        type: 'circle',
        source: 'anchors',
        paint: {
          'circle-radius': 4,
          'circle-color': '#f2f7f5',
          'circle-stroke-color': '#0a2634',
          'circle-stroke-width': 1.4,
        },
      });
      // Tapping a route line selects that bottle's journey.
      for (const layer of ['planned', 'trail']) {
        map.on('click', layer, (e) => {
          const id = e.features?.[0]?.properties?.id as string | undefined;
          if (id) latest.current.onSelectRoute?.(id);
        });
        map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
        map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
      }
      map.on('moveend', () => layoutPins());
      setLoaded(true);
    });
    map.on('error', (e) => {
      // Tile/source hiccups must never surface as page errors; the sea stays drawn.
      if (import.meta.env.DEV) console.debug('map', e.error.message);
    });
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(containerRef.current);
    const markers = markersRef.current;
    const anchorMarkers = anchorMarkersRef.current;
    return () => {
      ro.disconnect();
      markers.forEach((m) => m.remove());
      anchorMarkers.forEach((m) => m.remove());
      markers.clear();
      anchorMarkers.clear();
      map.remove();
      mapRef.current = null;
    };
  }, [unsupported, layoutPins]);

  // Routes, anchors and markers follow the data.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const now = Date.now();
    const planned: Feature[] = [];
    const trail: Feature[] = [];
    const seen = new Set<string>();
    for (const r of routes) {
      if (r.points.length < 2) continue;
      const selected = selectedRouteIds.includes(r.id);
      const progress = interpolatedProgress(r, now);
      const pts = unwrapAntimeridian(r.points);
      const { point, index } = geoAlong(pts, progress);
      planned.push({ ...lineFeature(r.id, pts), properties: { id: r.id, selected } });
      if (progress > 0) {
        trail.push({
          ...lineFeature(r.id, [...pts.slice(0, index + 1), point]),
          properties: { id: r.id, selected },
        });
      }
      seen.add(r.id);
      let marker = markersRef.current.get(r.id);
      if (!marker) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'map-marker';
        el.setAttribute('aria-label', 'Bottle at sea');
        const img = document.createElement('img');
        img.alt = '';
        img.src = terminal(r.state) ? '/markers/marker-lost.svg' : '/markers/marker-bottle.svg';
        el.appendChild(img);
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          latest.current.onSelectRoute?.(r.id);
        });
        marker = new Marker({ element: el, anchor: 'center' })
          .setLngLat([point.lng, point.lat])
          .addTo(map);
        markersRef.current.set(r.id, marker);
      } else {
        marker.setLngLat([point.lng, point.lat]);
      }
      const el = marker.getElement();
      el.classList.toggle('selected', selected);
      el.classList.toggle('static', !r.live || reduced);
      el.setAttribute('aria-pressed', String(selected));
    }
    for (const [id, m] of markersRef.current) {
      if (!seen.has(id)) {
        m.remove();
        markersRef.current.delete(id);
      }
    }
    void map.getSource<GeoJSONSource>('planned')?.setData({
      type: 'FeatureCollection',
      features: planned,
    });
    void map.getSource<GeoJSONSource>('trail')?.setData({
      type: 'FeatureCollection',
      features: trail,
    });
    void map.getSource<GeoJSONSource>('anchors')?.setData({
      type: 'FeatureCollection',
      features: anchors
        .filter(() => !showAnchorLabels)
        .map((a) => ({
          type: 'Feature',
          properties: { id: a.id, role: a.role },
          geometry: { type: 'Point', coordinates: [a.geo.lng, a.geo.lat] },
        })),
    });

    layoutPins();
  }, [
    routes,
    anchors,
    selectedRouteIds,
    selectedAnchorId,
    showAnchorLabels,
    loaded,
    reduced,
    layoutPins,
  ]);

  // Ticker: glide the marker along the polyline between server syncs (position stays server-owned).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || reduced) return;
    if (!routes.some((r) => r.live)) return;
    const id = setInterval(() => {
      if (document.hidden) return;
      const now = Date.now();
      const trail: Feature[] = [];
      for (const r of routes) {
        if (r.points.length < 2) continue;
        const progress = interpolatedProgress(r, now);
        const pts = unwrapAntimeridian(r.points);
        const { point, index } = geoAlong(pts, progress);
        markersRef.current.get(r.id)?.setLngLat([point.lng, point.lat]);
        if (progress > 0) {
          trail.push({
            ...lineFeature(r.id, [...pts.slice(0, index + 1), point]),
            properties: { id: r.id, selected: selectedRouteIds.includes(r.id) },
          });
        }
      }
      const trailSource = map.getSource<GeoJSONSource>('trail');
      if (trailSource) void trailSource.setData({ type: 'FeatureCollection', features: trail });
    }, 1000);
    return () => clearInterval(id);
  }, [routes, selectedRouteIds, loaded, reduced]);

  // Camera: glide to a focused anchor (search result) close enough for its name to show.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !focusAnchorId) return;
    const a = latest.current.anchors.find((x) => x.id === focusAnchorId);
    if (!a) return;
    map.easeTo({
      center: [a.geo.lng, a.geo.lat],
      zoom: Math.max(map.getZoom(), FOCUS_ZOOM),
      duration: reduced ? 0 : 600,
    });
  }, [focusAnchorId, loaded, reduced]);

  // Camera: fit to the selection whenever the caller asks (fitKey) or on first data.
  const firstFit = useRef(false);
  useEffect(() => {
    if (!loaded) return;
    if (routes.length === 0 && anchors.length === 0) return;
    fitToSelection(firstFit.current);
    firstFit.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, fitKey]);

  return (
    <div className="ocean-map" ref={containerRef} role="region" aria-label="Private ocean chart">
      {!loaded && !unsupported ? <div className="map-fade" /> : null}
      {unsupported ? (
        <p className="scene-fallback">
          The chart needs WebGL, which this browser cannot provide. Your bottles are listed below.
        </p>
      ) : null}
    </div>
  );
}

function terminal(state: string): boolean {
  return state === 'lost' || state === 'discarded' || state === 'cancelled';
}
