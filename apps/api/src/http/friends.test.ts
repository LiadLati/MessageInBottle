import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import * as t from '../db/schema.js';
import { createTestWorld, loginAs, releaseInput } from '../test/harness.js';

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const post = (token: string, body?: unknown): RequestInit => ({
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
type Friends = {
  incomingRequests: Array<{ id: string }>;
  friends: unknown[];
  pendingIncomingCount: number;
};

describe('friend requests: pending count and denial', () => {
  it('counts only pending incoming requests and denies atomically and idempotently', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const ada = await loginAs(app, 'ada');
    const dee = await loginAs(app, 'dee');
    const bo = await loginAs(app, 'bo');
    // An in-flight bottle between ada and bo must be untouched by anything below.
    const rel = await app.request(
      '/api/bottles/release',
      post(ada.token, releaseInput(bo.id, 'friends-key-001')),
    );
    expect(rel.status).toBe(201);
    const bottlesBefore = w.db.select().from(t.bottles).all();
    const plansBefore = w.db.select().from(t.routePlans).all();

    // Seeded: dee → ada pending. Ada sees 1, dee (the requester) sees 0.
    const adaView = (await (
      await app.request('/api/friends', bearer(ada.token))
    ).json()) as Friends;
    expect(adaView.pendingIncomingCount).toBe(1);
    expect(adaView.incomingRequests).toHaveLength(1);
    const deeView = (await (
      await app.request('/api/friends', bearer(dee.token))
    ).json()) as Friends;
    expect(deeView.pendingIncomingCount).toBe(0);
    const reqId = adaView.incomingRequests[0]!.id;

    // The requester cannot deny their own request; the row stays.
    expect((await app.request(`/api/friends/requests/${reqId}/deny`, post(dee.token))).status).toBe(
      204,
    );
    expect(
      w.db.select().from(t.friendships).where(eq(t.friendships.id, reqId)).get(),
    ).toBeDefined();
    // A third party cannot either.
    expect((await app.request(`/api/friends/requests/${reqId}/deny`, post(bo.token))).status).toBe(
      204,
    );
    expect(
      w.db.select().from(t.friendships).where(eq(t.friendships.id, reqId)).get(),
    ).toBeDefined();

    // The addressee denies: the request is gone, no friendship exists, the count drops to 0.
    expect((await app.request(`/api/friends/requests/${reqId}/deny`, post(ada.token))).status).toBe(
      204,
    );
    expect(
      w.db.select().from(t.friendships).where(eq(t.friendships.id, reqId)).get(),
    ).toBeUndefined();
    const after = (await (await app.request('/api/friends', bearer(ada.token))).json()) as Friends;
    expect(after.pendingIncomingCount).toBe(0);
    expect(after.friends).toHaveLength(2);
    // Idempotent: denying again, or accepting afterwards, changes nothing.
    expect((await app.request(`/api/friends/requests/${reqId}/deny`, post(ada.token))).status).toBe(
      204,
    );
    expect(
      (await app.request(`/api/friends/requests/${reqId}/accept`, post(ada.token))).status,
    ).toBe(404);
    // Dee can ask again later.
    expect(
      (await app.request('/api/friends/requests', post(dee.token, { username: 'ada' }))).status,
    ).toBe(204);
    expect(
      ((await (await app.request('/api/friends', bearer(ada.token))).json()) as Friends)
        .pendingIncomingCount,
    ).toBe(1);

    // Accepted friendships are never deleted by the deny endpoint.
    const accepted = w.db
      .select()
      .from(t.friendships)
      .where(eq(t.friendships.status, 'accepted'))
      .all();
    for (const f of accepted) {
      await app.request(`/api/friends/requests/${f.id}/deny`, post(ada.token));
      expect(
        w.db.select().from(t.friendships).where(eq(t.friendships.id, f.id)).get()!.status,
      ).toBe('accepted');
    }
    expect(w.db.select().from(t.bottles).all()).toEqual(bottlesBefore);
    expect(w.db.select().from(t.routePlans).all()).toEqual(plansBefore);
  });
});
