// Fictional, politically neutral sea chart (spec §6.2). Chart coordinates are abstract units on a
// 1000 x 600 canvas and drive routing lengths. Each node also carries a geographic anchor
// (lng/lat) placed in open water off real coastlines so the world map can draw water-only
// passages; the anchors are app anchors with invented names, never user locations.
export const CHART_BOUNDS = { width: 1000, height: 600 } as const;

export interface SeedShore {
  id: string;
  name: string;
  x: number;
  y: number;
  lng: number;
  lat: number;
}
export interface SeedNode {
  id: string;
  kind: 'shore' | 'waypoint' | 'island';
  shoreId?: string;
  x: number;
  y: number;
  lng: number;
  lat: number;
}

export const SEED_SHORES: SeedShore[] = [
  { id: 'shore_lantern_cove', name: 'Lantern Cove', x: 120, y: 140, lng: -52.3, lat: 47.4 },
  { id: 'shore_saltwind_point', name: 'Saltwind Point', x: 880, y: 120, lng: -5.6, lat: 49.8 },
  { id: 'shore_heron_reach', name: 'Heron Reach', x: 150, y: 480, lng: -69.9, lat: 41.9 },
  { id: 'shore_driftmoor_strand', name: 'Driftmoor Strand', x: 860, y: 500, lng: -9.7, lat: 38.55 },
  { id: 'shore_gull_hollow', name: 'Gull Hollow', x: 500, y: 560, lng: -25.4, lat: 37.5 },
  { id: 'shore_cinder_quay', name: 'Cinder Quay', x: 520, y: 60, lng: -21.0, lat: 63.3 },
];

export const SEED_NODES: SeedNode[] = [
  ...SEED_SHORES.map((s) => ({
    id: `n_${s.id}`,
    kind: 'shore' as const,
    shoreId: s.id,
    x: s.x,
    y: s.y,
    lng: s.lng,
    lat: s.lat,
  })),
  { id: 'n_wp_west', kind: 'waypoint', x: 300, y: 250, lng: -45, lat: 46 },
  { id: 'n_wp_centre', kind: 'waypoint', x: 500, y: 300, lng: -35, lat: 45 },
  { id: 'n_wp_east', kind: 'waypoint', x: 700, y: 280, lng: -15, lat: 47 },
  { id: 'n_wp_southwest', kind: 'waypoint', x: 350, y: 430, lng: -50, lat: 39 },
  { id: 'n_wp_southeast', kind: 'waypoint', x: 660, y: 440, lng: -18, lat: 40 },
  { id: 'n_wp_north', kind: 'waypoint', x: 500, y: 170, lng: -30, lat: 55 },
  // Island reachable from the central passage: stage 4 stranding target, never a through-route.
  { id: 'n_island_kelp', kind: 'island', x: 430, y: 380, lng: -40, lat: 41 },
];

export const SEED_EDGES: Array<[string, string]> = [
  ['n_shore_lantern_cove', 'n_wp_west'],
  ['n_shore_heron_reach', 'n_wp_west'],
  ['n_shore_heron_reach', 'n_wp_southwest'],
  ['n_wp_west', 'n_wp_centre'],
  ['n_wp_west', 'n_wp_north'],
  ['n_wp_southwest', 'n_wp_centre'],
  ['n_wp_southwest', 'n_shore_gull_hollow'],
  ['n_wp_centre', 'n_wp_north'],
  ['n_wp_centre', 'n_wp_east'],
  ['n_wp_centre', 'n_wp_southeast'],
  ['n_wp_centre', 'n_island_kelp'],
  ['n_wp_southwest', 'n_island_kelp'],
  ['n_wp_north', 'n_shore_cinder_quay'],
  ['n_wp_north', 'n_wp_east'],
  ['n_wp_east', 'n_shore_saltwind_point'],
  ['n_wp_east', 'n_wp_southeast'],
  ['n_wp_southeast', 'n_shore_driftmoor_strand'],
  ['n_wp_southeast', 'n_shore_gull_hollow'],
];

// Chart units: one unit is ten canvas pixels, so a typical crossing is 40–90 units.
export function edgeLength(a: SeedNode, b: SeedNode): number {
  return Math.max(1, Math.round(Math.hypot(a.x - b.x, a.y - b.y) / 10));
}

export const SEED_USERS = [
  { username: 'ada', displayName: 'Ada', shoreId: 'shore_lantern_cove' },
  { username: 'bo', displayName: 'Bo', shoreId: 'shore_driftmoor_strand' },
  { username: 'cy', displayName: 'Cy', shoreId: 'shore_gull_hollow' },
  { username: 'dee', displayName: 'Dee', shoreId: null },
];

export const SEED_FRIENDSHIPS: Array<{ a: string; b: string; status: 'accepted' | 'pending' }> = [
  { a: 'ada', b: 'bo', status: 'accepted' },
  { a: 'ada', b: 'cy', status: 'accepted' },
  { a: 'bo', b: 'cy', status: 'accepted' },
  { a: 'dee', b: 'ada', status: 'pending' },
];
