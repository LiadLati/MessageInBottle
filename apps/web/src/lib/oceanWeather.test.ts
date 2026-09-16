import { describe, expect, it } from 'vitest';
import type { GeoPoint, SentBottleSummaryDto } from '@mib/shared';
import { OCEAN_SCHEDULE, SHORE_SCHEDULE, activeStormAt } from '@mib/shared';
import { activeOceanStorms } from './oceanWeather.js';
import { shoreWeatherAt } from './shoreWeather.js';
import { pointAlongRoute, stormGeometry, stormRegionFeature } from './stormGeometry.js';

const ATLANTIC: GeoPoint[] = [
  { lng: -9.1, lat: 38.7 },
  { lng: -25, lat: 40 },
  { lng: -45, lat: 41 },
  { lng: -70, lat: 41 },
  { lng: -74, lat: 40.7 },
];
// Auckland → Papeete: crosses the antimeridian the short way.
const PACIFIC: GeoPoint[] = [
  { lng: 174.8, lat: -36.8 },
  { lng: 179.5, lat: -30.5 },
  { lng: -175.5, lat: -25.5 },
  { lng: -149.6, lat: -17.5 },
];

function bottle(
  id: string,
  state: SentBottleSummaryDto['state'],
  geoPoints: GeoPoint[] | null = ATLANTIC,
): SentBottleSummaryDto {
  return {
    id,
    state,
    version: 1,
    recipient: { id: 'usr_r', displayName: 'R' },
    originShore: { id: 'shore_a', name: 'A' },
    destinationShore: { id: 'shore_b', name: 'B' },
    releasedAt: '2026-09-01T00:00:00.000Z',
    deliveredAt: null,
    openedAt: null,
    completedAt: null,
    plannedArrivalAt: '2026-09-06T00:00:00.000Z',
    elapsedMs: 1000,
    elapsedIsLive: true,
    route: {
      version: 1,
      nodeIds: ['n_a', 'n_b', 'n_c'],
      points: [],
      geoPoints,
      totalLength: 60,
      plannedDurationMs: 432_000_000,
    },
    position: { chart: { x: 0, y: 0 }, geo: geoPoints?.[1] ?? null, progress: 0.5 },
    serverTime: '2026-09-03T00:00:00.000Z',
  } as unknown as SentBottleSummaryDto;
}

// An instant at which a given bottle definitely has a scheduled storm.
function instantWithStorm(id: string): number {
  const base = Date.parse('2026-09-16T00:00:00.000Z');
  for (let i = 0; i < 400; i++) {
    const t = base + i * 10 * 60 * 1000;
    if (activeStormAt(id, t, OCEAN_SCHEDULE)) return t;
  }
  throw new Error('no storm scheduled for this id');
}

describe('ocean storms are night-only, route-anchored and never invented', () => {
  it('shows nothing in daylight, whatever the schedule says', () => {
    const id = 'btl_day';
    const t = instantWithStorm(id);
    expect(activeOceanStorms([bottle(id, 'at_sea')], t, { phase: 'night' })).toHaveLength(1);
    expect(activeOceanStorms([bottle(id, 'at_sea')], t, { phase: 'day' })).toHaveLength(0);
  });

  it('shows nothing when no bottle is at sea', () => {
    const id = 'btl_landed';
    const t = instantWithStorm(id);
    expect(activeOceanStorms([], t, { phase: 'night' })).toEqual([]);
    for (const state of ['delivered', 'opened', 'lost'] as const) {
      expect(activeOceanStorms([bottle(id, state)], t, { phase: 'night' })).toEqual([]);
    }
  });

  it('ignores a bottle with no charted route rather than inventing a region', () => {
    const id = 'btl_noroute';
    const t = instantWithStorm(id);
    expect(activeOceanStorms([bottle(id, 'at_sea', null)], t, { phase: 'night' })).toEqual([]);
    expect(
      activeOceanStorms([bottle(id, 'at_sea', [{ lng: 0, lat: 0 }])], t, { phase: 'night' }),
    ).toEqual([]);
  });

  it('anchors each storm on its own bottle route and supports several routes at once', () => {
    const a = 'btl_multi_a';
    const b = 'btl_multi_b';
    const t = instantWithStorm(a);
    const storms = activeOceanStorms(
      [bottle(a, 'at_sea', ATLANTIC), bottle(b, 'at_sea', PACIFIC)],
      t,
      { phase: 'night', force: 'on' },
    );
    expect(storms).toHaveLength(2);
    for (const storm of storms) {
      const route = storm.bottleId === a ? ATLANTIC : PACIFIC;
      // The centre is a point on that bottle's own polyline, so the region intersects the route.
      const nearest = Math.min(
        ...route.map((p) => Math.hypot(p.lng - storm.centre.lng, p.lat - storm.centre.lat)),
      );
      expect(nearest).toBeLessThan(40);
      expect(storm.radiusLngDeg).toBeGreaterThan(0);
      expect(storm.cells).toHaveLength(11);
    }
    // Two different routes never produce the same storm.
    expect(storms[0]!.id).not.toBe(storms[1]!.id);
  });

  it('does not reroll when the same moment is evaluated again', () => {
    const id = 'btl_stable';
    const t = instantWithStorm(id);
    const first = activeOceanStorms([bottle(id, 'at_sea')], t, { phase: 'night' });
    const again = activeOceanStorms([bottle(id, 'at_sea')], t + 1000, { phase: 'night' });
    expect(again[0]!.id).toBe(first[0]!.id);
    expect(again[0]!.centre).toEqual(first[0]!.centre);
    expect(again[0]!.cells).toEqual(first[0]!.cells);
  });

  it('honours the development force switches without touching any bottle', () => {
    const id = 'btl_forced';
    const t = instantWithStorm(id);
    expect(activeOceanStorms([bottle(id, 'at_sea')], t, { phase: 'night', force: 'off' })).toEqual(
      [],
    );
    const forced = activeOceanStorms([bottle(id, 'at_sea', PACIFIC)], t, {
      phase: 'night',
      force: 'on',
    });
    expect(forced).toHaveLength(1);
    // Forcing is still day-gated: the map is a daylight map, so there is no storm to draw.
    expect(activeOceanStorms([bottle(id, 'at_sea')], t, { phase: 'day', force: 'on' })).toEqual([]);
  });
});

describe('storm geometry', () => {
  it('samples a point along the route, not its endpoints', () => {
    const mid = pointAlongRoute(ATLANTIC, 0.5)!;
    expect(mid.lng).toBeLessThan(ATLANTIC[0]!.lng);
    expect(mid.lng).toBeGreaterThan(ATLANTIC[ATLANTIC.length - 1]!.lng);
    expect(pointAlongRoute([], 0.5)).toBeNull();
    expect(pointAlongRoute([{ lng: 3, lat: 4 }], 0.5)).toEqual({ lng: 3, lat: 4 });
  });

  it('follows a Pacific route across the antimeridian instead of the long way round', () => {
    // Sampled in unwrapped space, so the midpoint sits near the date line, not near 0°.
    const mid = pointAlongRoute(PACIFIC, 0.5)!;
    expect(Math.abs(mid.lng)).toBeGreaterThan(150);
  });

  it('emits in-range coordinates and splits a region that straddles ±180°', () => {
    const geometry = stormGeometry('s1', 'btl_p', PACIFIC, 1234)!;
    expect(geometry.centre.lng).toBeGreaterThanOrEqual(-180);
    expect(geometry.centre.lng).toBeLessThanOrEqual(180);
    for (const cell of geometry.cells) {
      expect(cell.lng).toBeGreaterThanOrEqual(-180);
      expect(cell.lng).toBeLessThanOrEqual(180);
      expect(Math.abs(cell.lat)).toBeLessThan(90);
    }
    // A region centred on the date line is split so it draws in one piece on both sides.
    const straddling = { ...geometry, centre: { lng: 179, lat: -28 }, radiusLngDeg: 8 };
    const feature = stormRegionFeature(straddling);
    expect(feature.geometry.type).toBe('MultiPolygon');
    const coords = (feature.geometry as GeoJSON.MultiPolygon).coordinates;
    expect(coords.length).toBe(2);
    for (const poly of coords) {
      for (const [lng] of poly[0]!) {
        expect(lng).toBeGreaterThanOrEqual(-180.001);
        expect(lng).toBeLessThanOrEqual(180.001);
      }
    }
    // A region well inside the range stays a single polygon.
    expect(stormRegionFeature({ ...geometry, centre: { lng: -40, lat: 40 } }).geometry.type).toBe(
      'Polygon',
    );
  });
});

describe('My Shore weather is independent and cosmetic', () => {
  it('runs on the user, on its own schedule, never on a bottle', () => {
    const base = Date.parse('2026-09-16T00:00:00.000Z');
    const oceanish: boolean[] = [];
    const shoreish: boolean[] = [];
    for (let i = 0; i < 48; i++) {
      const t = base + i * 3600_000;
      oceanish.push(Boolean(activeStormAt('usr_1', t, OCEAN_SCHEDULE)));
      shoreish.push(shoreWeatherAt('usr_1', t) === 'storm');
    }
    // The same subject under the two schedules disagrees: the surfaces are not mirrored.
    expect(oceanish).not.toEqual(shoreish);
    // And it is a real schedule, not a constant.
    expect(new Set(shoreish).size).toBe(2);
  });

  it('is stable for the same instant and honours the development switches', () => {
    const t = Date.parse('2026-09-16T03:00:00.000Z');
    expect(shoreWeatherAt('usr_a', t)).toBe(shoreWeatherAt('usr_a', t));
    expect(shoreWeatherAt('usr_a', t, 'on')).toBe('storm');
    expect(shoreWeatherAt('usr_a', t, 'off')).toBe('calm');
    // Signed out: no user, no shore weather.
    expect(shoreWeatherAt(null, t)).toBe('calm');
  });

  it('only ever returns a scene parameter — it carries no journey effect', () => {
    const t = Date.parse('2026-09-16T03:00:00.000Z');
    const result = shoreWeatherAt('usr_a', t, 'on');
    // The entire contract is one of two scene words. There is nothing here that could delay,
    // reroute or endanger a bottle.
    expect(['calm', 'storm']).toContain(result);
    expect(typeof result).toBe('string');
  });

  it('uses a different schedule shape from the ocean (documented defaults)', () => {
    expect(SHORE_SCHEDULE.windowMs).not.toBe(OCEAN_SCHEDULE.windowMs);
    expect(SHORE_SCHEDULE.chance).toBeGreaterThan(0);
    expect(SHORE_SCHEDULE.chance).toBeLessThan(1);
  });
});
