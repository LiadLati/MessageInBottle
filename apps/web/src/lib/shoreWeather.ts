import { SHORE_SCHEDULE, activeStormAt } from '@mib/shared';
import type { SceneWeather } from '../components/ShoreScene.js';
import type { WeatherOverride } from '../state/weather.js';

// My Shore's weather runs on its own schedule, keyed on the *user* rather than on any bottle,
// so it is independent of the ocean by construction: the two never share a seed, a window or a
// subject. It is cosmetic — the result only ever reaches the scene's materials and the
// advisory copy, never a route, a duration or an arrival.
export function shoreWeatherAt(
  userId: string | null,
  atMs: number,
  override: WeatherOverride = 'auto',
): SceneWeather {
  if (override === 'on') return 'storm';
  if (override === 'off' || !userId) return 'calm';
  return activeStormAt(userId, atMs, SHORE_SCHEDULE) ? 'storm' : 'calm';
}
