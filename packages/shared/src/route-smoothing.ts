import type { GeoPoint } from './api.js';

// A smoother *drawing* of a planned sea route (manual review round 1, item 8). The server's
// route is a chain of waypoints on a one-degree water grid, so it turns in sharp steps. Each
// interior corner is replaced by a short curve that starts a little before the corner and
// ends a little after it; the endpoints stay exactly where they are.
//
// Rendering only: the stored route, its length, the journey's duration, storm timing and risk
// are all computed from the server's waypoints and never from this curve.
//
// It stays on the water. For each corner the largest cut is tried first and accepted only if
// the whole curve is sea according to `isLand` (the same land polygons the map draws); a
// smaller cut is tried next, and a corner no cut fits is drawn as it is. Without a land test
// only a tiny, blind-safe cut is used. Cuts never exceed a fraction of the shorter adjacent
// leg, so dense legs — straits, canals and harbour approaches — keep their shape. `geo.test.ts`
// in the API checks the result against an independent land mask across the real sea graph.
//
// Input longitudes must already be continuous across the antimeridian.

export type LandTest = (lng: number, lat: number) => boolean;

export const CUT_CANDIDATES_KM = [70, 40, 20, 10] as const;
export const BLIND_CUT_KM = 5;
const CUT_FRACTION = 0.45;
// Straighter than this (the turn, in degrees) is drawn as it is.
const MIN_TURN_DEG = 8;
const SAMPLE_KM = 2;
const KM_PER_DEG = 111.32;

export function smoothRoute(points: GeoPoint[], isLand?: LandTest): GeoPoint[] {
  if (points.length < 3) return points.slice();
  const out: GeoPoint[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    // The first and last corners sit on a harbour approach, which hugs the coast by design:
    // they get only the tiny blind cut.
    const approach = i === 1 || i === points.length - 2;
    const curve = roundCorner(
      points[i - 1]!,
      points[i]!,
      points[i + 1]!,
      approach ? undefined : isLand,
    );
    if (curve) out.push(...curve);
    else out.push(points[i]!);
  }
  out.push(points[points.length - 1]!);
  return out;
}

function roundCorner(p: GeoPoint, v: GeoPoint, n: GeoPoint, isLand?: LandTest): GeoPoint[] | null {
  // A local frame at the corner, in km: longitude scaled by cos(latitude).
  const k = Math.cos((v.lat * Math.PI) / 180) || 1e-6;
  const ax = (p.lng - v.lng) * k * KM_PER_DEG;
  const ay = (p.lat - v.lat) * KM_PER_DEG;
  const bx = (n.lng - v.lng) * k * KM_PER_DEG;
  const by = (n.lat - v.lat) * KM_PER_DEG;
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la === 0 || lb === 0) return null;
  const cos = (ax * bx + ay * by) / (la * lb);
  const turn = 180 - (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  if (turn < MIN_TURN_DEG) return null;
  const limit = CUT_FRACTION * Math.min(la, lb);
  const cuts = isLand ? CUT_CANDIDATES_KM : [BLIND_CUT_KM];
  for (const wanted of cuts) {
    const cut = Math.min(wanted, limit);
    const a = {
      lng: v.lng + (ax / la) * (cut / (k * KM_PER_DEG)),
      lat: v.lat + (ay / la) * (cut / KM_PER_DEG),
    };
    const b = {
      lng: v.lng + (bx / lb) * (cut / (k * KM_PER_DEG)),
      lat: v.lat + (by / lb) * (cut / KM_PER_DEG),
    };
    // A quadratic curve from a to b, pulled towards the corner, sampled finely enough to test.
    const steps = Math.max(6, Math.ceil((2 * cut) / SAMPLE_KM));
    const curve: GeoPoint[] = [];
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const u = 1 - t;
      curve.push({
        lng: u * u * a.lng + 2 * u * t * v.lng + t * t * b.lng,
        lat: u * u * a.lat + 2 * u * t * v.lat + t * t * b.lat,
      });
    }
    if (!isLand || !curve.some((c) => nearLand(isLand, c))) return thin(curve);
    if (cut === limit) break; // a smaller candidate would be the same cut
  }
  return null;
}

// A curve point must keep some clearance from the coast, not merely be off it: the land file
// is a generalised coastline, and a curve grazing it reads as touching land on the map.
const CLEARANCE_DEG = 0.1;
function nearLand(isLand: LandTest, c: GeoPoint): boolean {
  const dx = CLEARANCE_DEG / (Math.cos((c.lat * Math.PI) / 180) || 1e-6);
  return (
    isLand(c.lng, c.lat) ||
    isLand(c.lng + dx, c.lat) ||
    isLand(c.lng - dx, c.lat) ||
    isLand(c.lng, c.lat + CLEARANCE_DEG) ||
    isLand(c.lng, c.lat - CLEARANCE_DEG)
  );
}

// The curve is tested densely but drawn with a handful of points.
function thin(curve: GeoPoint[]): GeoPoint[] {
  if (curve.length <= 9) return curve;
  const out: GeoPoint[] = [];
  for (let s = 0; s <= 8; s++) out.push(curve[Math.round((s / 8) * (curve.length - 1))]!);
  return out;
}

// ---------- the land test, from the map's own land polygons ----------

type Position = [number, number] | number[];
interface LandFeature {
  geometry:
    | { type: 'Polygon'; coordinates: Position[][] }
    | { type: 'MultiPolygon'; coordinates: Position[][][] };
}

// The polygons rasterised once into a one-bit-per-cell world grid (0.05°, about 3 MB), so
// each test is a single lookup. Rings are filled even-odd per scanline, so holes (lakes, inland
// seas) come out as water. A cell is land when its centre is.
export const LAND_RES_DEG = 0.05;
const W = Math.round(360 / LAND_RES_DEG);
const H = Math.round(180 / LAND_RES_DEG);

export function landTestFrom(collection: { features: LandFeature[] }): LandTest {
  const bits = new Uint8Array(Math.ceil((W * H) / 8));
  const flip = (r: number, c0: number, c1: number) => {
    for (let c = c0; c <= c1; c++) {
      const i = r * W + (((c % W) + W) % W);
      bits[i >> 3]! ^= 1 << (i & 7);
    }
  };
  for (const f of collection.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys)
      for (const ring of poly) {
        // Crossings per row, then flip the cells between each pair: even-odd over all rings.
        const rows = new Map<number, number[]>();
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const x1 = ring[j]![0];
          const y1 = ring[j]![1];
          const x2 = ring[i]![0];
          const y2 = ring[i]![1];
          if (y1 === y2) continue;
          const lo = Math.min(y1, y2);
          const hi = Math.max(y1, y2);
          const r0 = Math.max(0, Math.ceil((lo + 90) / LAND_RES_DEG - 0.5));
          const r1 = Math.min(H - 1, Math.floor((hi + 90) / LAND_RES_DEG - 0.5));
          for (let r = r0; r <= r1; r++) {
            const y = (r + 0.5) * LAND_RES_DEG - 90;
            if (y < lo || y >= hi) continue;
            let xs = rows.get(r);
            if (!xs) rows.set(r, (xs = []));
            xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
          }
        }
        for (const [r, xs] of rows) {
          xs.sort((p, q) => p - q);
          for (let k = 0; k + 1 < xs.length; k += 2) {
            const c0 = Math.ceil((xs[k]! + 180) / LAND_RES_DEG - 0.5);
            const c1 = Math.floor((xs[k + 1]! + 180) / LAND_RES_DEG - 0.5);
            if (c1 >= c0) flip(r, c0, c1);
          }
        }
      }
  }
  return (lng, lat) => {
    const r = Math.floor((lat + 90) / LAND_RES_DEG);
    if (r < 0 || r >= H) return false;
    const c = ((Math.floor((lng + 180) / LAND_RES_DEG) % W) + W) % W;
    const i = r * W + c;
    return (bits[i >> 3]! & (1 << (i & 7))) !== 0;
  };
}
