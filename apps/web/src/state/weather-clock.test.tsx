// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountWeatherDto } from '@mib/shared';
import type * as ClientModule from '../api/client.js';

// Audit FE-R-003: the map's day, night and storm follow the server's clock, never the device's.
// The latest `serverTime` is the authority; between answers it advances with monotonic time
// (`performance.now()`), which a wall-clock change cannot move. Controlled Date and
// performance clocks; no network; the account zone is Paris (UTC+2 in September), where day is
// 07:00–19:00.

const api = vi.hoisted(() => ({
  syncTimeZone: vi.fn(),
  accountWeather: vi.fn(),
  devStatus: vi.fn(),
}));
vi.mock('../api/client.js', async (actual) => ({
  ...(await actual<typeof ClientModule>()),
  api,
}));
const session = vi.hoisted(() => ({
  user: { id: 'usr_a', role: 'member', timeZone: 'Europe/Paris', shoreId: 'shr_x' },
  setUser: vi.fn(),
}));
vi.mock('./session.js', () => ({ useSession: () => session }));

import { WeatherProvider, useWeather } from './weather.js';

function Probe() {
  const w = useWeather();
  return (
    <span data-testid="w">
      {w.phase}|{w.storm}|{w.stormUntil === null ? '-' : new Date(w.stormUntil).toISOString()}
    </span>
  );
}
const shown = () => screen.getByTestId('w').textContent;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY_1650 = Date.parse('2026-09-06T14:50:00.000Z'); // 16:50 in Paris: day
const NIGHT_2000 = Date.parse('2026-09-06T18:00:00.000Z'); // 20:00 in Paris: night
const DUSK_1850 = Date.parse('2026-09-06T16:50:00.000Z'); // 18:50 in Paris: ten minutes of day left

const weatherAt = (serverMs: number, over: Partial<AccountWeatherDto> = {}): AccountWeatherDto => ({
  timeZone: 'Europe/Paris',
  timeZoneSource: 'device',
  phase: 'day',
  storm: null,
  lastRoll: null,
  nextRollNotBefore: null,
  serverTime: new Date(serverMs).toISOString(),
  ...over,
});
const stormAround = (ms: number) => ({
  id: 'wrl_1',
  startsAt: new Date(ms - 10 * MIN).toISOString(),
  endsAt: new Date(ms + 30 * MIN).toISOString(),
});
// Answers once, then never again: nothing but the monotonic clock can move the map afterwards.
const answerOnce = (w: AccountWeatherDto) =>
  api.accountWeather.mockResolvedValueOnce(w).mockReturnValue(new Promise(() => {}));

let hidden = false;
Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
const foreground = () =>
  act(() => {
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });

// The device reports Paris; no dependence on the machine's own zone.
const realFormat = Intl.DateTimeFormat;
vi.spyOn(Intl, 'DateTimeFormat').mockImplementation((...args: unknown[]) => {
  const f = new realFormat(...(args as ConstructorParameters<typeof Intl.DateTimeFormat>));
  if (args.length === 0) {
    return {
      ...f,
      resolvedOptions: () => ({ ...f.resolvedOptions(), timeZone: 'Europe/Paris' }),
    };
  }
  return f;
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance'] });
  hidden = false;
  api.syncTimeZone.mockResolvedValue({ ...session.user });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  api.accountWeather.mockReset();
  vi.useRealTimers();
  localStorage.clear();
});

const mount = () =>
  render(
    <WeatherProvider>
      <Probe />
    </WeatherProvider>,
  );

describe('the map follows the server clock, not the device clock (FE-R-003)', () => {
  it('shows day when the server says 16:50 although the device clock runs six hours ahead', async () => {
    vi.setSystemTime(DAY_1650 + 6 * HOUR); // the device thinks it is 22:50
    answerOnce(weatherAt(DAY_1650));
    mount();
    await waitFor(() => expect(shown()).toBe('day|calm|-'));
  });

  it('shows night when the server says 20:00 although the device clock runs six hours behind', async () => {
    vi.setSystemTime(NIGHT_2000 - 6 * HOUR); // the device thinks it is 14:00
    answerOnce(weatherAt(NIGHT_2000, { phase: 'night' }));
    mount();
    await waitFor(() => expect(shown()).toBe('night|calm|-'));
  });

  it('draws the server’s storm, until the server’s end, whatever the device clock says', async () => {
    const storm = stormAround(NIGHT_2000);
    vi.setSystemTime(NIGHT_2000 + 6 * HOUR);
    answerOnce(weatherAt(NIGHT_2000, { phase: 'night', storm }));
    mount();
    await waitFor(() => expect(shown()).toBe(`night|storm|${storm.endsAt}`));
  });

  it('ignores the wall clock being changed while the app is open', async () => {
    const storm = stormAround(NIGHT_2000);
    vi.setSystemTime(NIGHT_2000);
    answerOnce(weatherAt(NIGHT_2000, { phase: 'night', storm }));
    mount();
    await waitFor(() => expect(shown()).toBe(`night|storm|${storm.endsAt}`));
    // Someone sets the device twelve hours forward, then twelve back, and the page re-reads time.
    for (const jump of [12 * HOUR, -24 * HOUR]) {
      vi.setSystemTime(Date.now() + jump);
      act(() => void window.dispatchEvent(new Event('focus')));
      expect(shown()).toBe(`night|storm|${storm.endsAt}`);
    }
  });

  it('advances with elapsed time between answers: dusk arrives on time', async () => {
    vi.setSystemTime(DUSK_1850 - 3 * HOUR); // wrong device clock throughout
    answerOnce(weatherAt(DUSK_1850));
    mount();
    await waitFor(() => expect(shown()).toBe('day|calm|-'));
    // Twenty minutes pass on the monotonic clock; no new answer arrives.
    act(() => void vi.advanceTimersByTime(20 * MIN));
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(shown()).toBe('night|calm|-');
  });

  it('resynchronises to a fresh server answer that crosses into night', async () => {
    vi.setSystemTime(DUSK_1850 + 9 * HOUR);
    api.accountWeather.mockResolvedValue(weatherAt(DUSK_1850));
    mount();
    await waitFor(() => expect(shown()).toBe('day|calm|-'));
    // The next answer (a poll, a resume) says it is 19:10 there.
    api.accountWeather.mockResolvedValue(weatherAt(DUSK_1850 + 20 * MIN, { phase: 'night' }));
    act(() => void window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(shown()).toBe('night|calm|-'));
  });

  it('after sleeping in the background, takes the server’s time on return to the foreground', async () => {
    vi.setSystemTime(DAY_1650);
    const storm = stormAround(DAY_1650 + 4 * HOUR);
    api.accountWeather.mockResolvedValue(weatherAt(DAY_1650));
    mount();
    await waitFor(() => expect(shown()).toBe('day|calm|-'));
    // The device sleeps: the monotonic clock does not advance, four hours pass on the server.
    act(() => {
      hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    api.accountWeather.mockResolvedValue(weatherAt(DAY_1650 + 4 * HOUR, { phase: 'night', storm }));
    foreground();
    await waitFor(() => expect(shown()).toBe(`night|storm|${storm.endsAt}`));
  });

  it('shows a calm night as calm and a storm night as a storm, from the same server time', async () => {
    vi.setSystemTime(NIGHT_2000 - 11 * HOUR);
    answerOnce(weatherAt(NIGHT_2000, { phase: 'night' }));
    const calm = mount();
    await waitFor(() => expect(shown()).toBe('night|calm|-'));
    calm.unmount();
    const storm = stormAround(NIGHT_2000);
    answerOnce(weatherAt(NIGHT_2000, { phase: 'night', storm }));
    mount();
    await waitFor(() => expect(shown()).toBe(`night|storm|${storm.endsAt}`));
  });
});
