import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import * as t from '../db/schema.js';
import { runJourneyTick } from '../services/journey.js';
import { createTestWorld, loginAs, releaseInput } from '../test/harness.js';

// Audit QA-017: the friend-request branches and the block route, through the HTTP surface.

const DAY = 24 * 60 * 60 * 1000;
const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const post = (token: string | null, body?: unknown): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
type Friends = {
  friends: Array<{ username: string }>;
  incomingRequests: Array<{ id: string; from: { username: string } }>;
  outgoingRequests: Array<{ id: string; to: { username: string } }>;
  pendingIncomingCount: number;
};
const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;

async function world() {
  const w = createTestWorld({ defaultShoreCapacity: 20 });
  const app = createApp(w.ctx);
  return {
    w,
    app,
    ada: await loginAs(app, 'ada'),
    bo: await loginAs(app, 'bo'),
    cy: await loginAs(app, 'cy'),
    dee: await loginAs(app, 'dee'),
  };
}

const friendsOf = async (app: ReturnType<typeof createApp>, token: string) =>
  (await (await app.request('/api/friends', bearer(token))).json()) as Friends;

describe('friend requests over HTTP', () => {
  it('a request back to someone who already asked is mutual approval: friends at once, no notice', async () => {
    const { w, app, ada, dee } = await world();
    // Seeded: dee -> ada pending.
    expect((await friendsOf(app, ada.token)).incomingRequests.map((r) => r.from.username)).toEqual([
      'dee',
    ]);
    const notificationsBefore = w.db.select().from(t.notifications).all();

    const res = await app.request('/api/friends/requests', post(ada.token, { username: 'dee' }));
    expect(res.status).toBe(204);

    const adaView = await friendsOf(app, ada.token);
    expect(adaView.friends.map((f) => f.username)).toContain('dee');
    expect(adaView.incomingRequests).toEqual([]);
    expect(adaView.pendingIncomingCount).toBe(0);
    const deeView = await friendsOf(app, dee.token);
    expect(deeView.friends.map((f) => f.username)).toEqual(['ada']);
    expect(deeView.outgoingRequests).toEqual([]);
    // One row, now accepted — not a second request.
    const rows = w.db
      .select()
      .from(t.friendships)
      .all()
      .filter((f) => [f.userLowId, f.userHighId].includes(dee.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('accepted');
    expect(rows[0]!.acceptedAt).toBe(w.clock.now());
    // The shortcut sends no notification to either side (current behaviour, audit QA-017).
    expect(w.db.select().from(t.notifications).all()).toEqual(notificationsBefore);
  });

  it('refuses a request to oneself (400), to a friend (409), a duplicate (409) and a stranger (404)', async () => {
    const { app, ada, dee } = await world();
    const self = await app.request('/api/friends/requests', post(ada.token, { username: 'ada' }));
    expect(self.status).toBe(400);
    expect(await errorCode(self)).toBe('self_request');
    // Usernames are matched case-insensitively, so this is still oneself.
    const selfUpper = await app.request(
      '/api/friends/requests',
      post(ada.token, { username: 'ADA' }),
    );
    expect(selfUpper.status).toBe(400);

    const friends = await app.request('/api/friends/requests', post(ada.token, { username: 'bo' }));
    expect(friends.status).toBe(409);
    expect(await errorCode(friends)).toBe('already_friends');

    // Dee's request to Ada is already pending: asking again is refused, the row is unchanged.
    const pending = await app.request(
      '/api/friends/requests',
      post(dee.token, { username: 'ada' }),
    );
    expect(pending.status).toBe(409);
    expect(await errorCode(pending)).toBe('request_pending');
    expect((await friendsOf(app, ada.token)).pendingIncomingCount).toBe(1);

    const stranger = await app.request(
      '/api/friends/requests',
      post(ada.token, { username: 'nobody_here' }),
    );
    expect(stranger.status).toBe(404);
    expect(
      (await app.request('/api/friends/requests', post(null, { username: 'bo' }))).status,
    ).toBe(401);
    const invalid = await app.request('/api/friends/requests', post(ada.token, {}));
    expect(invalid.status).toBe(400);
    expect(await errorCode(invalid)).toBe('validation');
  });
});

describe('POST /api/friends/blocks', () => {
  it('blocks through the route: idempotent, hides the pair both ways and stops requests and letters', async () => {
    const { w, app, ada, bo } = await world();
    expect((await app.request('/api/friends/blocks', post(null, { username: 'bo' }))).status).toBe(
      401,
    );
    const self = await app.request('/api/friends/blocks', post(ada.token, { username: 'ada' }));
    expect(self.status).toBe(400);
    expect(await errorCode(self)).toBe('self_block');
    expect(
      (await app.request('/api/friends/blocks', post(ada.token, { username: 'nobody_here' })))
        .status,
    ).toBe(404);
    const invalid = await app.request('/api/friends/blocks', post(ada.token, { name: 'bo' }));
    expect(invalid.status).toBe(400);

    const block = await app.request('/api/friends/blocks', post(ada.token, { username: 'bo' }));
    expect(block.status).toBe(204);
    expect(await block.text()).toBe('');
    // Idempotent: blocking again is a no-op, one row.
    expect(
      (await app.request('/api/friends/blocks', post(ada.token, { username: 'BO' }))).status,
    ).toBe(204);
    expect(w.db.select().from(t.blocks).where(eq(t.blocks.blockerId, ada.id)).all()).toHaveLength(
      1,
    );

    // Each is gone from the other's friends list.
    expect((await friendsOf(app, ada.token)).friends.map((f) => f.username)).not.toContain('bo');
    expect((await friendsOf(app, bo.token)).friends.map((f) => f.username)).not.toContain('ada');
    // A request from the blocked side reads as "no such user".
    expect(
      (await app.request('/api/friends/requests', post(bo.token, { username: 'ada' }))).status,
    ).toBe(404);
    // No letters either way.
    for (const [from, to] of [
      [ada, bo],
      [bo, ada],
    ] as const) {
      const rel = await app.request(
        '/api/bottles/release',
        post(from.token, releaseInput(to.id, `block-http-${from.id.slice(-6)}`)),
      );
      expect(rel.status).toBe(422);
      expect(
        ((await rel.json()) as { error: { details: { rejection: string } } }).error.details
          .rejection,
      ).toBe('recipient_unavailable');
    }
  });

  it('a block by the sender after release ends the journey at arrival without delivering', async () => {
    const { w, app, ada, cy } = await world();
    const rel = await app.request(
      '/api/bottles/release',
      post(ada.token, releaseInput(cy.id, 'block-after-0001')),
    );
    expect(rel.status).toBe(201);
    const { bottle } = (await rel.json()) as { bottle: { id: string } };

    expect(
      (await app.request('/api/friends/blocks', post(ada.token, { username: 'cy' }))).status,
    ).toBe(204);
    w.clock.advance(60 * DAY);
    // The refused arrival is reported as a cancellation, never as a delivery.
    expect(runJourneyTick(w.ctx)).toMatchObject({ delivered: 0, cancelled: 1 });

    const row = w.db.select().from(t.bottles).where(eq(t.bottles.id, bottle.id)).get()!;
    expect(row.state).toBe('cancelled');
    expect(row.deliveredAt).toBeNull();
    // Nothing reached Cy: no bottle on the shore, no arrival notice.
    const shore = (await (await app.request('/api/shore', bearer(cy.token))).json()) as {
      bottles: unknown[];
    };
    expect(shore.bottles).toEqual([]);
    const cyNotices = (await (
      await app.request('/api/notifications', bearer(cy.token))
    ).json()) as { notifications: Array<{ bottleId: string | null }> };
    expect(cyNotices.notifications.filter((n) => n.bottleId === bottle.id)).toEqual([]);
    // Ada is told, non-disclosingly, that delivery is unavailable.
    const adaNotices = (await (
      await app.request('/api/notifications', bearer(ada.token))
    ).json()) as { notifications: Array<{ bottleId: string | null; kind: string }> };
    expect(
      adaNotices.notifications.filter((n) => n.bottleId === bottle.id).map((n) => n.kind),
    ).toEqual(['sent_cancelled']);
  });
});
