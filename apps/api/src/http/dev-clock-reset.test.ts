import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { DEV_CLOCK_RESET_CONFIRMATION, type AccountWeatherDto, type DevStatus } from '@mib/shared';
import * as t from '../db/schema.js';
import { DevClock } from '../lib/clock.js';
import { createApp } from './app.js';
import { createTestWorld, loginAs, makeDeveloper, releaseInput } from '../test/harness.js';

// "Return to real time" (manual review round 1, follow-up item 3): a developer puts the one
// shared DEV clock back to real time. It moves the clock and nothing else.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const json = (token?: string) => ({
  'content-type': 'application/json',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

async function world(devMode = true) {
  const w = createTestWorld({ devMode });
  w.ctx.clock = new DevClock(w.db);
  makeDeveloper(w, 'bo');
  w.db
    .update(t.users)
    .set({ role: 'admin' })
    .where(eq(t.users.id, w.user('cy').id))
    .run();
  const app = createApp(w.ctx);
  const [ada, bo, cy] = await Promise.all(['ada', 'bo', 'cy'].map((u) => loginAs(app, u)));
  const post = (path: string, token?: string, body?: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: json(token),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const reset = (token?: string, confirm: unknown = DEV_CLOCK_RESET_CONFIRMATION) =>
    post('/api/dev/reset-clock', token, { confirm });
  const serverTimeFor = async (token: string) => {
    const res = await app.request('/api/ocean/weather', { headers: json(token) });
    return Date.parse(((await res.json()) as AccountWeatherDto).serverTime);
  };
  return { w, app, ada: ada!, bo: bo!, cy: cy!, post, reset, serverTimeFor };
}

describe('Return to real time: who may, and only when confirmed', () => {
  it('is for a signed-in developer only, and needs the explicit confirmation', async () => {
    const { ada, bo, cy, post, reset } = await world();
    expect((await reset()).status).toBe(401);
    expect((await reset(ada.token)).status).toBe(403);
    expect((await reset(cy.token)).status).toBe(403); // an administrator is not a developer
    expect((await reset(bo.token, null)).status).toBe(400);
    expect((await post('/api/dev/reset-clock', bo.token, {})).status).toBe(400);
    expect((await reset(bo.token, 'yes')).status).toBe(400);
    expect((await reset(bo.token)).status).toBe(200);
  });

  it('does not exist outside development mode', async () => {
    const { bo, reset } = await world(false);
    expect((await reset(bo.token)).status).toBe(404);
  });
});

describe('Return to real time: one clock, nothing reversed', () => {
  it('returns the shared clock to real time for every account', async () => {
    const { ada, bo, post, reset, serverTimeFor } = await world();
    expect((await post('/api/dev/advance', bo.token, { ms: 3 * DAY })).status).toBe(200);
    // The member sees the developer's jump: it is one clock.
    expect((await serverTimeFor(ada.token)) - Date.now()).toBeGreaterThan(3 * DAY - HOUR);
    const res = await reset(bo.token);
    const status = (await res.json()) as DevStatus;
    expect(status.clockOffsetMs).toBe(0);
    expect(Math.abs((await serverTimeFor(ada.token)) - Date.now())).toBeLessThan(5_000);
    expect(Math.abs((await serverTimeFor(bo.token)) - Date.now())).toBeLessThan(5_000);
    // Persisted, so a restart keeps it.
    expect(new DevClock(createTestWorld().db).offset()).toBe(0);
  });

  it('keeps arrivals, losses, notifications, slots and events settled; new journeys start now', async () => {
    const { w, ada, bo, post, reset } = await world();
    // Bo (developer) sends three letters to Ada: one will arrive, one is lost, one stays at sea.
    const release = async (key: string) =>
      (
        (await (
          await post('/api/bottles/release', bo.token, releaseInput(ada.id, key))
        ).json()) as {
          bottle: { id: string };
        }
      ).bottle.id;
    const arrives = await release('reset-arrive-01');
    const lost = await release('reset-lost-0001');
    expect(
      (await post('/api/dev/lose', bo.token, { bottleId: lost, reason: 'adrift' })).status,
    ).toBe(200);
    const arrival = w.db
      .select()
      .from(t.routePlans)
      .where(eq(t.routePlans.bottleId, arrives))
      .get()!;
    await post('/api/dev/advance', bo.token, { ms: arrival.plannedDurationMs + DAY });
    // Released in the simulated future, still at sea when the clock goes back.
    const future = await release('reset-future-01');

    const snapshot = () => ({
      bottles: w.db
        .select()
        .from(t.bottles)
        .all()
        .map((b) => ({
          id: b.id,
          state: b.state,
          deliveredAt: b.deliveredAt,
          lossReason: b.lossReason,
          releasedAt: b.releasedAt,
        })),
      notifications: w.db
        .select()
        .from(t.notifications)
        .all()
        .map((n) => n.id)
        .sort(),
      events: w.db.select().from(t.journeyEvents).all().length,
      slots: w.db
        .select()
        .from(t.capacityReservations)
        .all()
        .map((s) => `${s.bottleId}:${s.status}`)
        .sort(),
      rolls: w.db.select().from(t.weatherRolls).all().length,
    });
    const before = snapshot();
    expect(before.bottles.find((b) => b.id === arrives)?.state).toBe('delivered');
    expect(before.bottles.find((b) => b.id === lost)?.state).toBe('lost');
    expect(before.bottles.find((b) => b.id === future)?.state).toBe('at_sea');

    expect((await reset(bo.token)).status).toBe(200);
    // The worker runs on the reset clock, and anything that reads the clock runs too.
    await post('/api/dev/tick', bo.token);
    await (await import('./app.js')).createApp(w.ctx).request('/api/ocean/weather', {
      headers: json(ada.token),
    });
    const after = snapshot();
    expect(after.bottles).toEqual(before.bottles);
    expect(after.notifications).toEqual(before.notifications);
    expect(after.events).toBe(before.events);
    expect(after.slots).toEqual(before.slots);
    expect(after.rolls).toBe(before.rolls);
    // The arrival stays in the future relative to the clock, and still counts as arrived.
    const delivered = after.bottles.find((b) => b.id === arrives)!;
    expect(delivered.deliveredAt! > Date.now()).toBe(true);
    const shore = w.ctx.db.select().from(t.bottles).where(eq(t.bottles.id, arrives)).get();
    expect(shore?.state).toBe('delivered');

    // A journey released now starts at real time.
    const fresh = await release('reset-fresh-001');
    const row = w.db.select().from(t.bottles).where(eq(t.bottles.id, fresh)).get()!;
    expect(Math.abs(row.releasedAt - Date.now())).toBeLessThan(5_000);
  });
});
