import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type {
  NotificationsPageDto,
  ReceivedLetterDto,
  SentBottleSummaryDto,
  ShoreResponse,
} from '@mib/shared';
import * as t from '../db/schema.js';
import { DevClock } from '../lib/clock.js';
import { createApp } from './app.js';
import { createTestWorld, loginAs, makeDeveloper, releaseInput } from '../test/harness.js';

// Manual review round 1, follow-up item 2: "a regular account sent a bottle to an active
// developer; the shared DEV clock was advanced; the sender sees `arrived`; the developer cannot
// see it". Driven through the real HTTP surface with the real persisted DevClock — one clock for
// every account — so this is the same path a person takes in the development environment.
// Ada (ordinary, Lantern Cove) writes to Bo (developer, Driftmoor Strand).

const HOUR = 60 * 60 * 1000;
const json = (token: string) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
});

async function world() {
  const w = createTestWorld({ devMode: true });
  // The development server's journey clock: persisted, shared, advanced only by /api/dev/*.
  w.ctx.clock = new DevClock(w.db);
  makeDeveloper(w, 'bo');
  const app = createApp(w.ctx);
  const ada = await loginAs(app, 'ada');
  const bo = await loginAs(app, 'bo');
  const get = async <T>(path: string, token: string) => {
    const res = await app.request(path, { headers: json(token) });
    expect(res.status, path).toBe(200);
    return (await res.json()) as T;
  };
  const post = (path: string, token: string, body?: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: json(token),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const release = async (key: string) => {
    const res = await post('/api/bottles/release', ada.token, releaseInput(bo.id, key));
    expect(res.status).toBe(201);
    return ((await res.json()) as { bottle: { id: string } }).bottle.id;
  };
  // Every view the recipient and the sender have of it.
  const views = async (id: string) => {
    const sent = await get<{ bottles: SentBottleSummaryDto[] }>('/api/bottles/sent', ada.token);
    const shore = await get<ShoreResponse>('/api/shore', bo.token);
    const notes = await get<NotificationsPageDto>('/api/notifications', bo.token);
    return {
      senderState: sent.bottles.find((b) => b.id === id)?.state,
      onShore: shore.bottles.filter((b) => b.id === id).length,
      arrivalNotes: notes.notifications.filter(
        (n) => n.bottleId === id && n.kind === 'received_arrived',
      ).length,
    };
  };
  const slots = (id: string) =>
    w.db.select().from(t.capacityReservations).where(eq(t.capacityReservations.bottleId, id)).all();
  return { w, app, ada, bo, get, post, release, views, slots };
}

describe('a bottle arriving for a developer recipient on the shared DEV clock', () => {
  it('is on the developer’s shore, notified once, openable, and then in Received', async () => {
    const { w, ada, bo, get, post, release, views, slots } = await world();
    const id = await release('dev-arrival-0001');
    const plan = w.db.select().from(t.routePlans).where(eq(t.routePlans.bottleId, id)).get()!;
    expect(await views(id)).toEqual({ senderState: 'at_sea', onShore: 0, arrivalNotes: 0 });

    // The developer advances the shared clock past the arrival, as the DEV panel does.
    const advanced = await post('/api/dev/advance', bo.token, {
      ms: plan.plannedDurationMs + HOUR,
    });
    expect(advanced.status).toBe(200);
    expect(await views(id)).toEqual({ senderState: 'delivered', onShore: 1, arrivalNotes: 1 });

    // Polling, further advances and a fresh sign-in change nothing, and create nothing twice.
    for (let i = 0; i < 3; i++)
      expect((await post('/api/dev/advance', ada.token, { ms: HOUR })).status).toBe(403);
    await post('/api/dev/advance', bo.token, { ms: 24 * HOUR });
    await post('/api/dev/tick', bo.token);
    const again = await loginAs(createApp(w.ctx), 'bo');
    const shore = await get<ShoreResponse>('/api/shore', again.token);
    expect(shore.bottles.map((b) => b.id)).toEqual([id]);
    expect(await views(id)).toEqual({ senderState: 'delivered', onShore: 1, arrivalNotes: 1 });
    expect(slots(id)).toHaveLength(1);
    expect(
      w.db
        .select()
        .from(t.journeyEvents)
        .where(eq(t.journeyEvents.bottleId, id))
        .all()
        .filter((e) => e.type === 'delivered'),
    ).toHaveLength(1);

    // Opening it moves it to Received, for good.
    expect((await post(`/api/shore/bottles/${id}/open`, bo.token)).status).toBe(200);
    const received = await get<{ letters: ReceivedLetterDto[] }>('/api/shore/received', bo.token);
    expect(received.letters.map((l) => l.id)).toEqual([id]);
    expect((await views(id)).onShore).toBe(0);
    void ada;
  });

  it('arrives the same way in day-sized DEV steps, with a zone set and a harbour changed mid-journey', async () => {
    const { w, bo, post, release, views, app } = await world();
    const id = await release('dev-arrival-0002');
    // Bo sets a device zone and moves harbour while the bottle is at sea.
    await app.request('/api/auth/time-zone', {
      method: 'PUT',
      headers: json(bo.token),
      body: JSON.stringify({ timeZone: 'Asia/Jerusalem' }),
    });
    await app.request('/api/chart/my-shore', {
      method: 'PUT',
      headers: json(bo.token),
      body: JSON.stringify({ shoreId: 'shore_gull_hollow' }),
    });
    let steps = 0;
    while ((await views(id)).senderState === 'at_sea' && steps++ < 60)
      expect((await post('/api/dev/advance', bo.token, { ms: 24 * HOUR })).status).toBe(200);
    expect(await views(id)).toEqual({ senderState: 'delivered', onShore: 1, arrivalNotes: 1 });
    void w;
  });
});
