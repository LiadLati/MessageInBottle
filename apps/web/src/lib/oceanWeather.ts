import type { SentBottleSummaryDto } from '@mib/shared';
import { OCEAN_SCHEDULE, activeStormAt, type DayPhase } from '@mib/shared';
import { stormGeometry, type StormGeometry } from './stormGeometry.js';

// Which simulated storms the Ocean map should be showing right now.
//
// Three rules, all enforced here rather than in the view:
//   1. Storms exist only at night.
//   2. Storms exist only along the signed-in sender's own bottles that are still at sea — the
//      list this function receives is already only the caller's own sent bottles, so no other
//      user's journey or weather can ever appear.
//   3. A storm is anchored to the route of the bottle it belongs to, so the region always
//      intersects that maritime path and never covers an unrelated region.
//
// Weather is cosmetic: nothing here reads or writes progress, arrival or state.

export interface OceanWeatherOptions {
  phase: DayPhase;
  /** Development preview only: force storms on or off without touching any bottle. */
  force?: 'on' | 'off' | null;
}

export function activeOceanStorms(
  bottles: SentBottleSummaryDto[],
  atMs: number,
  { phase, force = null }: OceanWeatherOptions,
): StormGeometry[] {
  if (phase !== 'night' || force === 'off') return [];
  const out: StormGeometry[] = [];
  for (const bottle of bottles) {
    if (bottle.state !== 'at_sea') continue;
    const points = bottle.route.geoPoints;
    if (!points || points.length < 2) continue;
    const scheduled = activeStormAt(bottle.id, atMs, OCEAN_SCHEDULE);
    if (!scheduled && force !== 'on') continue;
    // The forced preview borrows the bottle's next scheduled seed so the shape is still stable.
    const seed = scheduled?.seed ?? hashFallback(bottle.id);
    const id = scheduled?.id ?? `storm_preview_${bottle.id}`;
    const geometry = stormGeometry(id, bottle.id, points, seed);
    if (geometry) out.push(geometry);
  }
  return out;
}

function hashFallback(bottleId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bottleId.length; i++) {
    h ^= bottleId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
