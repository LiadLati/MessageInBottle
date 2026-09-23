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
import { isWebGLAvailable } from '../lib/webgl.js';
import { sidePaneLayout } from '../lib/layout.js';
import type { BottleWeather } from '../lib/oceanWeather.js';
import {
  assertMapStylePolicy,
  boundsOf,
  clusterPins,
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

// A named harbour label: the signed-in user's own harbour (always), the destination of the
// selected bottle (while selected), or one label for both when they are the same shore.
export interface HarborLabel {
  id: string;
  name: string;
  geo: GeoPoint;
  kind: 'own' | 'destination' | 'both';
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
  // Harbour labels drawn as DOM markers (anchor icon + name). Overlapping labels are stacked.
  harbors?: HarborLabel[];
  // Terminal markers whose first appearance inside the visible viewport must be reported (a
  // sunk bottle's red X). Reported at most once per id per mount, only while the page is
  // visible and the map is not covered.
  watchIds?: string[];
  onSeen?: (id: string) => void;
  ariaLabel?: string;
  // What to say when the chart cannot be drawn: each screen knows what it offers instead
  // (audit FE-006). The default promises nothing.
  fallbackMessage?: string;
  // Time of day for the map palette. Changing it tweens paint properties in place: the camera,
  // sources, routes, markers and any open selection are untouched.
  phase?: MapPhase;
  // Per-bottle weather (handoff v2.0): a storm belongs to a bottle, never to the map. The
  // glyph shows above a marker for exactly as long as that bottle's storm window lasts; the
  // window is scheduled in the account's own night, so it always falls on a night-mode map.
  weather?: Record<string, BottleWeather>;
  // While the sea viewer covers the map, the position ticker and pin layout stop; the map keeps
  // its instance, camera and selection so returning restores them exactly.
  paused?: boolean;
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
const EMPTY_HARBORS: HarborLabel[] = [];
const EMPTY_WEATHER: Record<string, BottleWeather> = {};
const LAND_URL = '/map/land-50m.geojson';
// Interior country boundaries (Natural Earth admin-0, 1:50m, public domain via world-atlas).
// Drawn as thin lines only: no fills, no names (spec §6.2).
const BORDERS_URL = '/map/borders-50m.geojson';

// Day and night palettes (weather handoff v1.1 · DESIGN_TOKENS.json → color.mapDay/mapNight).
// Route colours are deliberately absent: they are identical in day, night and storm, which is
// what makes the three states read as one map.
export const MAP_PALETTE = {
  night: {
    sea: '#092331',
    land: '#26313a',
    coast: '#6f8f92',
    coastOpacity: 0.45,
    shelfOuter: '#123d4e',
    shelfOuterOpacity: 0.55,
    shelfOuterWidth: [7, 18] as [number, number],
    shelfInnerOpacity: 0,
    borderOpacity: [0.22, 0.38] as [number, number],
  },
  day: {
    sea: '#15607e',
    land: '#dcd9c8',
    coast: '#8a9a90',
    coastOpacity: 0.7,
    shelfOuter: '#2e86a4',
    shelfOuterOpacity: 0.34,
    shelfOuterWidth: [7, 20] as [number, number],
    shelfInnerOpacity: 0.3,
    borderOpacity: [0.3, 0.5] as [number, number],
  },
} as const;

const SHELF_INNER_COLOR = '#59aec2';

export type MapPhase = keyof typeof MAP_PALETTE;

const DAY_NIGHT_MS = 600;
const REDUCED_MS = 180;

// Map style policy (MAP_DESIGN.md): land geometry, thin border lines and nothing else. The
// default source is the bundled Natural Earth land polygons (public domain, offline, no
// credentials). A licensed vector source can be supplied with VITE_MIB_MAP_TILES_URL — only its
// land layer is ever drawn; borders always come from the bundled file.
function buildStyle(phase: MapPhase): StyleSpecification {
  const tiles = import.meta.env.VITE_MIB_MAP_TILES_URL;
  const sourceLayer = import.meta.env.VITE_MIB_MAP_SOURCE_LAYER;
  const usingTiles = Boolean(tiles && sourceLayer);
  const source: StyleSpecification['sources'][string] = usingTiles
    ? { type: 'vector', url: tiles!, attribution: import.meta.env.VITE_MIB_MAP_ATTRIBUTION ?? '' }
    : { type: 'geojson', data: LAND_URL };
  const landRef = usingTiles
    ? { source: 'world', 'source-layer': sourceLayer! }
    : { source: 'world' };
  const p = MAP_PALETTE[phase];
  return {
    version: 8,
    sources: { world: source, borders: { type: 'geojson', data: BORDERS_URL } },
    layers: [
      { id: 'sea', type: 'background', paint: { 'background-color': p.sea } },
      // Depth: two widening, blurred lines on the land geometry (MAP_DESIGN.md). Round joins —
      // mitred ones spike on small islands. The inner line is a daylight-only band.
      {
        id: 'shelf-outer',
        type: 'line',
        ...landRef,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': p.shelfOuter,
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            1.6,
            p.shelfOuterWidth[0],
            5,
            p.shelfOuterWidth[1],
          ],
          'line-opacity': p.shelfOuterOpacity,
          'line-blur': 3.5,
        },
      },
      {
        id: 'shelf-inner',
        type: 'line',
        ...landRef,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': SHELF_INNER_COLOR,
          'line-width': ['interpolate', ['linear'], ['zoom'], 1.6, 2.6, 5, 8],
          'line-opacity': p.shelfInnerOpacity,
          'line-blur': 1.6,
        },
      },
      {
        id: 'land',
        type: 'fill',
        ...landRef,
        paint: { 'fill-color': p.land, 'fill-outline-color': p.land },
      },
      {
        id: 'coast',
        type: 'line',
        ...landRef,
        paint: { 'line-color': p.coast, 'line-width': 0.8, 'line-opacity': p.coastOpacity },
      },
      {
        id: 'borders',
        type: 'line',
        source: 'borders',
        layout: { 'line-join': 'round' },
        paint: {
          'line-color': p.coast,
          'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.45, 5, 0.9],
          'line-opacity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            1.6,
            p.borderOpacity[0],
            4,
            p.borderOpacity[1],
          ],
        },
      },
    ],
  };
}

// ---------- colour + tween helpers (day↔night and calm↔storm never call setStyle) ----------
function parseHex(hex: string): [number, number, number] {
  const v = hex.replace('#', '');
  const n = parseInt(
    v.length === 3
      ? v
          .split('')
          .map((c) => c + c)
          .join('')
      : v,
    16,
  );
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mixHex(from: string, to: string, k: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  const c = a.map((v, i) => Math.round(v + (b[i]! - v) * Math.min(1, Math.max(0, k))));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const easeStandard = (t: number) => 1 - Math.pow(1 - t, 3);

// A cancellable rAF tween. Returns a stop function so an interrupted transition is reversible.
function tween(ms: number, onStep: (k: number) => void): () => void {
  if (ms <= 0) {
    onStep(1);
    return () => {};
  }
  let raf = 0;
  const start = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - start) / ms);
    onStep(easeStandard(k));
    if (k < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

export function OceanMap({
  routes,
  anchors,
  selectedRouteIds = EMPTY_SELECTION,
  selectedAnchorId = null,
  showAnchorLabels = false,
  focusAnchorId = null,
  harbors = EMPTY_HARBORS,
  watchIds = EMPTY_SELECTION,
  onSeen,
  ariaLabel = 'Private ocean chart',
  fallbackMessage = 'The chart needs WebGL, which this browser cannot provide.',
  phase = 'night',
  weather = EMPTY_WEATHER,
  paused = false,
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
  const harborMarkersRef = useRef(new globalThis.Map<string, Marker>());
  // Ids already reported as seen this mount: the first sighting is the one that counts.
  const seenRef = useRef(new Set<string>());
  const [loaded, setLoaded] = useState(false);
  const [unsupported] = useState(() => !isWebGLAvailable());
  // The palette in force right now, so an interrupted tween resumes from where it is and the
  // map is never rebuilt.
  const phaseRef = useRef<MapPhase>(phase);
  const stopPhaseTween = useRef<() => void>(() => {});
  const latest = useRef({
    routes,
    anchors,
    harbors,
    watchIds,
    onSeen,
    paused,
    bottomPadding,
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
      harbors,
      watchIds,
      onSeen,
      paused,
      bottomPadding,
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
      shown.length > 0
        ? shown.flatMap((r) => (r.fixed ? [r.fixed] : unwrapAntimeridian(r.points)))
        : as.map((a) => a.geo);
    const b = boundsOf(points);
    if (!b) return;
    const wide = sidePaneLayout();
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
      const projected = as.map((a) => {
        const p = map.project([a.geo.lng, a.geo.lat]);
        return { item: a, x: p.x, y: p.y };
      });
      const clusters = clusterPins(projected, zoom, MAX_ZOOM, CLUSTER_PX);
      for (const c of clusters) {
        if (c.members.length > 1 && c.offsets.length === 0) {
          // A real cluster: zooming in will separate it.
          const key = `cluster:${c.members
            .map((m) => m.id)
            .sort()
            .join('|')}`;
          keep.add(key);
          let m = anchorMarkersRef.current.get(key);
          if (!m) {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = 'map-shore-cluster';
            el.textContent = String(c.members.length);
            // Shore pins are a pointer shortcut: every screen that shows them also lists the
            // same shores as text or as a radiogroup, so they stay out of the tab order and
            // the accessibility tree instead of putting ~96 stops before it (A11Y-009).
            el.tabIndex = -1;
            el.setAttribute('aria-hidden', 'true');
            el.setAttribute('aria-label', `${c.members.length} shores, activate to zoom in`);
            el.addEventListener('click', (ev) => {
              ev.stopPropagation();
              map.easeTo({
                center: m!.getLngLat(),
                zoom: Math.min(MAX_ZOOM, map.getZoom() + 1.6),
                duration: reduced ? 0 : 500,
              });
            });
            m = new Marker({ element: el, anchor: 'center' })
              .setLngLat(map.unproject([c.x, c.y]))
              .addTo(map);
            anchorMarkersRef.current.set(key, m);
          } else m.setLngLat(map.unproject([c.x, c.y]));
          continue;
        }
        // Single pins, or a spread ring of pins that zooming could not separate. Each pin keeps
        // its real coordinate; only the marker's screen offset moves.
        c.members.forEach((member, i) => {
          const offset = c.offsets[i] ?? [0, 0];
          keep.add(member.id);
          let m = anchorMarkersRef.current.get(member.id);
          if (!m) {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = 'map-shore-pin';
            el.innerHTML = `<span class="leg"></span><span class="dot"></span><span class="label"></span>`;
            el.tabIndex = -1;
            el.setAttribute('aria-hidden', 'true');
            el.addEventListener('click', (ev) => {
              ev.stopPropagation();
              latest.current.onSelectAnchor?.(member.id);
            });
            m = new Marker({ element: el, anchor: 'top' })
              .setLngLat([member.geo.lng, member.geo.lat])
              .addTo(map);
            anchorMarkersRef.current.set(member.id, m);
          }
          m.setOffset(offset);
          const el = m.getElement();
          const spread = c.offsets.length > 0;
          el.classList.toggle('spread', spread);
          // Leg from the dot back to the real position, so the offset reads as a pointer.
          const leg = el.querySelector<HTMLElement>('.leg')!;
          if (spread) {
            const dx = -offset[0];
            const dy = -offset[1] - 6;
            leg.style.height = `${Math.round(Math.hypot(dx, dy))}px`;
            leg.style.transform = `rotate(${Math.atan2(-dx, dy) * (180 / Math.PI)}deg)`;
          }
          el.querySelector('.label')!.textContent = member.name;
          el.setAttribute('aria-label', `Shore: ${member.name}`);
          el.setAttribute('aria-pressed', String(member.id === sel));
          el.classList.toggle('selected', member.id === sel);
          el.classList.toggle('compact', zoom < LABEL_ZOOM && member.id !== sel && !spread);
        });
      }
    }
    for (const [id, m] of anchorMarkersRef.current) {
      if (!keep.has(id)) {
        m.remove();
        anchorMarkersRef.current.delete(id);
      }
    }
  }, [reduced]);

  // Harbour labels: the user's own harbour and the selected destination, as anchor + name.
  // When two labels would overlap on screen the destination is stacked under the other one;
  // when both are the same shore the caller passes a single 'both' label.
  const layoutHarbors = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const { harbors: hs } = latest.current;
    const keep = new Set<string>();
    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
    const ordered = [...hs].sort(
      (a, b) => (a.kind === 'destination' ? 1 : 0) - (b.kind === 'destination' ? 1 : 0),
    );
    for (const h of ordered) {
      keep.add(h.id);
      let m = harborMarkersRef.current.get(h.id);
      if (!m) {
        const el = document.createElement('div');
        el.className = 'map-harbor';
        el.innerHTML =
          '<span class="dot"></span><span class="label"><img class="icon" alt="" src="/markers/harbor-anchor.svg"><span class="name"></span></span>';
        m = new Marker({ element: el, anchor: 'top' }).setLngLat([h.geo.lng, h.geo.lat]).addTo(map);
        harborMarkersRef.current.set(h.id, m);
      }
      const el = m.getElement();
      el.querySelector('.name')!.textContent = h.name;
      el.dataset.kind = h.kind;
      el.setAttribute(
        'aria-label',
        h.kind === 'own'
          ? `Your harbour: ${h.name}`
          : h.kind === 'destination'
            ? `Destination harbour: ${h.name}`
            : `Your harbour and the destination: ${h.name}`,
      );
      // Overlap: stack this label below any label already placed over the same pixels.
      const p = map.project([h.geo.lng, h.geo.lat]);
      const w = Math.max(80, el.offsetWidth || 120);
      const hgt = 40;
      let dy = 0;
      for (const box of placed) {
        const overlapsX = Math.abs(p.x - box.x) < (w + box.w) / 2;
        const overlapsY = Math.abs(p.y + dy - box.y) < (hgt + box.h) / 2;
        if (overlapsX && overlapsY) dy = box.y + box.h / 2 + hgt / 2 + 4 - p.y;
      }
      m.setOffset([0, dy]);
      el.classList.toggle('stacked', dy !== 0);
      placed.push({ x: p.x, y: p.y + dy, w, h: hgt });
    }
    for (const [id, m] of harborMarkersRef.current) {
      if (!keep.has(id)) {
        m.remove();
        harborMarkersRef.current.delete(id);
      }
    }
  }, []);

  // Report a watched terminal marker the first time it is actually inside the visible part of
  // the viewport (above the sheet, inside the container) while the page is visible and the map
  // is not covered by the sea viewer. A marker fetched but off screen is never reported.
  const reportSeen = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const { watchIds: ids, onSeen: cb, paused: covered, bottomPadding: pad } = latest.current;
    if (!cb || ids.length === 0 || covered || document.visibilityState !== 'visible') return;
    const w = map.getContainer().clientWidth;
    const h = map.getContainer().clientHeight;
    const wide = sidePaneLayout();
    const bottomLimit = h - (wide ? 0 : pad);
    for (const id of ids) {
      if (seenRef.current.has(id)) continue;
      const m = markersRef.current.get(id);
      if (!m) continue;
      const p = map.project(m.getLngLat());
      if (p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= bottomLimit) {
        seenRef.current.add(id);
        cb(id);
      }
    }
  }, []);

  // Create the map once.
  useEffect(() => {
    if (!containerRef.current || unsupported) return;
    const style = buildStyle(phaseRef.current);
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
      // The bundled Natural Earth geometry is public domain and needs no credit; a configured
      // tile provider's attribution is always shown, as its terms require (audit: FE
      // deployment item 3).
      attributionControl: import.meta.env.VITE_MIB_MAP_TILES_URL
        ? { compact: true, customAttribution: import.meta.env.VITE_MIB_MAP_ATTRIBUTION ?? '' }
        : false,
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
      map.on('moveend', () => {
        layoutPins();
        layoutHarbors();
        reportSeen();
      });
      setLoaded(true);
    });
    const onVisible = () => reportSeen();
    document.addEventListener('visibilitychange', onVisible);
    map.on('error', (e) => {
      // Tile/source hiccups must never surface as page errors; the sea stays drawn.
      if (import.meta.env.DEV) console.debug('map', e.error.message);
    });
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(containerRef.current);
    const markers = markersRef.current;
    const anchorMarkers = anchorMarkersRef.current;
    const harborMarkers = harborMarkersRef.current;
    return () => {
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisible);
      markers.forEach((m) => m.remove());
      anchorMarkers.forEach((m) => m.remove());
      harborMarkers.forEach((m) => m.remove());
      markers.clear();
      anchorMarkers.clear();
      harborMarkers.clear();
      map.remove();
      mapRef.current = null;
    };
  }, [unsupported, layoutPins, layoutHarbors, reportSeen]);

  // Routes, anchors and markers follow the data.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const now = Date.now();
    const planned: Feature[] = [];
    const trail: Feature[] = [];
    const seen = new Set<string>();
    for (const r of routes) {
      if (!r.fixed && r.points.length < 2) continue;
      const selected = selectedRouteIds.includes(r.id);
      let point: GeoPoint;
      if (r.fixed) {
        // An ended journey: a fixed marker, no planned line and no trail.
        point = r.fixed;
      } else {
        const progress = interpolatedProgress(r, now);
        const pts = unwrapAntimeridian(r.points);
        const along = geoAlong(pts, progress);
        point = along.point;
        planned.push({ ...lineFeature(r.id, pts), properties: { id: r.id, selected } });
        if (progress > 0) {
          trail.push({
            ...lineFeature(r.id, [...pts.slice(0, along.index + 1), point]),
            properties: { id: r.id, selected },
          });
        }
      }
      seen.add(r.id);
      let marker = markersRef.current.get(r.id);
      if (!marker) {
        // The 40 × 58 marker stack (handoff v2.0): a storm glyph slot above the bottle, a
        // selection ring around it. Tapping opens the bottle's information only — the sea viewer
        // is reached solely from the card's own "View at sea" action.
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'map-marker';
        el.dataset.bottleId = r.id;
        el.innerHTML =
          '<img class="glyph" alt="" src="/markers/storm-cloud-glyph.svg">' +
          '<img class="mark-sunk" alt="" src="/markers/mark-sunk.svg">' +
          '<span class="bottle"><img class="art" alt="" src="/markers/marker-bottle.svg">' +
          '<img class="pennant" alt="" src="/markers/pennant-gold.svg"></span>';
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          latest.current.onSelectRoute?.(r.id);
        });
        marker = new Marker({ element: el, anchor: 'bottom', offset: [0, 20] })
          .setLngLat([point.lng, point.lat])
          .addTo(map);
        markersRef.current.set(r.id, marker);
      } else {
        marker.setLngLat([point.lng, point.lat]);
      }
      const el = marker.getElement();
      // A storm is drawn for as long as the server's window lasts; the server schedules it in
      // this account's own night, the same night the palette follows.
      const stormy = weather[r.id] === 'storm' && r.live;
      el.classList.toggle('selected', selected);
      el.classList.toggle('static', !r.live || reduced);
      el.classList.toggle('storm', stormy);
      el.classList.toggle('sunk', r.mark === 'sunk');
      el.classList.toggle('adrift', r.mark === 'adrift');
      el.classList.toggle('mine', r.mark === 'adrift' && r.mine === true);
      el.setAttribute('aria-pressed', String(selected));
      el.setAttribute(
        'aria-label',
        r.mark === 'sunk'
          ? `Bottle${r.label ? ` to ${r.label}` : ''}, sunk at sea`
          : r.mark === 'adrift'
            ? r.mine
              ? 'Your bottle, adrift in the public ocean'
              : 'A lost bottle, adrift'
            : `Bottle${r.label ? ` to ${r.label}` : ''}, ${stormy ? 'in a storm' : statusWord(r.state)}`,
      );
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
    layoutHarbors();
    reportSeen();
  }, [
    routes,
    anchors,
    harbors,
    watchIds,
    selectedRouteIds,
    selectedAnchorId,
    showAnchorLabels,
    loaded,
    reduced,
    layoutPins,
    layoutHarbors,
    reportSeen,
    weather,
    phase,
  ]);

  // The sea viewer closing uncovers the map: anything now on screen counts as seen.
  useEffect(() => {
    if (!paused) reportSeen();
  }, [paused, reportSeen]);

  // Ticker: glide the marker along the polyline between server syncs (position stays server-owned).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || reduced || paused) return;
    if (!routes.some((r) => r.live)) return;
    const id = setInterval(() => {
      if (document.hidden) return;
      const now = Date.now();
      const trail: Feature[] = [];
      for (const r of routes) {
        if (r.fixed || r.points.length < 2) continue;
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
  }, [routes, selectedRouteIds, loaded, reduced, paused]);

  // Day ↔ night: a 600ms per-layer paint tween on the live map. Never setStyle — that reloads
  // sources, drops the DOM markers and blinks the camera. Route colours are excluded by design.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || phaseRef.current === phase) return;
    const from = MAP_PALETTE[phaseRef.current];
    const to = MAP_PALETTE[phase];
    phaseRef.current = phase;
    stopPhaseTween.current();
    stopPhaseTween.current = tween(reduced ? REDUCED_MS : DAY_NIGHT_MS, (k) => {
      if (!mapRef.current) return;
      const lerp = (a: number, b: number) => a + (b - a) * k;
      map.setPaintProperty('sea', 'background-color', mixHex(from.sea, to.sea, k));
      map.setPaintProperty('land', 'fill-color', mixHex(from.land, to.land, k));
      map.setPaintProperty('land', 'fill-outline-color', mixHex(from.land, to.land, k));
      map.setPaintProperty('coast', 'line-color', mixHex(from.coast, to.coast, k));
      map.setPaintProperty('coast', 'line-opacity', lerp(from.coastOpacity, to.coastOpacity));
      map.setPaintProperty('borders', 'line-color', mixHex(from.coast, to.coast, k));
      map.setPaintProperty('borders', 'line-opacity', [
        'interpolate',
        ['linear'],
        ['zoom'],
        1.6,
        lerp(from.borderOpacity[0], to.borderOpacity[0]),
        4,
        lerp(from.borderOpacity[1], to.borderOpacity[1]),
      ]);
      map.setPaintProperty('shelf-outer', 'line-color', mixHex(from.shelfOuter, to.shelfOuter, k));
      map.setPaintProperty(
        'shelf-outer',
        'line-opacity',
        lerp(from.shelfOuterOpacity, to.shelfOuterOpacity),
      );
      map.setPaintProperty('shelf-outer', 'line-width', [
        'interpolate',
        ['linear'],
        ['zoom'],
        1.6,
        lerp(from.shelfOuterWidth[0], to.shelfOuterWidth[0]),
        5,
        lerp(from.shelfOuterWidth[1], to.shelfOuterWidth[1]),
      ]);
      map.setPaintProperty(
        'shelf-inner',
        'line-opacity',
        lerp(from.shelfInnerOpacity, to.shelfInnerOpacity),
      );
    });
  }, [phase, loaded, reduced]);

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
    <div className="ocean-map" ref={containerRef} role="region" aria-label={ariaLabel}>
      {!loaded && !unsupported ? <div className="map-fade" /> : null}
      {unsupported ? <p className="scene-fallback">{fallbackMessage}</p> : null}
    </div>
  );
}

function statusWord(state: string): string {
  if (state === 'at_sea') return 'at sea';
  if (state === 'delivered') return 'arrived';
  return terminal(state) ? 'journey ended' : state.replace(/_/g, ' ');
}

function terminal(state: string): boolean {
  return state === 'lost' || state === 'cancelled';
}
