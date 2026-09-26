// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
const drawn = vi.hoisted(() => ({ weather: [] as Record<string, BottleWeather>[] }));
vi.mock('../components/lazy.js', () => ({
  OceanMap: (props: { weather: Record<string, BottleWeather> }) => {
    drawn.weather.push(props.weather);
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
    // The storm is said in words…
    expect(screen.getByRole('status').textContent).toMatch(/storm is passing/);
    // …and there is no map-wide stripe or rain layer at all.
    expect(container.querySelector('.map-storm-sky')).toBeNull();
    const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8');
    const stormRules = css.slice(css.indexOf('.map-storm {'), css.indexOf('.map-storm-label {'));
    expect(stormRules).not.toMatch(/gradient|background/);
    expect(css).not.toMatch(/map-storm-sky|map-storm-rain/);
    // The cloud itself is the marker's storm glyph.
    expect(css).toMatch(/\.map-marker\.storm \.glyph/);
  });

  it('shows neither cloud nor storm message by day', async () => {
    weather.state.phase = 'day';
    weather.state.storm = 'calm';
    const { container } = mount();
    await waitFor(() => expect(drawn.weather.at(-1)).toEqual({ btl_sea: 'calm' }));
    expect(container.querySelector('.map-storm')).toBeNull();
  });
});
