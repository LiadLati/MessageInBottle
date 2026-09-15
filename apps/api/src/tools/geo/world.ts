// Offline world geometry helpers shared by the sea-graph generator and the geo regression tests.
// Data: world-atlas 2.0.2 (ISC), a TopoJSON redistribution of Natural Earth 4.1.0 (public
// domain). Nothing here touches the network.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as topojson from 'topojson-client';
import type { GeometryCollection, MultiPolygon, Polygon, Topology } from 'topojson-specification';

const require = createRequire(import.meta.url);

export const WORLD_ATLAS_VERSION = '2.0.2';
export const NATURAL_EARTH_VERSION = '4.1.0';

export type Ring = Array<[number, number]>;

export interface CountryFeature {
  id: string | null;
  name: string;
  bbox: [number, number, number, number];
  polygons: Ring[][]; // polygon -> rings (outer first)
}

export interface World {
  countries: CountryFeature[];
  coastalIds: Set<string>; // keyed by `${id ?? 'x'}:${name}`
  landPolygons: Ring[][];
  bordersMesh: GeoJSON.MultiLineString;
  coastMesh: GeoJSON.MultiLineString;
}

export function countryKey(c: { id: string | null; name: string }): string {
  return `${c.id ?? 'x'}:${c.name}`;
}

function readTopology(file: string): Topology {
  return JSON.parse(fs.readFileSync(require.resolve(`world-atlas/${file}`), 'utf8')) as Topology;
}

// Rings that straddle the antimeridian are stored with ±180 stitches (…179.9 → -180…). Unwrap
// them into a continuous longitude run so ray casting and scanline filling see one ring; the
// consumers below test longitudes modulo 360.
function unwrapRing(ring: Ring): Ring {
  const out: Ring = [];
  let offset = 0;
  let prev: number | null = null;
  for (const [x, y] of ring) {
    if (prev !== null) {
      if (x - prev > 180) offset -= 360;
      else if (x - prev < -180) offset += 360;
    }
    prev = x;
    out.push([x + offset, y]);
  }
  return out;
}

function polygonsOf(geom: GeoJSON.Geometry): Ring[][] {
  const polys =
    geom.type === 'Polygon'
      ? [geom.coordinates as Ring[]]
      : geom.type === 'MultiPolygon'
        ? (geom.coordinates as Ring[][])
        : [];
  return polys.map((poly) => poly.map(unwrapRing));
}

function bboxOf(polys: Ring[][]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of polys)
    for (const ring of poly)
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  return [minX, minY, maxX, maxY];
}

export function loadWorld(): World {
  const countriesTopo = readTopology('countries-50m.json');
  const landTopo = readTopology('land-50m.json');
  const countriesObj = countriesTopo.objects.countries as GeometryCollection<{ name: string }>;
  const landObj = landTopo.objects.land as GeometryCollection;

  const fc = topojson.feature(countriesTopo, countriesObj);
  const countries: CountryFeature[] = fc.features.map((f) => {
    const polygons = polygonsOf(f.geometry);
    return {
      id: f.id === undefined ? null : String(f.id),
      name: f.properties.name,
      bbox: bboxOf(polygons),
      polygons,
    };
  });

  // An arc used by exactly one geometry separates that geometry from the sea: any country that
  // owns such an arc has a coastline. Arcs shared by two geometries are land borders.
  const arcUsers = new Map<number, Set<number>>();
  const collectArcs = (g: Polygon | MultiPolygon, idx: number) => {
    const rings = g.type === 'Polygon' ? g.arcs : g.arcs.flat();
    for (const ring of rings)
      for (const a of ring) {
        const abs = a < 0 ? ~a : a;
        let set = arcUsers.get(abs);
        if (!set) arcUsers.set(abs, (set = new Set()));
        set.add(idx);
      }
  };
  countriesObj.geometries.forEach((g, idx) => {
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') collectArcs(g, idx);
  });
  const coastalIdx = new Set<number>();
  for (const users of arcUsers.values()) if (users.size === 1) coastalIdx.add([...users][0]!);
  const coastalIds = new Set<string>();
  coastalIdx.forEach((idx) => coastalIds.add(countryKey(countries[idx]!)));

  const landPolygons = topojson
    .feature(landTopo, landObj)
    .features.flatMap((f) => polygonsOf(f.geometry));

  return {
    countries,
    coastalIds,
    landPolygons,
    bordersMesh: topojson.mesh(countriesTopo, countriesObj, (a, b) => a !== b),
    // Islands too small for land-50m still have a polygon in countries-50m; take both coasts.
    coastMesh: {
      type: 'MultiLineString',
      coordinates: [
        ...topojson.mesh(landTopo, landObj).coordinates,
        ...topojson.mesh(countriesTopo, countriesObj, (a, b) => a === b).coordinates,
      ],
    },
  };
}

// ---------- geometry ----------
const EARTH_KM = 6371;
const toRad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(aLng: number, aLat: number, bLng: number, bLat: number): number {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function rayCast(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  return rayCast(lng, lat, ring) || rayCast(lng + 360, lat, ring) || rayCast(lng - 360, lat, ring);
}

export function pointInPolygons(lng: number, lat: number, polys: Ring[][]): boolean {
  for (const poly of polys) {
    const [outer, ...holes] = poly;
    if (!outer || !pointInRing(lng, lat, outer)) continue;
    if (holes.some((h) => pointInRing(lng, lat, h))) continue;
    return true;
  }
  return false;
}

export function countryAt(world: World, lng: number, lat: number): CountryFeature | null {
  for (const c of world.countries) {
    const [minX, minY, maxX, maxY] = c.bbox;
    if (lat < minY || lat > maxY) continue;
    if (
      (lng < minX || lng > maxX) &&
      (lng + 360 < minX || lng + 360 > maxX) &&
      (lng - 360 < minX || lng - 360 > maxX)
    )
      continue;
    if (pointInPolygons(lng, lat, c.polygons)) return c;
  }
  return null;
}

// ---------- land mask ----------
export const MASK_RES = 0.05; // degrees per cell (~5.5 km at the equator)
const MASK_W = Math.round(360 / MASK_RES);
const MASK_H = Math.round(180 / MASK_RES);

export class LandMask {
  private readonly cells = new Uint8Array(MASK_W * MASK_H);

  constructor(polygons: Ring[][]) {
    // Outer rings paint land, holes (lakes, inland seas) erase it. Each ring is filled on its
    // own with an even-odd scanline so unwrapped rings that run past ±180 wrap correctly.
    for (const poly of polygons) if (poly[0]) this.paintRing(poly[0], 1);
    for (const poly of polygons) for (const hole of poly.slice(1)) this.paintRing(hole, 0);
  }

  private paintRing(ring: Ring, value: 0 | 1): void {
    const rows = new Map<number, number[]>();
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[j]!;
      const [x2, y2] = ring[i]!;
      if (y1 === y2) continue;
      const yLo = Math.min(y1, y2);
      const yHi = Math.max(y1, y2);
      const rStart = Math.max(0, Math.ceil((yLo + 90) / MASK_RES - 0.5));
      const rEnd = Math.min(MASK_H - 1, Math.floor((yHi + 90) / MASK_RES - 0.5));
      for (let r = rStart; r <= rEnd; r++) {
        const y = (r + 0.5) * MASK_RES - 90;
        if (y < yLo || y >= yHi) continue;
        let list = rows.get(r);
        if (!list) rows.set(r, (list = []));
        list.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
    }
    for (const [r, xs] of rows) {
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) this.fillSpan(r, xs[k]!, xs[k + 1]!, value);
    }
  }

  private fillSpan(r: number, xa: number, xb: number, value: 0 | 1): void {
    const shift = Math.floor((xa + 180) / 360) * 360;
    const a = xa - shift;
    const b = xb - shift;
    if (b >= 180) {
      this.fillCells(r, a, 180, value);
      this.fillCells(r, -180, b - 360, value);
    } else this.fillCells(r, a, b, value);
  }

  private fillCells(r: number, xa: number, xb: number, value: 0 | 1): void {
    const cStart = Math.max(0, Math.ceil((xa + 180) / MASK_RES - 0.5));
    const cEnd = Math.min(MASK_W - 1, Math.floor((xb + 180) / MASK_RES - 0.5));
    for (let c = cStart; c <= cEnd; c++) this.cells[r * MASK_W + c] = value;
  }

  isLand(lng: number, lat: number): boolean {
    let x = lng;
    while (x < -180) x += 360;
    while (x >= 180) x -= 360;
    const c = Math.min(MASK_W - 1, Math.max(0, Math.floor((x + 180) / MASK_RES)));
    const r = Math.min(MASK_H - 1, Math.max(0, Math.floor((lat + 90) / MASK_RES)));
    return this.cells[r * MASK_W + c] === 1;
  }

  // Samples the shorter great-circle-ish segment (linear in degrees after unwrapping the
  // antimeridian) every `stepKm` and reports the land samples with their distance from `a`.
  landAlong(
    aLng: number,
    aLat: number,
    bLng: number,
    bLat: number,
    stepKm = 4,
  ): { samples: number; land: number; firstLandKm: number; lastLandKm: number } {
    let dLng = bLng - aLng;
    if (dLng > 180) dLng -= 360;
    if (dLng < -180) dLng += 360;
    const km = haversineKm(aLng, aLat, bLng, bLat);
    const n = Math.max(2, Math.ceil(km / stepKm));
    let land = 0;
    let firstLandKm = Infinity;
    let lastLandKm = -Infinity;
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      if (this.isLand(aLng + dLng * f, aLat + (bLat - aLat) * f)) {
        land++;
        firstLandKm = Math.min(firstLandKm, km * f);
        lastLandKm = Math.max(lastLandKm, km * f);
      }
    }
    return { samples: n + 1, land, firstLandKm, lastLandKm };
  }
}

// A leg is "inland" when some sample on it is on land *and* clearly away from any coastline.
// Channels narrower than the mask resolution read as land right next to the coast, which is
// exactly what a strait looks like; a sample deep inside a landmass is a real crossing.
export function legInlandKm(
  mask: LandMask,
  coast: CoastIndex,
  aLng: number,
  aLat: number,
  bLng: number,
  bLat: number,
  stepKm = 3,
): number {
  let dLng = bLng - aLng;
  if (dLng > 180) dLng -= 360;
  if (dLng < -180) dLng += 360;
  const km = haversineKm(aLng, aLat, bLng, bLat);
  const n = Math.max(2, Math.ceil(km / stepKm));
  let worst = 0;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const lng = aLng + dLng * f;
    const lat = aLat + (bLat - aLat) * f;
    if (mask.isLand(lng, lat)) worst = Math.max(worst, coast.nearestKm(lng, lat, 1));
  }
  return worst;
}

// ---------- coast distance ----------
// Distance to the nearest coastline *segment* (1:50m vertices can be tens of kilometres apart
// along straight coasts, so vertex distance alone would misjudge a harbour on a beach).
type Segment = [number, number, number, number];

export class CoastIndex {
  private readonly buckets = new Map<string, Segment[]>();

  constructor(mesh: GeoJSON.MultiLineString) {
    for (const line of mesh.coordinates)
      for (let i = 1; i < line.length; i++) {
        const [x1, y1] = line[i - 1]!;
        const [x2, y2] = line[i]!;
        if (Math.abs(x1! - x2!) > 180) continue; // antimeridian stitch, never a real coast
        const seg: Segment = [x1!, y1!, x2!, y2!];
        for (let bx = Math.floor(Math.min(x1!, x2!)); bx <= Math.floor(Math.max(x1!, x2!)); bx++)
          for (
            let by = Math.floor(Math.min(y1!, y2!));
            by <= Math.floor(Math.max(y1!, y2!));
            by++
          ) {
            const key = `${bx}:${by}`;
            let list = this.buckets.get(key);
            if (!list) this.buckets.set(key, (list = []));
            list.push(seg);
          }
      }
  }

  private static segmentKm(lng: number, lat: number, [x1, y1, x2, y2]: Segment): number {
    const k = Math.cos(toRad(lat));
    const px = 0;
    const py = 0;
    const ax = (x1 - lng) * k;
    const ay = y1 - lat;
    const bx = (x2 - lng) * k;
    const by = y2 - lat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const cx = ax + dx * t;
    const cy = ay + dy * t;
    return Math.hypot(cx, cy) * 111.19;
  }

  nearestKm(lng: number, lat: number, maxRingDeg = 3): number {
    let best = Infinity;
    const cx = Math.floor(lng);
    const cy = Math.floor(lat);
    for (let ring = 0; ring <= maxRingDeg; ring++) {
      for (let dx = -ring; dx <= ring; dx++)
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          let bx = cx + dx;
          if (bx < -180) bx += 360;
          if (bx >= 180) bx -= 360;
          const list = this.buckets.get(`${bx}:${cy + dy}`);
          if (!list) continue;
          for (const seg of list) best = Math.min(best, CoastIndex.segmentKm(lng, lat, seg));
        }
      // Anything in a farther ring is at least `ring` degrees of latitude away.
      if (best < ring * 100) break;
    }
    return best;
  }
}
