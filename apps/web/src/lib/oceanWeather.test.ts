import { describe, expect, it } from 'vitest';
import { OCEAN_SCHEDULE, SHORE_SCHEDULE, activeStormAt, phaseAt } from '@mib/shared';
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
    expect(bottleWeatherAt(b, T)).toBe('storm');
    expect(bottleWeatherAt(b, T + 60_000)).toBe('calm'); // end is exclusive
    expect(bottleWeatherAt(b, T - 60_001)).toBe('calm');
    expect(bottleWeatherAt(bottle('btl_b', []), T)).toBe('calm');
  });

  it('draws exactly the server window, with no second clock gating it here', () => {
    // The server schedules every window inside one of the account's own nights — the nights
    // this map is drawn in — so nothing here needs to (or may) hide a storm by the hour.
    const b = bottle('btl_zones', [win(T - 60_000, T + 60_000)]);
    for (const zone of ['Asia/Tokyo', 'America/Los_Angeles', 'Europe/Berlin', 'UTC']) {
      expect(bottleWeatherAt(b, T)).toBe('storm');
      // …and at least one of those zones really is in daylight at that instant.
      void phaseAt(T, zone);
    }
    expect(
      ['Asia/Tokyo', 'America/Los_Angeles', 'Europe/Berlin', 'UTC'].some(
        (z) => phaseAt(T, z) === 'day',
      ),
    ).toBe(true);
  });

  it('is calm for anything not at sea, so no storm is ever invented for a landed bottle', () => {
    for (const state of ['delivered', 'opened', 'lost', 'cancelled']) {
      expect(bottleWeatherAt({ id: 'x', state, storms: [win(T - 1, T + 1)] } as never, T)).toBe(
        'calm',
      );
    }
    expect(oceanWeatherMap([], T)).toEqual({});
  });

  it('lets two bottles on the same route hold different weather', () => {
    const map = oceanWeatherMap(
      [bottle('btl_1', [win(T - 1, T + 1)]), bottle('btl_2', [win(T + 3600_000, T + 7200_000)])],
      T,
    );
    expect(map).toEqual({ btl_1: 'storm', btl_2: 'calm' });
  });

  it('honours the development force switches without touching any bottle', () => {
    const b = bottle('btl_f', []);
    expect(bottleWeatherAt(b, T, { force: 'on' })).toBe('storm');
    expect(bottleWeatherAt(bottle('btl_g', [win(T - 1, T + 1)]), T, { force: 'off' })).toBe('calm');
    // A forced storm is a preview of the same thing, so it no longer depends on the hour here.
    expect(bottleWeatherAt(bottle('btl_h', [], 'delivered'), T, { force: 'on' })).toBe('calm');
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
