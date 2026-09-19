import type { DayPhase, SentBottleSummaryDto } from '@mib/shared';

// Which of the signed-in sender's bottles are in a storm right now.
//
// A storm belongs to a bottle, not to the map, and since the journey risk policy it belongs to
// the *server*: the storm windows arrive with each bottle (`storms`, from the server's versioned
// night schedule), so what the map draws is exactly what the worker can act on — and, after the
// risk cap or the progress cutoff, what it cannot. Three rules, all enforced here:
//   1. Storms are drawn only at night — the map's storm styling is night-only by policy.
//   2. Storms exist only for bottles that are still at sea.
//   3. Nothing is computed client-side that could differ from the server: a refresh, a
//      selection change, the sea viewer or a restart draws the same windows.
//
// Drawing weather is cosmetic: nothing here reads or writes progress, arrival, route or state.

export type BottleWeather = 'calm' | 'storm';

export interface OceanWeatherOptions {
  phase: DayPhase;
  /** Development preview only: force every at-sea bottle stormy or calm. Touches no bottle. */
  force?: 'on' | 'off' | null;
}

type WeatherInput = Pick<SentBottleSummaryDto, 'id' | 'state' | 'storms'>;

export function bottleWeatherAt(
  bottle: WeatherInput,
  atMs: number,
  { phase, force = null }: OceanWeatherOptions,
): BottleWeather {
  if (bottle.state !== 'at_sea' || phase !== 'night' || force === 'off') return 'calm';
  if (force === 'on') return 'storm';
  return bottle.storms.some((w) => Date.parse(w.startsAt) <= atMs && atMs < Date.parse(w.endsAt))
    ? 'storm'
    : 'calm';
}

export function oceanWeatherMap(
  bottles: WeatherInput[],
  atMs: number,
  options: OceanWeatherOptions,
): Record<string, BottleWeather> {
  const out: Record<string, BottleWeather> = {};
  for (const b of bottles) out[b.id] = bottleWeatherAt(b, atMs, options);
  return out;
}
