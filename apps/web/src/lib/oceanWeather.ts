import type { SentBottleSummaryDto } from '@mib/shared';
import { OCEAN_SCHEDULE, activeStormAt, type DayPhase } from '@mib/shared';

// Which of the signed-in sender's bottles are in a storm right now (handoff v2.0).
//
// A storm belongs to a bottle, not to the map: two bottles on the same route may differ. Three
// rules, all enforced here rather than in the view:
//   1. Storms exist only at night — the map's storm styling is night-only by policy.
//   2. Storms exist only for bottles that are still at sea. The list this function receives is
//      already only the caller's own sent bottles, so no other person's weather can appear.
//   3. The answer is a deterministic, versioned schedule keyed on the bottle id, so a refresh,
//      a selection change, opening the sea viewer or a server restart never rerolls it.
//
// Weather is cosmetic: nothing here reads or writes progress, arrival, route or state.

export type BottleWeather = 'calm' | 'storm';

export interface OceanWeatherOptions {
  phase: DayPhase;
  /** Development preview only: force every at-sea bottle stormy or calm. Touches no bottle. */
  force?: 'on' | 'off' | null;
}

export function bottleWeatherAt(
  bottle: Pick<SentBottleSummaryDto, 'id' | 'state'>,
  atMs: number,
  { phase, force = null }: OceanWeatherOptions,
): BottleWeather {
  if (bottle.state !== 'at_sea' || phase !== 'night' || force === 'off') return 'calm';
  if (force === 'on') return 'storm';
  return activeStormAt(bottle.id, atMs, OCEAN_SCHEDULE) ? 'storm' : 'calm';
}

export function oceanWeatherMap(
  bottles: Array<Pick<SentBottleSummaryDto, 'id' | 'state'>>,
  atMs: number,
  options: OceanWeatherOptions,
): Record<string, BottleWeather> {
  const out: Record<string, BottleWeather> = {};
  for (const b of bottles) out[b.id] = bottleWeatherAt(b, atMs, options);
  return out;
}
