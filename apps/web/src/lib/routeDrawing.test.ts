import { describe, expect, it } from 'vitest';
import { drawnRoute } from './routeDrawing.js';

// Manual review round 1, item 8: the drawn private route is the server's waypoints with rounded
// corners. Rendering only; the endpoints never move.

const route = [
  { lng: 170, lat: 0 },
  { lng: 175, lat: 0 },
  { lng: 179, lat: 3 },
  { lng: -178, lat: 3 },
  { lng: -174, lat: 6 },
];

describe('the drawn route', () => {
  it('keeps both endpoints and crosses the antimeridian as one line', () => {
    const d = drawnRoute(route, () => false);
    expect(d[0]).toEqual(route[0]);
    expect(d.at(-1)).toEqual({ lng: 186, lat: 6 });
    for (let i = 1; i < d.length; i++) expect(Math.abs(d[i]!.lng - d[i - 1]!.lng)).toBeLessThan(10);
  });

  it('rounds the open-water corners', () => {
    const d = drawnRoute(route, () => false);
    expect(d.length).toBeGreaterThan(route.length);
    expect(d.some((p) => p.lng === 179 && p.lat === 3)).toBe(false);
  });

  it('is computed once per route and land test', () => {
    const water = () => false;
    expect(drawnRoute(route, water)).toBe(drawnRoute(route, water));
    expect(drawnRoute(route, null)).not.toBe(drawnRoute(route, water));
  });
});
