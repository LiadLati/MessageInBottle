import { describe, expect, it } from 'vitest';
import { assertNeutralStyle, boundsOf, geoAlong, interpolatedProgress } from './mapGeometry.js';

describe('map style policy (MAP_DESIGN.md)', () => {
  it('accepts a land-only style', () => {
    expect(() =>
      assertNeutralStyle({
        layers: [
          { id: 'sea', type: 'background' },
          { id: 'land', type: 'fill' },
          { id: 'coast', type: 'line', 'source-layer': 'land' },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects labels and political layers', () => {
    expect(() => assertNeutralStyle({ layers: [{ id: 'names', type: 'symbol' }] })).toThrow(
      /symbol/,
    );
    for (const sl of ['admin', 'boundary', 'place', 'countries_label', 'poi', 'road', 'border']) {
      expect(() =>
        assertNeutralStyle({ layers: [{ id: 'x', type: 'line', 'source-layer': sl }] }),
      ).toThrow(/political/);
    }
  });
});

describe('route interpolation (client-side, never authoritative)', () => {
  const route = {
    id: 'r',
    points: [
      { lng: 0, lat: 0 },
      { lng: 10, lat: 0 },
      { lng: 10, lat: 10 },
    ],
    progress: 0.25,
    progressAsOf: 1_000,
    plannedDurationMs: 4_000,
    live: true,
    state: 'at_sea',
  };

  it('advances from the last synced progress at the server rate and clamps at 1', () => {
    expect(interpolatedProgress(route, 1_000)).toBe(0.25);
    expect(interpolatedProgress(route, 2_000)).toBe(0.5);
    expect(interpolatedProgress(route, 9_000)).toBe(1);
    expect(interpolatedProgress({ ...route, live: false }, 9_000)).toBe(0.25);
  });

  it('walks the polyline by geometric length', () => {
    expect(geoAlong(route.points, 0).point).toEqual({ lng: 0, lat: 0 });
    expect(geoAlong(route.points, 0.5)).toEqual({ point: { lng: 10, lat: 0 }, index: 0 });
    expect(geoAlong(route.points, 0.75).point).toEqual({ lng: 10, lat: 5 });
    expect(geoAlong(route.points, 1).point).toEqual({ lng: 10, lat: 10 });
  });

  it('pads a single point into a viewable box', () => {
    expect(boundsOf([{ lng: -20, lat: 40 }])).toEqual([
      [-26, 36],
      [-14, 44],
    ]);
    expect(boundsOf([])).toBeNull();
  });
});
