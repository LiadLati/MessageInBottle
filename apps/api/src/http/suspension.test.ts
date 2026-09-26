import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { FriendsResponse } from '@mib/shared';
import * as t from '../db/schema.js';
import { createApp } from './app.js';
import { decideCase, decideCaseCritical } from '../services/admin.js';
import type { AuthUser } from '../services/context.js';
import { openBottle } from '../services/bottles.js';
import { commitArrivalIfDue } from '../services/journey.js';
import { reportLetter, SUSPENSION_MS } from '../services/moderation.js';
import { heldForRecipient, releaseBottle } from '../services/release.js';
import { createTestWorld, loginAs, releaseInput, type TestWorld } from '../test/harness.js';

// Product decision 14: a suspended account is unavailable across the product for exactly the
// suspension, then returns by itself; a banned one does not return. Senders learn only
// "Delivery unavailable"; the account learns nothing of letters that could not reach it.

const DAY = 24 * 60 * 60 * 1000;
let n = 0;
const key = () => `susp-key-${String(++n).padStart(8, '0')}`;

function world() {
  const w = createTestWorld({ defaultShoreCapacity: 40 });
  w.db
    .update(t.users)
    .set({ role: 'admin' })
    .where(eq(t.users.id, w.user('cy').id))
    .run();
  w.db
    .update(t.users)
    .set({ shoreId: 'shore_gull_hollow' })
    .where(eq(t.users.id, w.user('dee').id))
    .run();
  // Dee and Bo are friends too.
  const [low, high] = [w.user('dee').id, w.user('bo').id].sort();
  w.db
    .insert(t.friendships)
    .values({
      id: 'frd_dee_bo',
      userLowId: low!,
      userHighId: high!,
      status: 'accepted',
      requestedById: w.user('dee').id,
      createdAt: 0,
      acceptedAt: 0,
    })
    .onConflictDoNothing()
    .run();
  return w;
}
const admin = (w: TestWorld): AuthUser => ({ ...w.user('cy'), role: 'admin' });

// A letter from `from` that `to` opened and reported.
function reported(w: TestWorld, from: string, to: string): string {
  const id = releaseBottle(w.ctx, w.user(from), releaseInput(w.user(to).id, key())).bottleId;
  w.clock.advance(60 * DAY);
  commitArrivalIfDue(w.ctx, id, w.clock.now());
  openBottle(w.ctx, w.user(to), id);
  return reportLetter(w.ctx, w.user(to), { bottleId: id, reason: 'harassment', hide: false })
    .caseId;
}
const friendsOf = async (app: ReturnType<typeof createApp>, token: string) =>
  (await (
    await app.request('/api/friends', { headers: { authorization: `Bearer ${token}` } })
  ).json()) as FriendsResponse;

describe('a temporarily suspended account (product decision 14)', () => {
  it('is hidden, cancels journeys to it once, and comes back when the suspension ends', async () => {
    const w = world();
    const app = createApp(w.ctx);
    // A letter from Dee is on its way to Bo when Bo is suspended.
    decideCase(w.ctx, admin(w), reported(w, 'bo', 'ada'), 'accepted', 'harassment');
    const inFlight = releaseBottle(
      w.ctx,
      w.user('dee'),
      releaseInput(w.user('bo').id, key()),
    ).bottleId;
    expect(heldForRecipient(w.db, w.user('bo').id)).toBe(1);
    decideCase(w.ctx, admin(w), reported(w, 'bo', 'ada'), 'accepted', 'harassment');

    // The journey ended at once, its place released once, the sender told generically.
    const b = w.db.select().from(t.bottles).where(eq(t.bottles.id, inFlight)).get()!;
    expect(b.state).toBe('cancelled');
    expect(heldForRecipient(w.db, w.user('bo').id)).toBe(0);
    const reservations = w.db
      .select()
      .from(t.capacityReservations)
      .where(eq(t.capacityReservations.bottleId, inFlight))
      .all();
    expect(reservations.map((r) => r.status)).toEqual(['released']);
    const deeNotes = w.db
      .select()
      .from(t.notifications)
      .where(
        and(eq(t.notifications.userId, w.user('dee').id), eq(t.notifications.bottleId, inFlight)),
      )
      .all();
    expect(deeNotes.map((x) => x.message)).toEqual([
      'Delivery unavailable. The journey has ended.',
    ]);
    expect(JSON.stringify(deeNotes)).not.toMatch(/suspend/i);
    const boArrivals = w.db
      .select()
      .from(t.notifications)
      .where(
        and(eq(t.notifications.userId, w.user('bo').id), eq(t.notifications.bottleId, inFlight)),
      )
      .all();
    expect(boArrivals).toEqual([]);

    // Hidden from friend lists and search; the friendship itself is kept.
    const dee = await loginAs(app, 'dee');
    expect((await friendsOf(app, dee.token)).friends.map((f) => f.username)).not.toContain('bo');
    const search = await app.request('/api/friends/requests', {
      method: 'POST',
      headers: { authorization: `Bearer ${dee.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'bo' }),
    });
    expect(search.status).toBe(404);
    const pair = w.db
      .select()
      .from(t.friendships)
      .all()
      .filter((f) => [f.userLowId, f.userHighId].includes(w.user('bo').id));
    expect(pair.length).toBeGreaterThan(0);

    // Bo's ordinary app, inbox included, is closed; standing, appeal and support are not.
    const bo = await loginAs(app, 'bo');
    const get = (path: string, token = bo.token) =>
      app.request(path, { headers: { authorization: `Bearer ${token}` } });
    expect((await get('/api/notifications')).status).toBe(403);
    expect((await get('/api/friends')).status).toBe(403);
    expect((await get('/api/moderation/standing')).status).toBe(200);
    expect((await get('/support')).status).toBe(200);

    // The suspension ends on server time; everything returns without anyone acting.
    w.realClock.advance(SUSPENSION_MS);
    const dee2 = await loginAs(app, 'dee');
    expect((await friendsOf(app, dee2.token)).friends.map((f) => f.username)).toContain('bo');
    const bo2 = await loginAs(app, 'bo');
    expect((await get('/api/notifications', bo2.token)).status).toBe(200);
    expect(() =>
      releaseBottle(w.ctx, w.user('dee'), releaseInput(w.user('bo').id, key())),
    ).not.toThrow();
  });
});

describe('a permanently banned account (product decision 14)', () => {
  it('stays unavailable and locked, with no route back', async () => {
    const w = world();
    const app = createApp(w.ctx);
    const caseId = reported(w, 'bo', 'ada');
    decideCaseCritical(w.ctx, admin(w), caseId, 'grooming, confirmed');
    w.realClock.advance(365 * DAY);
    const bo = await loginAs(app, 'bo');
    const get = (path: string) =>
      app.request(path, { headers: { authorization: `Bearer ${bo.token}` } });
    expect((await get('/api/notifications')).status).toBe(403);
    expect((await get('/api/shore')).status).toBe(403);
    const standing = (await (await get('/api/moderation/standing')).json()) as {
      standing: string;
      suspendedUntil: string | null;
    };
    expect(standing).toMatchObject({ standing: 'banned', suspendedUntil: null });
    const ada = await loginAs(app, 'ada');
    expect((await friendsOf(app, ada.token)).friends.map((f) => f.username)).not.toContain('bo');
  });
});
