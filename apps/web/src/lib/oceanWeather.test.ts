import { describe, expect, it } from 'vitest';
import { OCEAN_SCHEDULE, SHORE_SCHEDULE, activeStormAt } from '@mib/shared';
import { bottleWeatherAt, oceanWeatherMap } from './oceanWeather.js';
import { shoreWeatherAt } from './shoreWeather.js';

const bottle = (id: string, state = 'at_sea') => ({ id, state }) as { id: string; state: 'at_sea' };

// An instant at which a given bottle definitely has a scheduled storm / definitely has none.
function instantWhere(id: string, stormy: boolean): number {
  const base = Date.parse('2026-09-16T00:00:00.000Z');
  for (let i = 0; i < 600; i++) {
    const t = base + i * 10 * 60 * 1000;
    if (Boolean(activeStormAt(id, t, OCEAN_SCHEDULE)) === stormy) return t;
  }
  throw new Error('no such instant');
}

describe('per-bottle weather (handoff v2.0)', () => {
  it('is calm in daylight, whatever the schedule says', () => {
    const t = instantWhere('btl_day', true);
    expect(bottleWeatherAt(bottle('btl_day'), t, { phase: 'night' })).toBe('storm');
    expect(bottleWeatherAt(bottle('btl_day'), t, { phase: 'day' })).toBe('calm');
  });

  it('is calm for anything not at sea, so no storm is ever invented for a landed bottle', () => {
    const t = instantWhere('btl_landed', true);
    for (const state of ['delivered', 'opened', 'lost', 'cancelled']) {
      expect(bottleWeatherAt({ id: 'btl_landed', state } as never, t, { phase: 'night' })).toBe(
        'calm',
      );
    }
    expect(oceanWeatherMap([], t, { phase: 'night' })).toEqual({});
  });

  it('lets two bottles on the same route hold different weather', () => {
    // The schedule is keyed on the bottle id, so a route shared by two bottles never forces them
    // to agree. Find a moment where one is stormy and the other is calm.
    const base = Date.parse('2026-09-16T00:00:00.000Z');
    let found: number | null = null;
    for (let i = 0; i < 600 && found === null; i++) {
      const t = base + i * 10 * 60 * 1000;
      const a = bottleWeatherAt(bottle('btl_route_a'), t, { phase: 'night' });
      const b = bottleWeatherAt(bottle('btl_route_b'), t, { phase: 'night' });
      if (a !== b) found = t;
    }
    expect(found).not.toBeNull();
    const map = oceanWeatherMap([bottle('btl_route_a'), bottle('btl_route_b')], found!, {
      phase: 'night',
    });
    expect(new Set(Object.values(map)).size).toBe(2);
  });

  it('does not reroll when the same moment is evaluated again (refresh, selection, viewer)', () => {
    const t = instantWhere('btl_stable', true);
    const first = oceanWeatherMap([bottle('btl_stable')], t, { phase: 'night' });
    for (let i = 0; i < 5; i++) {
      expect(oceanWeatherMap([bottle('btl_stable')], t + i * 1000, { phase: 'night' })).toEqual(
        first,
      );
    }
    expect(first.btl_stable).toBe('storm');
  });

  it('honours the development force switches without touching any bottle', () => {
    const t = instantWhere('btl_forced', false);
    expect(bottleWeatherAt(bottle('btl_forced'), t, { phase: 'night' })).toBe('calm');
    expect(bottleWeatherAt(bottle('btl_forced'), t, { phase: 'night', force: 'on' })).toBe('storm');
    expect(bottleWeatherAt(bottle('btl_forced'), t, { phase: 'night', force: 'off' })).toBe('calm');
    // Forcing is still day-gated and still needs a bottle at sea.
    expect(bottleWeatherAt(bottle('btl_forced'), t, { phase: 'day', force: 'on' })).toBe('calm');
    expect(
      bottleWeatherAt({ id: 'btl_forced', state: 'opened' } as never, t, {
        phase: 'night',
        force: 'on',
      }),
    ).toBe('calm');
  });

  it('only ever yields a scene word — nothing here can move, delay or endanger a bottle', () => {
    const t = instantWhere('btl_word', true);
    const v = bottleWeatherAt(bottle('btl_word'), t, { phase: 'night' });
    expect(['calm', 'storm']).toContain(v);
  });
});

describe('My Shore weather is independent and cosmetic', () => {
  it('runs on the user, on its own schedule, never on a bottle', () => {
    const base = Date.parse('2026-09-16T00:00:00.000Z');
    const oceanish: boolean[] = [];
    const shoreish: boolean[] = [];
    for (let i = 0; i < 48; i++) {
      const t = base + i * 3600_000;
      oceanish.push(Boolean(activeStormAt('usr_1', t, OCEAN_SCHEDULE)));
      shoreish.push(shoreWeatherAt('usr_1', t) === 'storm');
    }
    expect(oceanish).not.toEqual(shoreish);
    expect(new Set(shoreish).size).toBe(2);
  });

  it('is stable for the same instant and honours the development switches', () => {
    const t = Date.parse('2026-09-16T03:00:00.000Z');
    expect(shoreWeatherAt('usr_a', t)).toBe(shoreWeatherAt('usr_a', t));
    expect(shoreWeatherAt('usr_a', t, 'on')).toBe('storm');
    expect(shoreWeatherAt('usr_a', t, 'off')).toBe('calm');
    expect(shoreWeatherAt(null, t)).toBe('calm');
  });

  it('uses a different schedule shape from the ocean (documented defaults)', () => {
    expect(SHORE_SCHEDULE.windowMs).not.toBe(OCEAN_SCHEDULE.windowMs);
    expect(SHORE_SCHEDULE.chance).toBeGreaterThan(0);
    expect(SHORE_SCHEDULE.chance).toBeLessThan(1);
  });
});
