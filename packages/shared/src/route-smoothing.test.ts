import { describe, expect, it } from 'vitest';
import { BLIND_CUT_KM, CUT_CANDIDATES_KM, landTestFrom, smoothRoute } from './route-smoothing.js';

const MAX_CUT_KM = CUT_CANDIDATES_KM[0];
const water = () => false;

const KM = 111.32;
const dist = (a: { lng: number; lat: number }, b: { lng: number; lat: number }) =>
  Math.hypot((a.lng - b.lng) * Math.cos((a.lat * Math.PI) / 180), a.lat - b.lat) * KM;

describe('the drawn route is smoothed, never moved', () => {
  const staircase = [
    { lng: 0, lat: 0 },
    { lng: 1, lat: 0 },
    { lng: 1, lat: 1 },
    { lng: 2, lat: 1 },
    { lng: 2, lat: 2 },
  ];

  it('keeps both endpoints exactly', () => {
    const s = smoothRoute(staircase, water);
    expect(s[0]).toEqual(staircase[0]);
    expect(s.at(-1)).toEqual(staircase.at(-1));
  });

  it('rounds every sharp corner, and stays within the cut of the original corner', () => {
    const s = smoothRoute(staircase, water);
    for (const corner of staircase.slice(1, -1)) {
      // The corner itself is no longer drawn...
      expect(s.some((p) => p.lng === corner.lng && p.lat === corner.lat)).toBe(false);
      // ...but every curve point near it is within the capped cut of it.
      const near = s.filter((p) => dist(p, corner) < 50);
      expect(near.length).toBeGreaterThan(3);
      for (const p of near) expect(dist(p, corner)).toBeLessThanOrEqual(MAX_CUT_KM + 0.01);
    }
  });

  it('leaves a nearly straight line and short input as they are', () => {
    const straight = [
      { lng: 0, lat: 0 },
      { lng: 1, lat: 0.01 },
      { lng: 2, lat: 0 },
    ];
    expect(smoothRoute(straight, water)).toEqual(straight);
    expect(smoothRoute(staircase.slice(0, 2))).toEqual(staircase.slice(0, 2));
  });

  it('cuts dense legs (a strait or canal) proportionally, keeping their shape', () => {
    const strait = [
      { lng: 29.0, lat: 41.0 },
      { lng: 29.02, lat: 41.02 },
      { lng: 29.02, lat: 41.06 },
    ];
    const s = smoothRoute(strait, water);
    for (const p of s.slice(1, -1)) expect(dist(p, strait[1]!)).toBeLessThanOrEqual(2.1);
  });

  it('shrinks the cut, or keeps the corner, where a larger curve would touch land', () => {
    // An island just inside the first corner.
    const island = (lng: number, lat: number) => Math.hypot(lng - 0.85, lat - 0.15) < 0.12;
    const s = smoothRoute(staircase, island);
    for (const p of s) expect(island(p.lng, p.lat)).toBe(false);
    // Land all round the middle corner: that corner is drawn exactly as it was.
    const everywhere = (lng: number, lat: number) => Math.hypot(lng - 1, lat - 1) < 0.6;
    const s2 = smoothRoute(staircase, everywhere);
    expect(s2.some((p) => p.lng === 1 && p.lat === 1)).toBe(true);
  });

  it('gives the corners on a harbour approach only the tiny blind cut', () => {
    const s = smoothRoute(staircase, water);
    const first = staircase[1]!;
    for (const p of s)
      if (dist(p, first) < 30) expect(dist(p, first)).toBeLessThanOrEqual(BLIND_CUT_KM + 0.01);
  });

  it('without a land test, rounds corners only by a tiny, blind-safe amount', () => {
    for (const p of smoothRoute(staircase))
      for (const c of staircase.slice(1, -1))
        if (dist(p, c) < 20) expect(dist(p, c)).toBeLessThanOrEqual(BLIND_CUT_KM + 0.01);
  });

  it('tests land with the map polygons, holes included', () => {
    const square = (x: number, y: number, r: number) => [
      [x - r, y - r],
      [x + r, y - r],
      [x + r, y + r],
      [x - r, y + r],
      [x - r, y - r],
    ];
    const isLand = landTestFrom({
      features: [
        { geometry: { type: 'Polygon', coordinates: [square(10, 10, 2), square(10, 10, 1)] } },
      ],
    });
    expect(isLand(11.5, 10)).toBe(true);
    expect(isLand(10, 10)).toBe(false); // a lake
    expect(isLand(13, 10)).toBe(false);
    expect(isLand(371.5, 10)).toBe(true); // unwrapped longitudes
  });

  it('does not mutate its input', () => {
    const copy = structuredClone(staircase);
    smoothRoute(staircase);
    expect(staircase).toEqual(copy);
  });
});
