// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_CLOCK_RESET_PROMPT } from '@mib/shared';
import type * as ClientModule from '../api/client.js';

// "Return to real time" in the DEV bar (manual review round 1, follow-up item 3).

const api = vi.hoisted(() => ({
  devStatus: vi.fn(),
  sentBottles: vi.fn(),
  devOutbox: vi.fn(),
  devResetClock: vi.fn(),
}));
vi.mock('../api/client.js', async (actual) => ({
  ...(await actual<typeof ClientModule>()),
  api,
}));
const session = vi.hoisted(() => ({ user: { id: 'usr_d', role: 'developer' } }));
vi.mock('../state/session.js', () => ({ useSession: () => session }));
const resync = vi.hoisted(() => vi.fn());
vi.mock('../state/weather.js', () => ({
  useWeather: () => ({
    resync,
    phase: 'day',
    phaseOverride: 'auto',
    oceanStormOverride: 'auto',
    shoreStormOverride: 'auto',
    setPhaseOverride: vi.fn(),
    setOceanStormOverride: vi.fn(),
    setShoreStormOverride: vi.fn(),
    timeZone: 'UTC',
  }),
}));

import { DevPanel } from './DevPanel.js';

const status = (offset: number) => ({
  devMode: true,
  serverTime: new Date(Date.now() + offset).toISOString(),
  clockOffsetMs: offset,
  msPerChartUnit: 3_600_000,
});

beforeEach(() => {
  session.user.role = 'developer';
  api.devStatus.mockResolvedValue(status(3 * 86_400_000));
  api.sentBottles.mockResolvedValue({ bottles: [] });
  api.devOutbox.mockResolvedValue({ provider: 'outbox', messages: [] });
  api.devResetClock.mockResolvedValue(status(0));
  resync.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openPanel(onChanged = vi.fn()) {
  render(<DevPanel onChanged={onChanged} refreshKey={0} />);
  fireEvent.click(await screen.findByRole('button', { name: /^Dev clock/ }));
  return { onChanged, reset: screen.getByRole('button', { name: 'Return to real time' }) };
}

describe('Return to real time', () => {
  it('asks first, and Cancel changes nothing', async () => {
    const { reset } = await openPanel();
    fireEvent.click(reset);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain(DEV_CLOCK_RESET_PROMPT);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.devResetClock).not.toHaveBeenCalled();
  });

  it('resets the shared clock once confirmed, and refreshes this device at once', async () => {
    const { reset, onChanged } = await openPanel();
    fireEvent.click(reset);
    const confirm = screen
      .getAllByRole('button', { name: 'Return to real time' })
      .find((b) => b.closest('[role="alertdialog"]'))!;
    await act(async () => {
      fireEvent.click(confirm);
      await Promise.resolve();
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.devResetClock).toHaveBeenCalledTimes(1);
    expect(resync).toHaveBeenCalled();
  });

  it('is disabled while the clock already runs at real time', async () => {
    api.devStatus.mockResolvedValue(status(0));
    const { reset } = await openPanel();
    expect((reset as HTMLButtonElement).disabled).toBe(true);
  });

  it('is not shown to anyone but a developer', () => {
    session.user.role = 'member';
    const { container } = render(<DevPanel onChanged={vi.fn()} refreshKey={0} />);
    expect(container.textContent).toBe('');
  });
});
