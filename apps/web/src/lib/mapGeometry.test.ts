import { describe, expect, it } from 'vitest';
import {
  assertMapStylePolicy,
  boundsOf,
  clusterPins,
  geoAlong,
  interpolatedProgress,
  spreadOffsets,
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

describe('shore pin clustering', () => {
  const pt = (id: string, x: number, y: number) => ({ item: id, x, y });

  it('keeps far-apart pins single and groups crowded ones while zooming can still split them', () => {
    const out = clusterPins([pt('a', 0, 0), pt('b', 200, 0), pt('c', 30, 0)], 3, 7, 44);
    expect(out.map((c) => c.members.sort())).toEqual([['a', 'c'], ['b']]);
    // 30 px apart at zoom 3 is 480 px apart at zoom 7: a real cluster, no spread offsets.
    expect(out[0]!.offsets).toEqual([]);
  });

  it('spreads harbours that no zoom level could separate, without moving their position', () => {
    // Two harbours ~9 px apart at max zoom (Eilat and Aqaba are ~5 km apart).
    const out = clusterPins([pt('eilat', 100, 100), pt('aqaba', 109, 102)], 7, 7, 44);
    expect(out).toHaveLength(1);
    expect(out[0]!.members).toEqual(['eilat', 'aqaba']);
    expect(out[0]!.offsets).toHaveLength(2);
    const [a, b] = out[0]!.offsets;
    expect(Math.hypot(a![0] - b![0], a![1] - b![1])).toBeGreaterThanOrEqual(44);
    // The cluster centre still sits on the real positions; only offsets are visual.
    expect(out[0]!.x).toBeCloseTo(104.5);
  });

  it('spreads early when even the max zoom would leave the pins overlapping', () => {
    // 1 px apart at zoom 4: 8 px at zoom 7, still under the cluster radius -> spread now.
    const out = clusterPins([pt('a', 0, 0), pt('b', 1, 0)], 4, 7, 44);
    expect(out[0]!.offsets).toHaveLength(2);
    // 3 px apart at zoom 4 becomes 24 px at 7 (still overlapping) -> spread; 6 px -> 48 px -> cluster.
    expect(clusterPins([pt('a', 0, 0), pt('b', 6, 0)], 4, 7, 44)[0]!.offsets).toEqual([]);
  });

  it('places spread pins on a ring with distinct offsets', () => {
    const ring = spreadOffsets(5);
    expect(new Set(ring.map((o) => o.join(','))).size).toBe(5);
    for (const [x, y] of ring) expect(Math.hypot(x, y)).toBeGreaterThan(30);
  });
});
