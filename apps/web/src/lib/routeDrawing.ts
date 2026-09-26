import { landTestFrom, smoothRoute, type GeoPoint, type LandTest } from '@mib/shared';
import { unwrapAntimeridian } from './mapGeometry.js';

// How a private route is drawn (manual review round 1, item 8): the server's waypoints,
// unwrapped across the antimeridian and with their corners rounded where the curve stays on the
// water. Rendering only — the marker is placed along this same drawn line so the bottle stays
// on it, but its progress, the route, its duration, storms and risk all remain the server's.

let land: Promise<LandTest | null> | null = null;

// The land test comes from the very file the map draws its land from (already in the HTTP
// cache once the map has loaded). Until it arrives, or if it cannot be had, corners are rounded
// only by the tiny blind-safe amount.
export function loadMapLand(url: string): Promise<LandTest | null> {
  land ??= fetch(url)
    .then((res) => (res.ok ? res.json() : null))
    .then((json: Parameters<typeof landTestFrom>[0] | null) => (json ? landTestFrom(json) : null))
    .catch(() => null);
  return land;
}

const drawn = new WeakMap<GeoPoint[], { land: LandTest | null; points: GeoPoint[] }>();

export function drawnRoute(points: GeoPoint[], landTest: LandTest | null): GeoPoint[] {
  const hit = drawn.get(points);
  if (hit && hit.land === landTest) return hit.points;
  const out = smoothRoute(unwrapAntimeridian(points), landTest ?? undefined);
  drawn.set(points, { land: landTest, points: out });
  return out;
}
