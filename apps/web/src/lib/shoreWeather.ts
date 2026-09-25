import type { SceneWeather } from '../components/ShoreScene.js';
import type { WeatherOverride } from '../state/weather.js';

// My Shore shows the account's weather: the same one storm as the Ocean map, on the same map
// clock (risk policy v4), so the shore never storms under a daytime sky or while the map is
// calm. It is presentation only — sky, light, rain, waves, foam and wetness.
export function shoreWeatherAt(
  accountStorm: 'calm' | 'storm',
  override: WeatherOverride = 'auto',
): SceneWeather {
  if (override === 'on') return 'storm';
  if (override === 'off') return 'calm';
  return accountStorm;
}
