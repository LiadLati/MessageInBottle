// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as ClientModule from '../api/client.js';

// Product decision 9: the device's IANA zone is read (no location), validated, sent to the
// server on start and on every resume, and a device without a usable zone falls back to the
// harbour's zone, then UTC — and sends nothing.

const api = vi.hoisted(() => ({
  syncTimeZone: vi.fn(),
  chart: vi.fn(),
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

function Zone() {
  return <span data-testid="zone">{useWeather().timeZone}</span>;
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  deviceZone = 'Europe/Paris';
  localStorage.clear();
});

describe('the device time zone', () => {
  it('is sent when valid, and again when it changes on resume', async () => {
    api.syncTimeZone.mockResolvedValue({ ...session.user, timeZone: 'Europe/Paris' });
    render(
      <WeatherProvider>
        <Zone />
      </WeatherProvider>,
    );
    await waitFor(() => expect(api.syncTimeZone).toHaveBeenCalledWith('Europe/Paris'));
    deviceZone = 'Asia/Jerusalem';
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(api.syncTimeZone).toHaveBeenCalledWith('Asia/Jerusalem'));
  });

  it('is never sent when the device reports no valid IANA name; the harbour zone is shown', async () => {
    deviceZone = '+05:00';
    api.chart.mockResolvedValue({ shores: [{ id: 'shr_x', geo: { lng: 34.8, lat: 32 } }] });
    render(
      <WeatherProvider>
        <Zone />
      </WeatherProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('zone').textContent).toBe('Etc/GMT-2'));
    expect(api.syncTimeZone).not.toHaveBeenCalled();
  });

  it('falls back to UTC when neither the device nor the harbour gives a zone', async () => {
    deviceZone = undefined;
    api.chart.mockResolvedValue({ shores: [] });
    render(
      <WeatherProvider>
        <Zone />
      </WeatherProvider>,
    );
    await waitFor(() => expect(api.chart).toHaveBeenCalled());
    expect(screen.getByTestId('zone').textContent).toBe('UTC');
    expect(api.syncTimeZone).not.toHaveBeenCalled();
  });
});
