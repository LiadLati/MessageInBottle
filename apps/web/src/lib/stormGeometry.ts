import type { GeoPoint } from '@mib/shared';
import { draw } from '@mib/shared';
import { unwrapAntimeridian } from './mapGeometry.js';

// Geometry for a simulated storm, anchored to a bottle's own route (MAP_DESIGN.md §Cloud
// treatment). Everything is derived from the schedule's seed, so the same storm always has the
// same shape and place; nothing here is random at render time and nothing moves a bottle.

export interface StormCell {
  lng: number;
  lat: number;
  /** Size factor 0.7–1.25, as in the handoff's storm-cells sample. */
  s: number;
}

export interface StormGeometry {
  id: string;
  /** The bottle whose route this storm sits on. */
  bottleId: string;
  centre: GeoPoint;
  /** Semi-axes in degrees; the long axis follows the storm's bearing. */
  radiusLngDeg: number;
  radiusLatDeg: number;
  bearingDeg: number;
  cells: StormCell[];
}

const CELL_COUNT = 11;
// Region size, in degrees, matching the handoff's ~15° × 8.4° sample.
const MIN_LNG_RADIUS = 5.5;
const MAX_LNG_RADIUS = 9;
const LAT_RATIO = 0.56;
// The storm is anchored between these fractions of the route so it always crosses real water
// on the planned path and never sits on top of a shore.
const MIN_ROUTE_FRACTION = 0.15;
const MAX_ROUTE_FRACTION = 0.85;

const wrapLng = (lng: number) => {
  let x = ((((lng + 180) % 360) + 360) % 360) - 180;
  if (x === -180) x = 180;
  return x;
};

// The point at `fraction` of a polyline's length, in unwrapped longitude space so a Pacific
// route is sampled along the short way across the antimeridian.
export function pointAlongRoute(points: GeoPoint[], fraction: number): GeoPoint | null {
  const pts = unwrapAntimeridian(points);
  if (pts.length === 0) return null;
  if (pts.length === 1) return pts[0]!;
  const segments: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i]!.lng - pts[i - 1]!.lng, pts[i]!.lat - pts[i - 1]!.lat);
    segments.push(len);
    total += len;
  }
  if (total === 0) return pts[0]!;
  let target = Math.min(1, Math.max(0, fraction)) * total;
  for (let i = 0; i < segments.length; i++) {
    const len = segments[i]!;
    if (target <= len || i === segments.length - 1) {
      const t = len === 0 ? 0 : Math.min(1, target / len);
      const a = pts[i]!;
      const b = pts[i + 1]!;
      return { lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t };
    }
    target -= len;
  }
  return pts[pts.length - 1]!;
}

// Builds the storm that sits on `points`. `seed` comes from the schedule, so the storm keeps its
// shape and position for its whole lifetime and across clients.
export function stormGeometry(
  id: string,
  bottleId: string,
  points: GeoPoint[],
  seed: number,
): StormGeometry | null {
  const fraction = MIN_ROUTE_FRACTION + draw(seed, 3) * (MAX_ROUTE_FRACTION - MIN_ROUTE_FRACTION);
  const anchor = pointAlongRoute(points, fraction);
  if (!anchor) return null;
  const radiusLngDeg = MIN_LNG_RADIUS + draw(seed, 4) * (MAX_LNG_RADIUS - MIN_LNG_RADIUS);
  const radiusLatDeg = radiusLngDeg * LAT_RATIO;
  const bearingDeg = draw(seed, 5) * 360;
  const cells: StormCell[] = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    // Cells fill the ellipse: an angle and a radius that never reaches the rim, so the mass
    // stays inside the advisory boundary.
    const angle = draw(seed, 10 + i * 3) * Math.PI * 2;
    const r = Math.sqrt(draw(seed, 11 + i * 3)) * 0.78;
    cells.push({
      lng: wrapLng(anchor.lng + Math.cos(angle) * radiusLngDeg * r),
      lat: Math.max(-84, Math.min(84, anchor.lat + Math.sin(angle) * radiusLatDeg * r)),
      s: 0.7 + draw(seed, 12 + i * 3) * 0.55,
    });
  }
  return {
    id,
    bottleId,
    centre: { lng: wrapLng(anchor.lng), lat: anchor.lat },
    radiusLngDeg,
    radiusLatDeg,
    bearingDeg,
    cells,
  };
}

type Ring = Array<[number, number]>;

// The storm boundary as a closed ring in continuous (possibly out-of-range) longitudes.
function ellipseRing(storm: StormGeometry, steps = 72): Ring {
  const ring: Ring = [];
  const rot = (storm.bearingDeg * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    // A gentle wobble so the edge reads as weather rather than as a drawn ellipse.
    const wobble = 1 + Math.sin(a * 3 + storm.bearingDeg) * 0.06;
    const x = Math.cos(a) * storm.radiusLngDeg * wobble;
    const y = Math.sin(a) * storm.radiusLatDeg * wobble;
    ring.push([
      storm.centre.lng + x * cos - y * sin,
      Math.max(-85, Math.min(85, storm.centre.lat + x * sin * 0.5 + y * cos)),
    ]);
  }
  return ring;
}

// Sutherland–Hodgman clip of a ring against a vertical half-plane in longitude.
function clipHalfPlane(ring: Ring, boundary: number, keepBelow: boolean): Ring {
  const inside = (p: [number, number]) => (keepBelow ? p[0] <= boundary : p[0] >= boundary);
  const out: Ring = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const aIn = inside(a);
    const bIn = inside(b);
    if (aIn) out.push(a);
    if (aIn !== bIn && a[0] !== b[0]) {
      const t = (boundary - a[0]) / (b[0] - a[0]);
      out.push([boundary, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

const shiftRing = (ring: Ring, by: number): Ring => ring.map(([x, y]) => [x + by, y]);
const closeRing = (ring: Ring): Ring =>
  ring.length > 0 &&
  (ring[0]![0] !== ring[ring.length - 1]![0] || ring[0]![1] !== ring[ring.length - 1]![1])
    ? [...ring, ring[0]!]
    : ring;

// The storm region as GeoJSON. A region that straddles ±180° is split into two polygons and
// each half is shifted back into range, so a Pacific storm draws in one piece on the map
// instead of smearing around the world.
export function stormRegionFeature(storm: StormGeometry): GeoJSON.Feature {
  const ring = ellipseRing(storm);
  const minLng = Math.min(...ring.map((p) => p[0]));
  const maxLng = Math.max(...ring.map((p) => p[0]));
  let geometry: GeoJSON.Geometry;
  if (maxLng <= 180 && minLng >= -180) {
    geometry = { type: 'Polygon', coordinates: [closeRing(ring)] };
  } else {
    const boundary = maxLng > 180 ? 180 : -180;
    const inner = clipHalfPlane(ring, boundary, maxLng > 180);
    const outer = clipHalfPlane(ring, boundary, maxLng <= 180);
    const shifted = shiftRing(outer, maxLng > 180 ? -360 : 360);
    geometry = {
      type: 'MultiPolygon',
      coordinates: [inner, shifted].filter((r) => r.length >= 3).map((r) => [closeRing(r)]),
    };
  }
  return { type: 'Feature', properties: { id: storm.id }, geometry };
}

export function stormCellFeatures(storms: StormGeometry[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: storms.flatMap((storm) =>
      storm.cells.map((cell, i) => ({
        type: 'Feature' as const,
        properties: { s: cell.s, i, storm: storm.id },
        geometry: { type: 'Point' as const, coordinates: [cell.lng, cell.lat] },
      })),
    ),
  };
}

export function stormRegionFeatures(storms: StormGeometry[]): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: storms.map(stormRegionFeature) };
}
