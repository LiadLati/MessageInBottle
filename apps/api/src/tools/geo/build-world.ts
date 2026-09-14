// Generates the bundled world data for the map and the sea-route graph (version 2):
//   apps/web/public/map/borders-50m.geojson      interior admin-0 boundaries (line work only)
//   apps/api/src/db/geo/data/sea-graph.v2.json    water grid + straits/canals + shore connectors
//   apps/api/src/db/geo/data/coverage.json        machine-readable coastal coverage
//   docs/SHORE_COVERAGE.md                        human-readable coverage report
// Run from apps/api: `pnpm exec tsx src/tools/geo/build-world.ts`. Deterministic and offline.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLOBAL_SHORES, type CatalogueShore } from '../../db/geo/shores.js';
import { SEED_NODES, SEED_SHORES } from '../../db/seed-data.js';
import { CHANNELS, EXCLUSION_REASONS, NOT_IN_DATASET } from './channels.js';
import {
  CoastIndex,
  LandMask,
  NATURAL_EARTH_VERSION,
  WORLD_ATLAS_VERSION,
  countryKey,
  haversineKm,
  legInlandKm,
  loadWorld,
  pointInPolygons,
  type CountryFeature,
} from './world.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../..');
const OUT_BORDERS = path.join(repoRoot, 'apps/web/public/map/borders-50m.geojson');
const OUT_GRAPH = path.join(repoRoot, 'apps/api/src/db/geo/data/sea-graph.v2.json');
const OUT_COVERAGE = path.join(repoRoot, 'apps/api/src/db/geo/data/coverage.json');
const OUT_REPORT = path.join(repoRoot, 'docs/SHORE_COVERAGE.md');

export const GRAPH_VERSION = 2;
const GRID_DEG = 1;
const LAT_MIN = -65;
const LAT_MAX = 75;
const KM_PER_CHART_UNIT = 50; // keeps v1's pace: ~50 km of sea per hour of journey
const COAST_MAX_KM = 30; // a catalogued shore must sit this close to the 50m coastline
const CONNECTOR_MAX_KM = 700;
const CONNECTOR_LAND_NEAR_SHORE_KM = 40; // harbours sit behind headlands; allow land only there
const CHANNEL_LINK_DEG = 1.6;
const CHANNEL_INLAND_KM = 8; // land samples on a strait leg must hug a coast this closely

const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

const world = loadWorld();
log(`loaded world: ${world.countries.length} geometries, ${world.coastalIds.size} coastal`);
const mask = new LandMask(world.landPolygons);
log('rasterised land mask');
const coast = new CoastIndex(world.coastMesh);
log('indexed coastline');

// ---------- 1. borders ----------
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const borders: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        source: 'Natural Earth Admin 0 – Countries, 1:50m',
        naturalEarthVersion: NATURAL_EARTH_VERSION,
        via: `world-atlas@${WORLD_ATLAS_VERSION} countries-50m.json`,
        licence: 'Natural Earth: public domain; world-atlas: ISC',
      },
      geometry: {
        type: 'MultiLineString',
        coordinates: world.bordersMesh.coordinates.map((line) =>
          line.map(([x, y]) => [round3(x!), round3(y!)]),
        ),
      },
    },
  ],
};
fs.writeFileSync(OUT_BORDERS, JSON.stringify(borders));
log(`wrote borders (${(fs.statSync(OUT_BORDERS).size / 1024).toFixed(0)} KB)`);

// ---------- 2. verify the shore catalogue ----------
// Dataset ids are not unique (a territory can carry its parent's ISO number, e.g. Ashmore and
// Cartier Is. under Australia's 036), and a few geometries have none, so a shore names its
// geometry by id *and* name.
const findCountry = (s: CatalogueShore): CountryFeature | undefined =>
  world.countries.find((c) => c.id === s.country && c.name === s.countryName);

const problems: string[] = [];
const ids = new Set<string>();
for (const s of GLOBAL_SHORES) {
  if (ids.has(s.id)) problems.push(`${s.id}: duplicate id`);
  ids.add(s.id);
  if (SEED_SHORES.some((legacy) => legacy.id === s.id))
    problems.push(`${s.id}: collides with a legacy shore id`);
  const km = coast.nearestKm(s.lng, s.lat);
  if (km > COAST_MAX_KM) problems.push(`${s.id}: ${km.toFixed(1)} km from the coastline`);
  const c = findCountry(s);
  if (!c) {
    if (s.country !== null || !NOT_IN_DATASET.has(s.countryName))
      problems.push(`${s.id}: no dataset geometry ${s.country ?? '(no id)'} '${s.countryName}'`);
    continue;
  }
  // Harbour points often fall a few hundred metres into the water and small islands are
  // generalised at 1:50m; probe a small star around the point.
  const probes: Array<[number, number]> = [[s.lng, s.lat]];
  for (const d of [0.03, 0.08, 0.15, 0.25])
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ])
      probes.push([s.lng + dx! * d, s.lat + dy! * d]);
  if (!probes.some(([x, y]) => pointInPolygons(x, y, c.polygons)))
    problems.push(`${s.id}: no probe point lies inside ${c.name}`);
}
if (problems.length) {
  console.error('Shore catalogue verification failed:\n' + problems.join('\n'));
  process.exit(1);
}
log(`verified ${GLOBAL_SHORES.length} catalogue shores`);

// ---------- 3. water grid ----------
interface GNode {
  id: string;
  kind: 'shore' | 'waypoint' | 'island';
  shoreId: string | null;
  lng: number;
  lat: number;
}
interface GEdge {
  a: number;
  b: number;
  km: number;
}
const nodes: GNode[] = [];
const edges: GEdge[] = [];
const edgeKeys = new Set<string>();
const index = new Map<string, number>();
const addNode = (n: GNode): number => {
  const i = nodes.length;
  nodes.push(n);
  index.set(n.id, i);
  return i;
};
const addEdge = (a: number, b: number): void => {
  if (a === b) return;
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  if (edgeKeys.has(key)) return;
  edgeKeys.add(key);
  const na = nodes[a]!;
  const nb = nodes[b]!;
  edges.push({ a, b, km: haversineKm(na.lng, na.lat, nb.lng, nb.lat) });
};

const cols = Math.round(360 / GRID_DEG);
const rows = Math.round((LAT_MAX - LAT_MIN) / GRID_DEG);
const grid: Array<number | null> = new Array<number | null>(cols * rows).fill(null);
const cellLng = (c: number) => -180 + (c + 0.5) * GRID_DEG;
const cellLat = (r: number) => LAT_MIN + (r + 0.5) * GRID_DEG;
for (let r = 0; r < rows; r++)
  for (let c = 0; c < cols; c++) {
    const lng = cellLng(c);
    const lat = cellLat(r);
    if (mask.isLand(lng, lat)) continue;
    grid[r * cols + c] = addNode({ id: `w_${c}_${r}`, kind: 'waypoint', shoreId: null, lng, lat });
  }
const gridNodeCount = nodes.length;
log(`water grid: ${gridNodeCount} nodes`);

const clearWater = (a: GNode, b: GNode) => mask.landAlong(a.lng, a.lat, b.lng, b.lat).land === 0;
const STEPS: Array<[number, number]> = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];
for (let r = 0; r < rows; r++)
  for (let c = 0; c < cols; c++) {
    const a = grid[r * cols + c];
    if (a === null || a === undefined) continue;
    for (const [dc, dr] of STEPS) {
      const rr = r + dr;
      if (rr < 0 || rr >= rows) continue;
      const cc = (c + dc + cols) % cols; // wraps across the antimeridian
      const b = grid[rr * cols + cc];
      if (b === null || b === undefined) continue;
      if (clearWater(nodes[a]!, nodes[b]!)) addEdge(a, b);
    }
  }
log(`grid edges: ${edges.length}`);

// ---------- 4. straits and canals ----------
const nearestNodes = (lng: number, lat: number, maxKm: number, limit: number, pool: number[]) =>
  pool
    .map((i) => ({ i, km: haversineKm(lng, lat, nodes[i]!.lng, nodes[i]!.lat) }))
    .filter((x) => x.km <= maxKm)
    .sort((x, y) => x.km - y.km)
    .slice(0, limit);

const gridPool = Array.from({ length: gridNodeCount }, (_, i) => i);
const channelProblems: string[] = [];
for (const ch of CHANNELS) {
  const ix: number[] = [];
  ch.points.forEach(([lng, lat], k) => {
    // Channels narrower than the mask resolution read as land; a point is only wrong when
    // it is on land *and* clearly away from any coastline.
    if (!ch.canal && mask.isLand(lng, lat) && coast.nearestKm(lng, lat) > 6)
      channelProblems.push(`${ch.id} point ${k} (${lng}, ${lat}) is inland`);
    ix.push(addNode({ id: `c_${ch.id}_${k}`, kind: 'waypoint', shoreId: null, lng, lat }));
  });
  for (let k = 1; k < ix.length; k++) {
    const a = nodes[ix[k - 1]!]!;
    const b = nodes[ix[k]!]!;
    const inland = legInlandKm(mask, coast, a.lng, a.lat, b.lng, b.lat);
    if (!ch.canal && inland > CHANNEL_INLAND_KM)
      channelProblems.push(`${ch.id} leg ${k - 1}->${k} runs ${inland.toFixed(1)} km inland`);
    addEdge(ix[k - 1]!, ix[k]!);
  }
  // Every channel point may join the grid; narrow water is forgiven up to a fraction.
  for (const i of ix) {
    const n = nodes[i]!;
    let linked = 0;
    for (const cand of nearestNodes(n.lng, n.lat, CHANNEL_LINK_DEG * 111, 12, gridPool)) {
      const m = nodes[cand.i]!;
      if (legInlandKm(mask, coast, n.lng, n.lat, m.lng, m.lat) <= CHANNEL_INLAND_KM) {
        addEdge(i, cand.i);
        linked++;
      }
      if (linked >= 4) break;
    }
  }
}
if (channelProblems.length) {
  console.error('Channel definitions failed:\n' + channelProblems.join('\n'));
  process.exit(1);
}
log(`channels: ${CHANNELS.length}, edges now ${edges.length}`);

// ---------- 5. shores ----------
interface ShoreSpec {
  id: string;
  lng: number;
  lat: number;
}
const legacyIsland = SEED_NODES.find((n) => n.kind === 'island')!;
const shoreSpecs: ShoreSpec[] = [
  ...SEED_SHORES.map((s) => ({ id: s.id, lng: s.lng, lat: s.lat })),
  ...GLOBAL_SHORES.map((s) => ({ id: s.id, lng: s.lng, lat: s.lat })),
];
const approximate: string[] = [];
const waterPool = Array.from({ length: nodes.length }, (_, i) => i);
for (const s of shoreSpecs) {
  const i = addNode({ id: `n_${s.id}`, kind: 'shore', shoreId: s.id, lng: s.lng, lat: s.lat });
  let accepted = 0;
  let examined = 0;
  for (const cand of nearestNodes(s.lng, s.lat, CONNECTOR_MAX_KM, 80, waterPool)) {
    examined++;
    const m = nodes[cand.i]!;
    const probe = mask.landAlong(s.lng, s.lat, m.lng, m.lat);
    if (probe.land === 0 || probe.lastLandKm <= CONNECTOR_LAND_NEAR_SHORE_KM) {
      addEdge(i, cand.i);
      accepted++;
    }
    if (accepted >= 3 || (accepted >= 1 && examined >= 40)) break;
  }
  if (accepted === 0) {
    const [fallback] = nearestNodes(s.lng, s.lat, Infinity, 1, waterPool);
    if (!fallback) throw new Error(`no water node near ${s.id}`);
    addEdge(i, fallback.i);
    approximate.push(s.id);
  }
}
const islandIx = addNode({
  id: legacyIsland.id,
  kind: 'island',
  shoreId: null,
  lng: legacyIsland.lng,
  lat: legacyIsland.lat,
});
for (const cand of nearestNodes(legacyIsland.lng, legacyIsland.lat, 400, 2, gridPool))
  addEdge(islandIx, cand.i);
log(`shores: ${shoreSpecs.length} (${approximate.length} approximate connectors)`);

// ---------- 6. keep the ocean component only ----------
const adjacency: number[][] = nodes.map(() => []);
for (const e of edges) {
  adjacency[e.a]!.push(e.b);
  adjacency[e.b]!.push(e.a);
}
const component = new Int32Array(nodes.length).fill(-1);
let componentCount = 0;
for (let seed = 0; seed < nodes.length; seed++) {
  if (component[seed] !== -1) continue;
  const stack = [seed];
  component[seed] = componentCount;
  while (stack.length) {
    const v = stack.pop()!;
    for (const w of adjacency[v]!)
      if (component[w] === -1) {
        component[w] = componentCount;
        stack.push(w);
      }
  }
  componentCount++;
}
const shoresPerComponent = new Map<number, number>();
nodes.forEach((n, i) => {
  if (n.kind !== 'shore') return;
  shoresPerComponent.set(component[i]!, (shoresPerComponent.get(component[i]!) ?? 0) + 1);
});
const mainComponent = [...shoresPerComponent.entries()].sort((a, b) => b[1] - a[1])[0]![0];
const mainPool = waterPool.filter((i) => component[i] === mainComponent);
const rescued: string[] = [];
nodes.forEach((n, i) => {
  if (n.kind !== 'shore' || component[i] === mainComponent) return;
  const [near] = nearestNodes(n.lng, n.lat, Infinity, 1, mainPool);
  addEdge(i, near!.i);
  component[i] = mainComponent;
  rescued.push(n.shoreId!);
});
const keep = new Set<number>();
nodes.forEach((n, i) => {
  if (component[i] === mainComponent || n.kind !== 'waypoint') keep.add(i);
});
const remap = new Map<number, number>();
const outNodes: GNode[] = [];
for (const i of [...keep].sort((a, b) => a - b)) {
  remap.set(i, outNodes.length);
  outNodes.push(nodes[i]!);
}
const outEdges = edges
  .filter((e) => remap.has(e.a) && remap.has(e.b))
  .map((e) => [
    remap.get(e.a)!,
    remap.get(e.b)!,
    Math.max(1, Math.round(e.km / KM_PER_CHART_UNIT)),
  ]);
log(
  `ocean component: ${outNodes.length} nodes, ${outEdges.length} edges (${nodes.length - outNodes.length} lake/inland nodes dropped, ${rescued.length} shores rescued)`,
);

fs.writeFileSync(
  OUT_GRAPH,
  JSON.stringify({
    version: GRAPH_VERSION,
    generatedBy: 'apps/api/src/tools/geo/build-world.ts',
    source: {
      dataset: `world-atlas@${WORLD_ATLAS_VERSION} (Natural Earth ${NATURAL_EARTH_VERSION} land-50m, countries-50m)`,
      licence: 'Natural Earth: public domain; world-atlas: ISC',
    },
    kmPerChartUnit: KM_PER_CHART_UNIT,
    gridDegrees: GRID_DEG,
    approximateConnectors: [...new Set([...approximate, ...rescued])].sort(),
    nodes: outNodes.map((n) => [n.id, n.kind, n.shoreId, round3(n.lng), round3(n.lat)]),
    edges: outEdges,
  }),
);
log(`wrote sea graph (${(fs.statSync(OUT_GRAPH).size / 1024).toFixed(0)} KB)`);

// ---------- 7. coverage ----------
const shoresByCountry = new Map<string, CatalogueShore[]>();
for (const s of GLOBAL_SHORES) {
  const c = findCountry(s);
  const key = c ? countryKey(c) : `x:${s.countryName}`;
  const list = shoresByCountry.get(key) ?? [];
  list.push(s);
  shoresByCountry.set(key, list);
}
const coastal = world.countries
  .filter((c) => world.coastalIds.has(countryKey(c)))
  .sort((a, b) => a.name.localeCompare(b.name));
const landlocked = world.countries
  .filter((c) => !world.coastalIds.has(countryKey(c)))
  .sort((a, b) => a.name.localeCompare(b.name));
const centroid = (c: CountryFeature): [number, number] => {
  // Largest ring's vertex mean — good enough to pick a neighbouring harbour.
  let best: Array<[number, number]> = [];
  for (const poly of c.polygons) if ((poly[0]?.length ?? 0) > best.length) best = poly[0]!;
  const sx = best.reduce((acc, p) => acc + p[0], 0);
  const sy = best.reduce((acc, p) => acc + p[1], 0);
  return [sx / best.length, sy / best.length];
};
const included = coastal
  .filter((c) => (shoresByCountry.get(countryKey(c)) ?? []).length > 0)
  .map((c) => ({
    id: c.id,
    name: c.name,
    shores: shoresByCountry.get(countryKey(c))!.map((s) => s.id),
  }));
const excluded = coastal
  .filter((c) => (shoresByCountry.get(countryKey(c)) ?? []).length === 0)
  .map((c) => ({
    id: c.id,
    name: c.name,
    reason: EXCLUSION_REASONS[c.name] ?? null,
  }));
const unexplained = excluded.filter((e) => e.reason === null);
if (unexplained.length) {
  console.error(
    'Coastal geometries without a shore and without an exclusion reason:\n' +
      unexplained.map((e) => `  ${e.id ?? '-'} ${e.name}`).join('\n'),
  );
  process.exit(1);
}
const extraCountries = [...shoresByCountry.keys()]
  .filter((k) => k.startsWith('x:'))
  .map((k) => ({ name: k.slice(2), shores: shoresByCountry.get(k)!.map((s) => s.id) }));
const landlockedRows = landlocked.map((c) => {
  const [lng, lat] = centroid(c);
  let best: CatalogueShore | null = null;
  let bestKm = Infinity;
  for (const s of GLOBAL_SHORES) {
    const km = haversineKm(lng, lat, s.lng, s.lat);
    if (km < bestKm) {
      bestKm = km;
      best = s;
    }
  }
  return { id: c.id, name: c.name, nearestShoreId: best!.id, nearestShoreName: best!.name };
});
const coverage = {
  generatedBy: 'apps/api/src/tools/geo/build-world.ts',
  dataset: `world-atlas@${WORLD_ATLAS_VERSION} / Natural Earth ${NATURAL_EARTH_VERSION} countries-50m`,
  totals: {
    geometries: world.countries.length,
    coastal: coastal.length,
    coastalWithShores: included.length,
    coastalExcluded: excluded.length,
    landlocked: landlocked.length,
    catalogueShores: GLOBAL_SHORES.length,
    legacyShores: SEED_SHORES.length,
  },
  included,
  notInDataset: extraCountries,
  excluded,
  landlocked: landlockedRows,
  approximateConnectors: [...new Set([...approximate, ...rescued])].sort(),
};
fs.writeFileSync(OUT_COVERAGE, JSON.stringify(coverage, null, 2) + '\n');

const nameOf = (id: string) => GLOBAL_SHORES.find((s) => s.id === id)?.name ?? id;
const md: string[] = [];
md.push('# Shore coverage report');
md.push('');
md.push(
  `Generated by \`apps/api/src/tools/geo/build-world.ts\` from ${coverage.dataset} (public domain data, ISC packaging). Do not edit by hand; edit \`apps/api/src/db/geo/shores.ts\` or \`apps/api/src/tools/geo/channels.ts\` and re-run the generator.`,
);
md.push('');
md.push('## Totals');
md.push('');
md.push(`| Measure | Count |`);
md.push(`| --- | ---: |`);
md.push(`| Admin-0 geometries in the dataset | ${coverage.totals.geometries} |`);
md.push(`| Coastal geometries | ${coverage.totals.coastal} |`);
md.push(`| Coastal geometries with at least one shore | ${coverage.totals.coastalWithShores} |`);
md.push(`| Coastal geometries explicitly excluded | ${coverage.totals.coastalExcluded} |`);
md.push(
  `| Landlocked geometries (served by a neighbouring shore) | ${coverage.totals.landlocked} |`,
);
md.push(`| Catalogue shores (real harbours) | ${coverage.totals.catalogueShores} |`);
md.push(`| Legacy fictional shores kept unchanged | ${coverage.totals.legacyShores} |`);
md.push(
  `| Sea-graph nodes / edges (v${GRAPH_VERSION}) | ${outNodes.length} / ${outEdges.length} |`,
);
md.push('');
md.push('## Coastal countries and territories with shores');
md.push('');
md.push('| Dataset id | Name | Shores | Harbours |');
md.push('| --- | --- | ---: | --- |');
for (const c of included)
  md.push(
    `| ${c.id ?? '—'} | ${c.name} | ${c.shores.length} | ${c.shores.map(nameOf).join(', ')} |`,
  );
for (const c of extraCountries)
  md.push(
    `| — (not in 50m dataset) | ${c.name} | ${c.shores.length} | ${c.shores.map(nameOf).join(', ')} |`,
  );
md.push('');
md.push('## Coastal geometries without a shore (explicit exclusions)');
md.push('');
md.push('| Dataset id | Name | Reason |');
md.push('| --- | --- | --- |');
for (const e of excluded) md.push(`| ${e.id ?? '—'} | ${e.name} | ${e.reason} |`);
md.push('');
md.push('## Landlocked geometries');
md.push('');
md.push(
  'Users anywhere choose any shore by hand; nothing is derived from location. The nearest catalogue harbour to each landlocked geometry is listed as the natural starting suggestion.',
);
md.push('');
md.push('| Dataset id | Name | Nearest harbour |');
md.push('| --- | --- | --- |');
for (const l of landlockedRows) md.push(`| ${l.id ?? '—'} | ${l.name} | ${l.nearestShoreName} |`);
md.push('');
md.push('## Shore connectors that tolerate a short land crossing');
md.push('');
md.push(
  'Harbours deep inside fjords, rias, lagoons or narrow channels are joined to the nearest open-water node even though the 5.5 km land mask reports land between them (the connector runs through the inlet the mask cannot resolve). Routes still only use the water grid beyond the connector.',
);
md.push('');
md.push(
  coverage.approximateConnectors.length
    ? coverage.approximateConnectors.map((id) => `- ${nameOf(id)} (\`${id}\`)`).join('\n')
    : '- none',
);
md.push('');
fs.writeFileSync(OUT_REPORT, md.join('\n'));
log(
  `coverage: ${included.length} covered, ${excluded.length} excluded, ${landlocked.length} landlocked`,
);
