import type { Feature, LineString } from 'geojson';
import type { GeoPoint } from '@mib/shared';

export interface MapRoute {
  id: string;
  points: GeoPoint[];
  progress: number;
  progressAsOf: number;
  plannedDurationMs: number;
  live: boolean;
  state: string;
  // Recipient name for the marker's accessible label ("Bottle to Mira, at sea").
  label?: string;
  // A journey the sea has ended: the marker sits at this persisted position, draws no route and
  // never moves. `mark` says which outcome glyph to show; `mine` marks the caller's own adrift
  // bottle on the public ocean (the golden pennant).
  fixed?: GeoPoint;
  mark?: 'sunk' | 'adrift';
  mine?: boolean;
}

export interface StyleLayerLike {
  id: string;
  type: string;
  'source-layer'?: string | undefined;
}

// Map style policy (MAP_DESIGN.md, spec §6.2): land geometry, thin country border lines and
// nothing else. Rejects any symbol (text/icon) layer and any place/label/road source layer
// before the map is created, so a provider style can never re-introduce names silently. Border
// data may only ever be drawn as a line layer (no fills, no labels).
export function assertMapStylePolicy(style: { layers: StyleLayerLike[] }): void {
  for (const layer of style.layers) {
    if (layer.type === 'symbol') throw new Error(`map policy: symbol layer ${layer.id}`);
    const sl = layer['source-layer'] ?? '';
    if (/place|label|poi|road|transport|building|housenum|water_name/i.test(sl)) {
      throw new Error(`map policy: labelled source-layer ${sl}`);
    }
    if (/admin|boundary|border|country/i.test(`${layer.id} ${sl}`) && layer.type !== 'line') {
      throw new Error(`map policy: borders may only be drawn as lines (${layer.id})`);
    }
  }
}

// Shifts longitudes so consecutive points never jump more than 180°: a Pacific route drawn
// from 175 to -170 becomes 175 → 190 and renders as one short line across the antimeridian
// instead of a line around the globe. Points are otherwise untouched (no reprojection).
export function unwrapAntimeridian(points: GeoPoint[]): GeoPoint[] {
  const out: GeoPoint[] = [];
  let offset = 0;
  let prev: number | null = null;
  for (const p of points) {
    if (prev !== null) {
      const d = p.lng + offset - prev;
      if (d > 180) offset -= 360;
      else if (d < -180) offset += 360;
    }
    const lng = p.lng + offset;
    out.push({ lng, lat: p.lat });
    prev = lng;
  }
  return out;
}

export function lineFeature(id: string, coords: GeoPoint[]): Feature<LineString> {
  return {
    type: 'Feature',
    properties: { id },
    geometry: { type: 'LineString', coordinates: coords.map((p) => [p.lng, p.lat]) },
  };
}

// Client-side interpolation between server syncs (never authoritative): the server's own
// progress formula applied from the last synced value so the marker glides instead of jumping.
export function interpolatedProgress(route: MapRoute, now: number): number {
  if (!route.live) return route.progress;
  const elapsed = Math.max(0, now - route.progressAsOf);
  return Math.min(1, route.progress + elapsed / route.plannedDurationMs);
}

export function geoAlong(points: GeoPoint[], progress: number): { point: GeoPoint; index: number } {
  const first = points[0]!;
  if (points.length === 1) return { point: first, index: 0 };
  const p = Math.min(1, Math.max(0, progress));
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const len = Math.hypot(
      points[i]!.lng - points[i - 1]!.lng,
      points[i]!.lat - points[i - 1]!.lat,
    );
    lengths.push(len);
    total += len;
  }
  if (total === 0) return { point: first, index: 0 };
  let target = p * total;
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i]!;
    if (target <= len || i === lengths.length - 1) {
      const t = len === 0 ? 0 : Math.min(1, target / len);
      const a = points[i]!;
      const b = points[i + 1]!;
      return {
        point: { lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t },
        index: i,
      };
    }
    target -= len;
  }
  return { point: points[points.length - 1]!, index: points.length - 2 };
}

export type Bounds = [[number, number], [number, number]];

export function boundsOf(points: GeoPoint[]): Bounds | null {
  if (points.length === 0) return null;
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const p of points) {
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
  }
  if (minLng === maxLng && minLat === maxLat) {
    return [
      [minLng - 6, minLat - 4],
      [maxLng + 6, maxLat + 4],
    ];
  }
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

// ---------- shore pin clustering ----------
export interface PinPoint<T> {
  item: T;
  x: number;
  y: number;
}
export interface PinCluster<T> {
  members: T[];
  x: number;
  y: number;
  // Screen offset per member when the cluster is spread ("spiderfied") because zooming can no
  // longer separate its harbours; empty for a real cluster or a single pin.
  offsets: Array<[number, number]>;
}

// Greedy screen-space clustering. A cluster only survives while zooming in could still pull
// its members `clusterPx` apart before `maxZoom`; otherwise (harbours a few km apart, e.g. the
// two sides of one gulf) it dissolves into a ring of offset pins around the real position, so
// every harbour stays individually visible and selectable. Offsets are purely visual.
export function clusterPins<T>(
  points: Array<PinPoint<T>>,
  zoom: number,
  maxZoom: number,
  clusterPx: number,
): Array<PinCluster<T>> {
  const groups: Array<{ points: Array<PinPoint<T>>; x: number; y: number }> = [];
  for (const pt of points) {
    const near = groups.find((g) => Math.hypot(g.x - pt.x, g.y - pt.y) < clusterPx);
    if (near) {
      near.points.push(pt);
      near.x = (near.x * (near.points.length - 1) + pt.x) / near.points.length;
      near.y = (near.y * (near.points.length - 1) + pt.y) / near.points.length;
    } else groups.push({ points: [pt], x: pt.x, y: pt.y });
  }
  const scale = Math.pow(2, Math.max(0, maxZoom - zoom));
  return groups.map((g) => {
    const members = g.points.map((p) => p.item);
    if (members.length === 1) return { members, x: g.x, y: g.y, offsets: [] };
    // Would the two farthest members be apart at max zoom? Then zooming still helps.
    let spread = 0;
    for (let i = 0; i < g.points.length; i++)
      for (let j = i + 1; j < g.points.length; j++) {
        const a = g.points[i]!;
        const b = g.points[j]!;
        spread = Math.max(spread, Math.hypot(a.x - b.x, a.y - b.y));
      }
    const atMax = zoom >= maxZoom - 0.05;
    if (!atMax && spread * scale >= clusterPx) return { members, x: g.x, y: g.y, offsets: [] };
    return { members, x: g.x, y: g.y, offsets: spreadOffsets(members.length) };
  });
}

// Ring offsets (px) for n pins around their shared position, starting at the top.
export function spreadOffsets(n: number): Array<[number, number]> {
  const radius = 26 + 6 * Math.max(0, n - 2);
  return Array.from({ length: n }, (_, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return [Math.round(Math.cos(angle) * radius), Math.round(Math.sin(angle) * radius)];
  });
}
