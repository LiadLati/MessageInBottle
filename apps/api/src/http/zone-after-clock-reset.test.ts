import { describe, expect, it } from 'vitest';
import { DEV_CLOCK_RESET_CONFIRMATION, phaseAt, type AccountWeatherDto } from '@mib/shared';
import { DevClock } from '../lib/clock.js';
import { createApp } from './app.js';
import { createTestWorld, loginAs, makeDeveloper } from '../test/harness.js';

// Manual review round 2, item 1: one account's map clock was hours behind the others. Cause:
// the zone in force was "the zone row with the latest effective time", and that time is the
// shared DEV clock. A zone recorded while the clock was ahead kept a future timestamp after
// "Return to real time", so it outranked every later device report: the account stored the
// device's zone but the map kept the old one, and the device, seeing its zone already stored,
// never reported again. The zone in force is now the last one the server accepted.

const DAY = 86_400_000;
const json = (token: string) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
});

async function world() {
  const w = createTestWorld({ devMode: true });
  w.ctx.clock = new DevClock(w.db);
  makeDeveloper(w, 'bo');
  const app = createApp(w.ctx);
  const ada = await loginAs(app, 'ada');
  const bo = await loginAs(app, 'bo');
  const weather = async () =>
    (await (
      await app.request('/api/ocean/weather', { headers: json(ada.token) })
    ).json()) as AccountWeatherDto;
  const report = async (timeZone: string) => {
    const res = await app.request('/api/auth/time-zone', {
      method: 'PUT',
      headers: json(ada.token),
      body: JSON.stringify({ timeZone }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { timeZone: string | null };
  };
  const dev = (path: string, body: unknown) =>
    app.request(`/api/dev/${path}`, {
      method: 'POST',
      headers: json(bo.token),
      body: JSON.stringify(body),
    });
  return { weather, report, dev };
}

describe('the map clock follows the device zone across DEV jumps and "Return to real time"', () => {
  it('uses the zone the device reported after the reset, not one recorded in the rewound future', async () => {
    const { weather, report, dev } = await world();
    await report('Asia/Jerusalem');
    expect((await dev('advance', { ms: 5 * DAY })).status).toBe(200);
    await report('Europe/London');
    expect((await weather()).timeZone).toBe('Europe/London');
    expect((await dev('reset-clock', { confirm: DEV_CLOCK_RESET_CONFIRMATION })).status).toBe(200);

    const me = await report('Asia/Jerusalem');
    expect(me.timeZone).toBe('Asia/Jerusalem');
    const w = await weather();
    // The account's stored zone and the map's zone agree…
    expect(w.timeZone).toBe('Asia/Jerusalem');
    expect(w.timeZoneSource).toBe('device');
    // …and the map's phase is the phase of that zone at the server's instant.
    expect(w.phase).toBe(phaseAt(Date.parse(w.serverTime), 'Asia/Jerusalem'));
  });

  it('keeps following later device changes after a reset, and forward jumps change nothing', async () => {
    const { weather, report, dev } = await world();
    await dev('advance', { ms: 3 * DAY });
    await report('America/New_York');
    await dev('reset-clock', { confirm: DEV_CLOCK_RESET_CONFIRMATION });
    await report('Asia/Tokyo');
    expect((await weather()).timeZone).toBe('Asia/Tokyo');
    await dev('advance', { ms: DAY });
    expect((await weather()).timeZone).toBe('Asia/Tokyo');
    await report('Europe/Paris');
    expect((await weather()).timeZone).toBe('Europe/Paris');
  });
});
