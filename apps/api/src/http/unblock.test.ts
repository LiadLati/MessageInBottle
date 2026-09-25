import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { BlockedUsersResponse, FriendsResponse } from '@mib/shared';
import * as t from '../db/schema.js';
import { createApp } from './app.js';
import { runJourneyTick } from '../services/journey.js';
import { devLoseBottle, listPublicOcean } from '../services/outcomes.js';
import { releaseBottle } from '../services/release.js';
import { createTestWorld, loginAs, releaseInput } from '../test/harness.js';

// Product decision 10: Settings → Blocked users → Unblock, behind a confirmation. Unblocking
// allows future contact under the ordinary rules; it restores nothing and reveals nothing.

const DAY = 24 * 60 * 60 * 1000;

async function setup() {
  const w = createTestWorld({ defaultShoreCapacity: 40 });
  const app = createApp(w.ctx);
  const ada = await loginAs(app, 'ada');
  const bo = await loginAs(app, 'bo');
  const call = (token: string, method: string, path: string, body?: unknown) =>
    app.request(`/api${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { w, app, ada, bo, call };
}
const json = async <T>(res: Response) => (await res.json()) as T;
let n = 0;
const key = () => `unblock-${String(++n).padStart(8, '0')}`;

describe('blocked users and unblocking (product decision 10)', () => {
  it('lists only the blocks you placed, and unblocks without restoring the friendship', async () => {
    const { w, ada, bo, call } = await setup();
    // A bottle to Bo is travelling when Ada blocks Bo; the block ends it at arrival.
    const inFlight = releaseBottle(
      w.ctx,
      w.user('ada'),
      releaseInput(w.user('bo').id, key()),
    ).bottleId;
    expect((await call(ada.token, 'POST', '/friends/blocks', { username: 'bo' })).status).toBe(204);
    w.clock.advance(60 * DAY);
    runJourneyTick(w.ctx);
    expect(w.db.select().from(t.bottles).where(eq(t.bottles.id, inFlight)).get()!.state).toBe(
      'cancelled',
    );

    const mine = await json<BlockedUsersResponse>(await call(ada.token, 'GET', '/friends/blocks'));
    expect(mine.blocked.map((b) => b.username)).toEqual(['bo']);
    // Bo is never told who blocked them.
    const theirs = await json<BlockedUsersResponse>(await call(bo.token, 'GET', '/friends/blocks'));
    expect(theirs.blocked).toEqual([]);

    expect((await call(ada.token, 'DELETE', '/friends/blocks/bo')).status).toBe(204);
    expect(
      (await json<BlockedUsersResponse>(await call(ada.token, 'GET', '/friends/blocks'))).blocked,
    ).toEqual([]);
    // Nothing from the blocked period comes back.
    expect(w.db.select().from(t.bottles).where(eq(t.bottles.id, inFlight)).get()!.state).toBe(
      'cancelled',
    );
    // Not friends again until a new request is accepted.
    const friends = await json<FriendsResponse>(await call(ada.token, 'GET', '/friends'));
    expect(friends.friends.map((f) => f.username)).not.toContain('bo');
    expect(() => releaseBottle(w.ctx, w.user('ada'), releaseInput(w.user('bo').id, key()))).toThrow(
      /approved friends/,
    );
    expect((await call(ada.token, 'POST', '/friends/requests', { username: 'bo' })).status).toBe(
      204,
    );
    const request = (await json<FriendsResponse>(await call(bo.token, 'GET', '/friends')))
      .incomingRequests[0]!;
    expect((await call(bo.token, 'POST', `/friends/requests/${request.id}/accept`)).status).toBe(
      204,
    );
    expect(() =>
      releaseBottle(w.ctx, w.user('ada'), releaseInput(w.user('bo').id, key())),
    ).not.toThrow();
  });

  it('keeps the other direction blocked until that person unblocks too', async () => {
    const { w, ada, bo, call } = await setup();
    await call(ada.token, 'POST', '/friends/blocks', { username: 'bo' });
    await call(bo.token, 'POST', '/friends/blocks', { username: 'ada' });
    await call(ada.token, 'DELETE', '/friends/blocks/bo');
    // Bo's block still stands: no request, no letter, either way.
    expect((await call(ada.token, 'POST', '/friends/requests', { username: 'bo' })).status).toBe(
      404,
    );
    await call(bo.token, 'DELETE', '/friends/blocks/ada');
    expect((await call(ada.token, 'POST', '/friends/requests', { username: 'bo' })).status).toBe(
      204,
    );
    void w;
  });

  it('permits future public-ocean encounters again', async () => {
    const { w, ada, call } = await setup();
    const bottleId = releaseBottle(
      w.ctx,
      w.user('bo'),
      releaseInput(w.user('ada').id, key()),
    ).bottleId;
    devLoseBottle(w.ctx, w.user('bo'), bottleId, 'adrift');
    const cy = w.user('cy');
    // Cy blocks Bo: Bo's adrift bottle is hidden from Cy…
    const cyLogin = await loginAs(createApp(w.ctx), 'cy');
    await call(cyLogin.token, 'POST', '/friends/blocks', { username: 'bo' });
    expect(listPublicOcean(w.ctx, cy).map((b) => b.id)).not.toContain(bottleId);
    // …until Cy unblocks.
    await call(cyLogin.token, 'DELETE', '/friends/blocks/bo');
    expect(listPublicOcean(w.ctx, cy).map((b) => b.id)).toContain(bottleId);
    void ada;
  });

  it('answers 404 for a block that does not exist', async () => {
    const { ada, call } = await setup();
    expect((await call(ada.token, 'DELETE', '/friends/blocks/bo')).status).toBe(404);
    expect((await call(ada.token, 'DELETE', '/friends/blocks/nobody-at-all')).status).toBe(404);
  });
});
