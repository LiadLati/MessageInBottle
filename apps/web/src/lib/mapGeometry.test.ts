import { describe, expect, it } from 'vitest';
import {
  assertMapStylePolicy,
  boundsOf,
  geoAlong,
  interpolatedProgress,
  unwrapAntimeridian,
} from './mapGeometry.js';

describe('map style policy (MAP_DESIGN.md)', () => {
  it('accepts land plus thin border lines', () => {
    expect(() =>
      assertMapStylePolicy({
        layers: [
          { id: 'sea', type: 'background' },
          { id: 'land', type: 'fill' },
          { id: 'coast', type: 'line', 'source-layer': 'land' },
          { id: 'borders', type: 'line' },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects labels, named places and borders drawn as anything but lines', () => {
    expect(() => assertMapStylePolicy({ layers: [{ id: 'names', type: 'symbol' }] })).toThrow(
      /symbol/,
    );
    for (const sl of ['place', 'countries_label', 'poi', 'road', 'transportation']) {
      expect(() =>
        assertMapStylePolicy({ layers: [{ id: 'x', type: 'line', 'source-layer': sl }] }),
      ).toThrow(/labelled/);
    }
    expect(() =>
      assertMapStylePolicy({ layers: [{ id: 'x', type: 'fill', 'source-layer': 'boundary' }] }),
    ).toThrow(/lines/);
    expect(() => assertMapStylePolicy({ layers: [{ id: 'borders', type: 'fill' }] })).toThrow(
      /lines/,
    );
  });
});

describe('antimeridian unwrapping', () => {
  it('keeps a Pacific crossing short instead of wrapping around the globe', () => {
    const pts = unwrapAntimeridian([
      { lng: 174.8, lat: -36.8 },
      { lng: 179.5, lat: -30.5 },
      { lng: -175.5, lat: -25.5 },
      { lng: -149.6, lat: -17.5 },
    ]);
    expect(pts.map((p) => p.lng)).toEqual([174.8, 179.5, 184.5, 210.4]);
    expect(pts.map((p) => p.lat)).toEqual([-36.8, -30.5, -25.5, -17.5]);
  });

  it('leaves ordinary routes alone and handles the westward direction', () => {
    const atlantic = [
      { lng: -9.1, lat: 38.7 },
      { lng: -40, lat: 40 },
    ];
    expect(unwrapAntimeridian(atlantic)).toEqual(atlantic);
    const west = unwrapAntimeridian([
      { lng: -170, lat: 0 },
      { lng: 175, lat: 0 },
    ]);
    expect(west.map((p) => p.lng)).toEqual([-170, -185]);
    expect(unwrapAntimeridian([])).toEqual([]);
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
