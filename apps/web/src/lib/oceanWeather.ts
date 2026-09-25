import type { SentBottleSummaryDto } from '@mib/shared';

// Which of the signed-in sender's bottles are in the storm right now.
//
// A storm belongs to the account's map, not to a bottle (risk policy v4): the server rolls it
// for the account's night, and the map shows exactly one storm. While it is showing, every one
// of the account's bottles still at sea is "in the storm" — that is the weather each of them
// sails through, and each gets its own independent decision at the storm's midpoint. Nothing is
// computed here that could differ from the server: the storm and whether the map is in night
// both come from the account's weather (state/weather.tsx).
//
// Drawing weather is cosmetic: nothing here reads or writes progress, arrival, route or state.

export type BottleWeather = 'calm' | 'storm';

export interface OceanWeatherOptions {
  /** Development preview only: force every at-sea bottle stormy or calm. Touches no bottle. */
  force?: 'on' | 'off' | null;
}

type WeatherInput = Pick<SentBottleSummaryDto, 'id' | 'state'>;

export function bottleWeatherAt(
  bottle: WeatherInput,
  accountStorm: BottleWeather,
  { force = null }: OceanWeatherOptions = {},
): BottleWeather {
  if (bottle.state !== 'at_sea' || force === 'off') return 'calm';
  if (force === 'on') return 'storm';
  return accountStorm;
}

export function oceanWeatherMap(
  bottles: WeatherInput[],
  accountStorm: BottleWeather,
  options: OceanWeatherOptions = {},
): Record<string, BottleWeather> {
  const out: Record<string, BottleWeather> = {};
  for (const b of bottles) out[b.id] = bottleWeatherAt(b, accountStorm, options);
  return out;
}
