// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountWeatherDto } from '@mib/shared';
import type * as ClientModule from '../api/client.js';

// Risk policy v4 on the client: the device's IANA zone is read (no location), validated and
// reported after sign-in, on start, on return to the foreground and when it changes; the map
// then draws the *server's* authoritative zone and storm, so every device of the account shows
// the same day, night and storm. Controlled clock, no network, no dependence on the machine's
// own time zone (the device zone is stubbed).

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
  user: { id: 'usr_a', role: 'member', timeZone: null as string | null, shoreId: 'shr_x' },
  setUser: vi.fn(),
}));
vi.mock('./session.js', () => ({ useSession: () => session }));

import { WeatherProvider, useWeather } from './weather.js';

function Probe({ id = 'w' }: { id?: string }) {
  const w = useWeather();
  return (
    <span data-testid={id}>
      {w.timeZone}|{w.phase}|{w.storm}
    </span>
  );
}

let deviceZone: string | undefined = 'Europe/Paris';
const realFormat = Intl.DateTimeFormat;
vi.spyOn(Intl, 'DateTimeFormat').mockImplementation((...args: unknown[]) => {
  const f = new realFormat(...(args as ConstructorParameters<typeof Intl.DateTimeFormat>));
  if (args.length === 0) {
    return {
      ...f,
      resolvedOptions: () => ({ ...f.resolvedOptions(), timeZone: deviceZone }),
    } as Intl.DateTimeFormat;
  }
  return f;
});

// 20:00 in Paris (UTC+2 in September), 11:00 in Los Angeles.
const NOW = Date.parse('2026-09-06T18:00:00.000Z');
const weather = (over: Partial<AccountWeatherDto>): AccountWeatherDto => ({
  timeZone: 'Europe/Paris',
  timeZoneSource: 'device',
  phase: 'night',
  storm: null,
  lastRoll: null,
  nextRollNotBefore: null,
  serverTime: new Date(NOW).toISOString(),
  ...over,
});
const stormNow = {
  id: 'wrl_1',
  startsAt: new Date(NOW - 10 * 60_000).toISOString(),
  endsAt: new Date(NOW + 30 * 60_000).toISOString(),
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  session.user.timeZone = null;
  api.syncTimeZone.mockImplementation((zone: string) =>
    Promise.resolve({ ...session.user, timeZone: zone }),
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  deviceZone = 'Europe/Paris';
  localStorage.clear();
});

describe('the device reports its zone; the map draws the server’s clock', () => {
  it('reports on start, and again when it comes back to the foreground in a new zone', async () => {
    api.accountWeather.mockResolvedValue(weather({}));
    api.syncTimeZone.mockResolvedValue({ ...session.user, timeZone: 'Europe/Paris' });
    render(
      <WeatherProvider>
        <Probe />
      </WeatherProvider>,
    );
    await waitFor(() => expect(api.syncTimeZone).toHaveBeenCalledWith('Europe/Paris'));
    deviceZone = 'Asia/Jerusalem';
    act(() => void window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(api.syncTimeZone).toHaveBeenCalledWith('Asia/Jerusalem'));
  });

  it('never sends an invalid zone, and still draws the server’s clock', async () => {
    deviceZone = '+05:00';
    api.accountWeather.mockResolvedValue(
      weather({ timeZone: 'Etc/GMT-2', timeZoneSource: 'harbour' }),
    );
    render(
      <WeatherProvider>
        <Probe />
      </WeatherProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('w').textContent).toMatch(/^Etc\/GMT-2\|/));
    expect(api.syncTimeZone).not.toHaveBeenCalled();
  });

  it('flips the map to day as soon as the server accepts a zone where it is day', async () => {
    api.accountWeather.mockResolvedValue(weather({ storm: stormNow }));
    render(
      <WeatherProvider>
        <Probe />
      </WeatherProvider>,
    );
    // Paris, 20:00, a storm on: night and storm.
    session.user.timeZone = 'Europe/Paris';
    await waitFor(() =>
      expect(screen.getByTestId('w').textContent).toBe('Europe/Paris|night|storm'),
    );
    // The phone reaches Los Angeles (11:00 there) and returns to the foreground.
    deviceZone = 'America/Los_Angeles';
    api.syncTimeZone.mockResolvedValue({ ...session.user, timeZone: 'America/Los_Angeles' });
    api.accountWeather.mockResolvedValue(
      weather({ timeZone: 'America/Los_Angeles', phase: 'day', storm: null }),
    );
    act(() => void window.dispatchEvent(new Event('focus')));
    await waitFor(() =>
      expect(screen.getByTestId('w').textContent).toBe('America/Los_Angeles|day|calm'),
    );
  });

  it('never draws a storm on a daytime map, whatever arrives', async () => {
    // A (stale) storm window on a clock where it is 11:00: the map stays calm.
    api.accountWeather.mockResolvedValue(
      weather({ timeZone: 'America/Los_Angeles', phase: 'day', storm: stormNow }),
    );
    session.user.timeZone = 'America/Los_Angeles';
    deviceZone = 'America/Los_Angeles';
    render(
      <WeatherProvider>
        <Probe />
      </WeatherProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('w').textContent).toBe('America/Los_Angeles|day|calm'),
    );
  });

  it('gives two devices of one account the same day, night and storm', async () => {
    api.accountWeather.mockResolvedValue(weather({ storm: stormNow }));
    session.user.timeZone = 'Europe/Paris';
    // A phone and a desktop whose own devices are in different zones: both draw the server's.
    render(
      <>
        <WeatherProvider>
          <Probe id="phone" />
        </WeatherProvider>
      </>,
    );
    deviceZone = 'Asia/Tokyo';
    render(
      <WeatherProvider>
        <Probe id="desktop" />
      </WeatherProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('phone').textContent).toBe('Europe/Paris|night|storm');
      expect(screen.getByTestId('desktop').textContent).toBe(
        screen.getByTestId('phone').textContent,
      );
    });
  });
});
