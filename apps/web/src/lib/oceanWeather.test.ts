import { describe, expect, it } from 'vitest';
import { bottleWeatherAt, oceanWeatherMap } from './oceanWeather.js';
import { shoreWeatherAt } from './shoreWeather.js';

// Risk policy v4: a storm is the account's map weather. One storm, shown once on the map; every
// bottle still at sea is in it; the shore shows the same weather. Whether there is a storm, and
// whether the map is at night, comes from the server (state/weather.tsx), never from here.
const bottle = (id: string, state = 'at_sea') => ({ id, state }) as { id: string; state: 'at_sea' };

describe('bottles share the account storm', () => {
  it('puts every bottle at sea in the storm while it shows, and none when calm', () => {
    const list = [bottle('btl_1'), bottle('btl_2'), bottle('btl_3')];
    expect(oceanWeatherMap(list, 'storm')).toEqual({
      btl_1: 'storm',
      btl_2: 'storm',
      btl_3: 'storm',
    });
    expect(oceanWeatherMap(list, 'calm')).toEqual({ btl_1: 'calm', btl_2: 'calm', btl_3: 'calm' });
    expect(oceanWeatherMap([], 'storm')).toEqual({});
  });

  it('is calm for anything not at sea, so no storm is ever invented for a landed bottle', () => {
    for (const state of ['delivered', 'opened', 'lost', 'cancelled'])
      expect(bottleWeatherAt({ id: 'x', state } as never, 'storm')).toBe('calm');
  });

  it('honours the development force switches without touching any bottle', () => {
    expect(bottleWeatherAt(bottle('btl_f'), 'calm', { force: 'on' })).toBe('storm');
    expect(bottleWeatherAt(bottle('btl_g'), 'storm', { force: 'off' })).toBe('calm');
    expect(bottleWeatherAt(bottle('btl_h', 'delivered'), 'calm', { force: 'on' })).toBe('calm');
  });
});

describe('My Shore shows the same weather as the map', () => {
  it('follows the account storm, with the development override on top', () => {
    expect(shoreWeatherAt('storm')).toBe('storm');
    expect(shoreWeatherAt('calm')).toBe('calm');
    expect(shoreWeatherAt('calm', 'on')).toBe('storm');
    expect(shoreWeatherAt('storm', 'off')).toBe('calm');
  });
});
