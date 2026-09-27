// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SentBottleSummaryDto } from '@mib/shared';
import type * as ClientModule from '../api/client.js';
import type { BottleWeather } from '../lib/oceanWeather.js';

// The Ocean screen over a stand-in map that records what it is asked to draw (the real map needs
// WebGL). Manual review round 1, follow-up.

const api = vi.hoisted(() => ({
  sentBottles: vi.fn(),
  chart: vi.fn(),
  publicOcean: vi.fn(),
}));
vi.mock('../api/client.js', async (actual) => ({
  ...(await actual<typeof ClientModule>()),
  api,
}));
vi.mock('../state/session.js', () => ({
  useSession: () => ({
    user: { id: 'usr_a', displayName: 'Ada', shoreId: 'shr_a', role: 'member' },
  }),
}));
const weather = vi.hoisted(() => ({
  state: {
    phase: 'night',
    nowMs: Date.parse('2026-09-26T16:54:00.000Z'),
    timeZone: 'Asia/Jerusalem',
    storm: 'storm',
    stormUntil: null as number | null,
    phaseOverride: 'auto',
    oceanStormOverride: 'auto',
    shoreStormOverride: 'auto',
  },
}));
vi.mock('../state/weather.js', () => ({ useWeather: () => weather.state }));
vi.mock('../lib/webgl.js', () => ({ isWebGLAvailable: () => true }));
const drawn = vi.hoisted(() => ({
  weather: [] as Record<string, BottleWeather>[],
  select: null as ((id: string) => void) | null,
}));
vi.mock('../components/lazy.js', () => ({
  OceanMap: (props: {
    weather: Record<string, BottleWeather>;
    onSelectRoute?: (id: string) => void;
  }) => {
    drawn.weather.push(props.weather);
    drawn.select = props.onSelectRoute ?? null;
    return <div data-testid="map" />;
  },
  SeaViewer: () => null,
}));

import { OceanScreen } from './OceanScreen.js';

const bottle = {
  id: 'btl_sea',
  state: 'at_sea',
  version: 1,
  recipient: { id: 'usr_b', displayName: 'Bo' },
  originShore: { id: 'shr_a', name: 'Heron Reach' },
  destinationShore: { id: 'shr_b', name: 'Cobh' },
  releasedAt: '2026-09-25T10:00:00.000Z',
  deliveredAt: null,
  openedAt: null,
  elapsedMs: 3_600_000,
  elapsedIsLive: true,
  plannedArrivalAt: '2026-09-30T10:00:00.000Z',
  route: {
    version: 2,
    nodeIds: ['a', 'b'],
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
    geoPoints: [
      { lng: -20, lat: 50 },
      { lng: -8, lat: 51 },
    ],
    totalLength: 2,
    plannedDurationMs: 5 * 86_400_000,
  },
  position: {
    point: { x: 0.5, y: 0.5 },
    geo: { lng: -14, lat: 50.5 },
    progress: 0.2,
    asOf: '2026-09-26T16:54:00.000Z',
  },
  outcome: null,
  visibility: null,
  publicListing: null,
} as unknown as SentBottleSummaryDto;

beforeEach(() => {
  drawn.weather = [];
  api.sentBottles.mockResolvedValue({ bottles: [bottle] });
  api.chart.mockResolvedValue({ shores: [] });
  api.publicOcean.mockResolvedValue({ bottles: [] });
  weather.state.phase = 'night';
  weather.state.storm = 'storm';
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const mount = () =>
  render(<OceanScreen onOpenPassport={vi.fn()} onWrite={vi.fn()} onOpenProfile={vi.fn()} />);

describe('the storm on the Ocean map', () => {
  it('gives the bottle at sea its storm cloud and lays nothing over the map', async () => {
    const { container } = mount();
    await waitFor(() => expect(drawn.weather.at(-1)).toEqual({ btl_sea: 'storm' }));
    // No floating storm message and no map-wide layer (manual review rounds 1 and 2)…
    expect(screen.queryByText(/storm is passing/i)).toBeNull();
    expect(container.querySelector('.map-storm, .map-storm-sky')).toBeNull();
    const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8');
    expect(css).not.toMatch(/\.map-storm/);
    // …only the marker's storm glyph, the cloud above the bottle.
    expect(css).toMatch(/\.map-marker\.storm \.glyph/);
  });

  it('explains the storm, with its end time, in the bottle’s journey card', async () => {
    weather.state.stormUntil = Date.parse('2026-09-26T17:48:00.000Z');
    mount();
    await waitFor(() => expect(drawn.select).not.toBeNull());
    act(() => drawn.select!('btl_sea'));
    const card = await screen.findByText(/A storm is over your sea/);
    // 17:48 UTC is 20:48 in Jerusalem, the account's zone.
    expect(card.textContent).toBe(
      'A storm is over your sea until 20:48. Each bottle at sea faces it on its own.',
    );
    expect(screen.getByText('In a storm')).toBeTruthy();
    weather.state.stormUntil = null;
  });

  it('shows neither cloud nor storm message by day', async () => {
    weather.state.phase = 'day';
    weather.state.storm = 'calm';
    const { container } = mount();
    await waitFor(() => expect(drawn.weather.at(-1)).toEqual({ btl_sea: 'calm' }));
    expect(container.querySelector('.map-storm')).toBeNull();
    expect(screen.queryByText(/storm/i)).toBeNull();
  });
});

describe('the private Ocean with nothing at sea', () => {
  it('leaves the map unobstructed: no empty-state card, no second Write button', async () => {
    api.sentBottles.mockResolvedValue({ bottles: [] });
    mount();
    await screen.findByRole('heading', { name: 'Ocean' });
    await waitFor(() => expect(api.sentBottles).toHaveBeenCalled());
    expect(screen.queryByText('No bottles at sea')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Write a letter' })).toBeTruthy(); // the header +
    expect(screen.getAllByRole('button', { name: /Write a letter/ })).toHaveLength(1);
    expect(document.querySelector('section.sheet')).toBeNull();
  });

  it('still shows a load error', async () => {
    api.sentBottles.mockResolvedValue({ bottles: [] });
    api.chart.mockRejectedValue(new Error('chart unavailable'));
    mount();
    expect(await screen.findByText(/chart unavailable/)).toBeTruthy();
  });
});

describe('the date and time below the map title', () => {
  const subtitle = () => document.querySelector('.world-header .map-clock')?.textContent;

  it('shows the server instant in the account zone, in English, even with nothing at sea', async () => {
    api.sentBottles.mockResolvedValue({ bottles: [] });
    weather.state.storm = 'calm';
    mount();
    await screen.findByRole('heading', { name: 'Ocean' });
    // 16:54 UTC is 19:54 in Jerusalem in September.
    expect(subtitle()).toBe('26 Sep 2026 · 19:54');
    expect(document.body.textContent).not.toMatch(/Nothing at sea/);
  });

  it('is the same instant in another zone, shown on that zone’s clock', async () => {
    weather.state.timeZone = 'America/New_York';
    mount();
    await waitFor(() => expect(subtitle()).toBe('26 Sep 2026 · 12:54'));
    weather.state.timeZone = 'Asia/Jerusalem';
  });

  it('follows the shared clock when it jumps, forward or back to real time', async () => {
    const view = mount();
    await waitFor(() => expect(subtitle()).toBe('26 Sep 2026 · 19:54'));
    weather.state = { ...weather.state, nowMs: Date.parse('2026-10-03T08:05:00.000Z') };
    view.rerender(
      <OceanScreen onOpenPassport={vi.fn()} onWrite={vi.fn()} onOpenProfile={vi.fn()} />,
    );
    expect(subtitle()).toBe('3 Oct 2026 · 11:05');
    weather.state = { ...weather.state, nowMs: Date.parse('2026-09-26T16:54:00.000Z') };
    view.rerender(
      <OceanScreen onOpenPassport={vi.fn()} onWrite={vi.fn()} onOpenProfile={vi.fn()} />,
    );
    expect(subtitle()).toBe('26 Sep 2026 · 19:54');
  });

  it('is on the public map too, and the public empty-state card stays', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Public' }));
    await screen.findByRole('heading', { name: 'Public ocean' });
    expect(subtitle()).toBe('26 Sep 2026 · 19:54');
    await waitFor(() => expect(screen.getByText('Nothing adrift')).toBeTruthy());
  });
});
