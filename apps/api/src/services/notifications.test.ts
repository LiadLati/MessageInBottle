import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import * as t from '../db/schema.js';
import { getSentBottle } from './bottles.js';
import { commitArrivalIfDue } from './journey.js';
import { enqueueNotification, listNotifications, markAllRead } from './notifications.js';
import { commitLoss, markOutcomeSeen } from './outcomes.js';
import { releaseBottle } from './release.js';
import { createTestWorld, releaseInput, type TestWorld } from '../test/harness.js';

describe('notifications inbox', () => {
  let w: TestWorld;
  const ada = () => w.user('ada');
  const bo = () => w.user('bo');
  beforeEach(() => {
    w = createTestWorld();
  });

  it('records the four events with their kinds, newest first, one row per event per account', () => {
    const adrift = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000001')).bottleId;
    const sunk = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000002')).bottleId;
    const arrives = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000003')).bottleId;
    w.clock.advance(1000);
    commitLoss(w.ctx, adrift, 'adrift', w.clock.now());
    w.clock.advance(1000);
    commitLoss(w.ctx, sunk, 'sunk', w.clock.now());
    const plan = w.db.select().from(t.routePlans).where(eq(t.routePlans.bottleId, arrives)).get()!;
    w.clock.set(plan.startsAt + plan.plannedDurationMs);
    commitArrivalIfDue(w.ctx, arrives, w.clock.now());
    // Retries of every path: nothing is duplicated.
    commitLoss(w.ctx, adrift, 'adrift', w.clock.now());
    commitLoss(w.ctx, sunk, 'sunk', w.clock.now());
    commitArrivalIfDue(w.ctx, arrives, w.clock.now());

    const sender = listNotifications(w.ctx, ada().id);
    expect(sender.map((n) => n.kind)).toEqual(['sent_arrived', 'sent_sunk', 'sent_adrift']);
    expect(sender.map((n) => n.message)).toEqual([
      'The bottle you sent to Bo reached its destination.',
      'The bottle you sent to Bo sank at sea.',
      'The bottle you sent to Bo was lost at sea and drifted into the public ocean.',
    ]);
    expect(sender.every((n) => n.readAt === null)).toBe(true);
    const recipient = listNotifications(w.ctx, bo().id);
    expect(recipient.map((n) => n.kind)).toEqual(['received_arrived']);
    expect(recipient[0]!.message).toBe('A new bottle has arrived at your shore.');
  });

  it('marks everything read, persistently, without touching any bottle or marker', () => {
    const sunk = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000004')).bottleId;
    commitLoss(w.ctx, sunk, 'sunk', w.clock.now());
    w.clock.advance(5000);
    markAllRead(w.ctx, ada().id);
    const after = listNotifications(w.ctx, ada().id);
    expect(after).toHaveLength(1);
    expect(after[0]!.readAt).toBe(new Date(w.clock.now()).toISOString());
    // Reading the inbox is not seeing the marker: the sunk bottle is still unseen on the map.
    const bottle = getSentBottle(w.ctx, ada(), sunk);
    expect(bottle.visibility).toEqual({ seenAt: null, acknowledgedAt: null });
    expect(bottle.state).toBe('lost');
    // And seeing the marker later does not re-open the notification.
    markOutcomeSeen(w.ctx, ada(), sunk);
    expect(listNotifications(w.ctx, ada().id)[0]!.readAt).not.toBeNull();
  });

  it('classifies rows written before kinds existed from their dedupe key', () => {
    const lost = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000005')).bottleId;
    commitLoss(w.ctx, lost, 'sunk', w.clock.now());
    // Simulate legacy rows: no kind stored.
    w.db.update(t.notifications).set({ kind: null }).run();
    enqueueNotification(w.db, {
      userId: ada().id,
      type: 'bottle_arrived',
      kind: 'received_arrived',
      bottleId: null,
      dedupeKey: 'arrived:legacy',
      message: 'legacy',
      now: w.clock.now() + 1,
    });
    w.db.update(t.notifications).set({ kind: null }).run();
    const kinds = listNotifications(w.ctx, ada().id).map((n) => [n.kind]);
    expect(kinds).toEqual([['received_arrived'], ['sent_sunk']]);
  });
});
