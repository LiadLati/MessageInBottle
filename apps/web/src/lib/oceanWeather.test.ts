import { describe, expect, it } from 'vitest';
import { OCEAN_SCHEDULE, SHORE_SCHEDULE, activeStormAt } from '@mib/shared';
import { bottleWeatherAt, oceanWeatherMap } from './oceanWeather.js';
import { shoreWeatherAt } from './shoreWeather.js';

const T = Date.parse('2026-09-16T22:00:00.000Z');
const win = (from: number, to: number) => ({
  startsAt: new Date(from).toISOString(),
  endsAt: new Date(to).toISOString(),
});
const bottle = (
  id: string,
  storms: Array<{ startsAt: string; endsAt: string }>,
  state = 'at_sea',
) => ({ id, state, storms }) as { id: string; state: 'at_sea'; storms: typeof storms };

describe("per-bottle weather from the server's storm windows", () => {
  it('is a storm exactly inside a window, calm outside it', () => {
    const b = bottle('btl_a', [win(T - 60_000, T + 60_000)]);
    expect(bottleWeatherAt(b, T, { phase: 'night' })).toBe('storm');
    expect(bottleWeatherAt(b, T + 60_000, { phase: 'night' })).toBe('calm'); // end is exclusive
    expect(bottleWeatherAt(b, T - 60_001, { phase: 'night' })).toBe('calm');
    expect(bottleWeatherAt(bottle('btl_b', []), T, { phase: 'night' })).toBe('calm');
  });

  it('is calm in daylight, whatever the windows say', () => {
    const b = bottle('btl_day', [win(T - 60_000, T + 60_000)]);
    expect(bottleWeatherAt(b, T, { phase: 'day' })).toBe('calm');
  });

  it('is calm for anything not at sea, so no storm is ever invented for a landed bottle', () => {
    for (const state of ['delivered', 'opened', 'lost', 'cancelled']) {
      expect(
        bottleWeatherAt({ id: 'x', state, storms: [win(T - 1, T + 1)] } as never, T, {
          phase: 'night',
        }),
      ).toBe('calm');
    }
    expect(oceanWeatherMap([], T, { phase: 'night' })).toEqual({});
  });

  it('lets two bottles on the same route hold different weather', () => {
    const map = oceanWeatherMap(
      [bottle('btl_1', [win(T - 1, T + 1)]), bottle('btl_2', [win(T + 3600_000, T + 7200_000)])],
      T,
      { phase: 'night' },
    );
    expect(map).toEqual({ btl_1: 'storm', btl_2: 'calm' });
  });

  it('honours the development force switches without touching any bottle', () => {
    const b = bottle('btl_f', []);
    expect(bottleWeatherAt(b, T, { phase: 'night', force: 'on' })).toBe('storm');
    expect(
      bottleWeatherAt(bottle('btl_g', [win(T - 1, T + 1)]), T, { phase: 'night', force: 'off' }),
    ).toBe('calm');
    expect(bottleWeatherAt(b, T, { phase: 'day', force: 'on' })).toBe('calm');
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
  });
});
