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
