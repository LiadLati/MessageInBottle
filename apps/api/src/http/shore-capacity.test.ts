import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { SHORE_CAPACITY } from '@mib/shared';
import * as t from '../db/schema.js';
import { createApp } from './app.js';
import { decideCase } from '../services/admin.js';
import { openBottle } from '../services/bottles.js';
import { commitArrivalIfDue } from '../services/journey.js';
import { reportLetter } from '../services/moderation.js';
import { heldForRecipient, releaseBottle } from '../services/release.js';
import { createTestWorld, loginAs, releaseInput, type TestWorld } from '../test/harness.js';

// Product decision 8: every account's shore holds 100 bottles at once — on their way to it or
// delivered but not yet opened — enforced transactionally, with one "full" notice per episode.

const DAY = 24 * 60 * 60 * 1000;
const world = () => createTestWorld({ shoreCapacity: SHORE_CAPACITY });
const fullNotices = (w: TestWorld) =>
  w.db
    .select()
    .from(t.notifications)
    .where(and(eq(t.notifications.userId, w.user('bo').id), eq(t.notifications.kind, 'shore_full')))
    .all();

describe('shore capacity: 100 per account (product decision 8)', () => {
  it('is 100 by default in the real configuration', async () => {
    const { loadConfig } = await import('../config.js');
    expect(loadConfig({}).shoreCapacity).toBe(100);
    expect(SHORE_CAPACITY).toBe(100);
  });

  it('never over-commits under concurrent releases, and refuses without creating a journey', async () => {
    const w = world();
    const app = createApp(w.ctx);
    const ada = await loginAs(app, 'ada');
    const release = (i: number) =>
      app.request('/api/bottles/release', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ada.token}` },
        body: JSON.stringify(
          releaseInput(w.user('bo').id, `capacity-key-${String(i).padStart(6, '0')}`),
        ),
      });
    const results = await Promise.all(
      Array.from({ length: 110 }, (_, i) => Promise.resolve(release(i))),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(100);
    expect(statuses.filter((s) => s === 422)).toHaveLength(10);
    const refused = await results.find((r) => r.status === 422)!.json();
    expect(refused).toMatchObject({ error: { details: { rejection: 'shore_full' } } });
    // Privacy-safe: nothing about who else wrote or how many.
    expect(JSON.stringify(refused)).not.toMatch(/100|bottles|ada|cy|dee/i);
    expect(heldForRecipient(w.db, w.user('bo').id)).toBe(100);
    // No hidden queue: a refused release leaves no bottle, letter or journey behind.
    expect(w.db.select().from(t.bottles).all()).toHaveLength(100);
    expect(w.db.select().from(t.letters).all()).toHaveLength(100);
  });

  it('counts delivered but unopened bottles, and frees a place when one is opened', () => {
    const w = createTestWorld({ shoreCapacity: 2 });
    const a = releaseBottle(w.ctx, w.user('ada'), releaseInput(w.user('bo').id, 'cap-key-00001'));
    releaseBottle(w.ctx, w.user('ada'), releaseInput(w.user('bo').id, 'cap-key-00002'));
    w.clock.advance(60 * DAY);
    commitArrivalIfDue(w.ctx, a.bottleId, w.clock.now());
    // Delivered but unread still takes its place.
    expect(heldForRecipient(w.db, w.user('bo').id)).toBe(2);
    expect(() =>
      releaseBottle(w.ctx, w.user('dee'), releaseInput(w.user('bo').id, 'cap-key-00003')),
    ).toThrow();
    openBottle(w.ctx, w.user('bo'), a.bottleId);
    expect(heldForRecipient(w.db, w.user('bo').id)).toBe(1);
  });

  it('tells the owner once per full episode, and again only after dropping below and refilling', () => {
    const w = createTestWorld({ shoreCapacity: 2 });
    const ids: string[] = [];
    const send = (k: number) =>
      releaseBottle(w.ctx, w.user('ada'), releaseInput(w.user('bo').id, `ep-key-${k}-000`));
    ids.push(send(1).bottleId);
    expect(fullNotices(w)).toHaveLength(0);
    ids.push(send(2).bottleId);
    expect(fullNotices(w)).toHaveLength(1);
    expect(fullNotices(w)[0]!.message).toMatch(/full/);
    // Further attempts while full write nothing new.
    for (let k = 3; k < 6; k++) expect(() => send(k)).toThrow();
    expect(fullNotices(w)).toHaveLength(1);
    // Below full, then full again: a second episode.
    w.clock.advance(60 * DAY);
    commitArrivalIfDue(w.ctx, ids[0]!, w.clock.now());
    openBottle(w.ctx, w.user('bo'), ids[0]!);
    w.realClock.advance(1);
    send(7);
    expect(fullNotices(w)).toHaveLength(2);
  });

  it('never releases a place twice when an upheld report withdraws a letter', () => {
    const w = createTestWorld({ shoreCapacity: 5 });
    w.db
      .update(t.users)
      .set({ role: 'admin' })
      .where(eq(t.users.id, w.user('cy').id))
      .run();
    const { bottleId } = releaseBottle(
      w.ctx,
      w.user('ada'),
      releaseInput(w.user('bo').id, 'withdraw-000001'),
    );
    w.clock.advance(60 * DAY);
    commitArrivalIfDue(w.ctx, bottleId, w.clock.now());
    openBottle(w.ctx, w.user('bo'), bottleId);
    const other = releaseBottle(
      w.ctx,
      w.user('ada'),
      releaseInput(w.user('bo').id, 'withdraw-000002'),
    ).bottleId;
    w.clock.advance(60 * DAY);
    commitArrivalIfDue(w.ctx, other, w.clock.now());
    // `other` is delivered and unread: it holds a place until something ends it.
    expect(heldForRecipient(w.db, w.user('bo').id)).toBe(1);
    const caseId = reportLetter(w.ctx, w.user('bo'), {
      bottleId,
      reason: 'spam',
      hide: false,
    }).caseId;
    decideCase(w.ctx, { ...w.user('cy'), role: 'admin' }, caseId, 'accepted', 'spam');
    // The reported letter was already opened (its place already free); nothing double-counts.
    expect(heldForRecipient(w.db, w.user('bo').id)).toBe(1);
    const rows = w.db
      .select()
      .from(t.capacityReservations)
      .where(eq(t.capacityReservations.bottleId, bottleId))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('released');
  });
});
