import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import * as t from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { blockUser } from './friends.js';
import {
  ReleaseRejectedError,
  heldReservations,
  previewRelease,
  releaseBottle,
} from './release.js';
import { createTestWorld, releaseInput, type TestWorld } from '../test/harness.js';

function expectRejection(fn: () => unknown, rejection: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ReleaseRejectedError);
    expect((err as ReleaseRejectedError).rejection).toBe(rejection);
    return;
  }
  throw new Error(`expected rejection ${rejection}`);
}

describe('release eligibility (spec §5.1 step 6, §18 #1-#3)', () => {
  let w: TestWorld;
  beforeEach(() => {
    w = createTestWorld();
  });

  it('accepts a friend with a connected shore and commits everything together', () => {
    const ada = w.user('ada');
    const bo = w.user('bo');
    const out = releaseBottle(w.ctx, ada, releaseInput(bo.id));
    expect(out.replayed).toBe(false);
    const bottle = w.db.select().from(t.bottles).where(eq(t.bottles.id, out.bottleId)).get()!;
    expect(bottle.state).toBe('at_sea');
    expect(bottle.recipientId).toBe(bo.id);
    expect(bottle.originShoreName).toBe('Lantern Cove');
    expect(bottle.destinationShoreName).toBe('Driftmoor Strand');
    expect(w.db.select().from(t.routePlans).all()).toHaveLength(1);
    expect(
      w.db
        .select()
        .from(t.journeyEvents)
        .all()
        .map((e) => e.type),
    ).toEqual(['released']);
    expect(heldReservations(w.db, 'shore_driftmoor_strand')).toBe(1);
  });

  it('rejects self-send', () => {
    const ada = w.user('ada');
    expectRejection(() => releaseBottle(w.ctx, ada, releaseInput(ada.id)), 'self_send');
  });

  it('rejects non-friends and pending requests', () => {
    const ada = w.user('ada');
    const dee = w.user('dee'); // dee -> ada request is pending
    expectRejection(() => releaseBottle(w.ctx, ada, releaseInput(dee.id)), 'not_friends');
  });

  it('rejects a sender without a shore', () => {
    const dee = w.user('dee');
    const ada = w.user('ada');
    expectRejection(() => releaseBottle(w.ctx, dee, releaseInput(ada.id)), 'sender_has_no_shore');
  });

  it('rejects when the recipient has no shore', () => {
    const ada = w.user('ada');
    const cy = w.user('cy');
    w.db.update(t.users).set({ shoreId: null }).where(eq(t.users.id, cy.id)).run();
    expectRejection(() => releaseBottle(w.ctx, ada, releaseInput(cy.id)), 'recipient_has_no_shore');
  });

  it('rejects generically when the recipient blocked the sender, without disclosing the block', () => {
    const ada = w.user('ada');
    const bo = w.user('bo');
    blockUser(w.ctx, bo.id, 'ada');
    expectRejection(() => releaseBottle(w.ctx, ada, releaseInput(bo.id)), 'recipient_unavailable');
    const preview = previewRelease(w.ctx, ada, bo.id);
    expect(preview.rejection).toBe('recipient_unavailable');
    expect(JSON.stringify(preview)).not.toMatch(/block/i);
  });

  it('rejects when the destination shore is full and keeps the draft (no bottle created)', () => {
    const ada = w.user('ada');
    const bo = w.user('bo');
    w.db
      .update(t.shores)
      .set({ capacity: 1 })
      .where(eq(t.shores.id, 'shore_driftmoor_strand'))
      .run();
    releaseBottle(w.ctx, ada, releaseInput(bo.id, 'key-first-000001'));
    expectRejection(
      () => releaseBottle(w.ctx, ada, releaseInput(bo.id, 'key-second-00001')),
      'shore_full',
    );
    expect(w.db.select().from(t.bottles).all()).toHaveLength(1);
    expect(w.db.select().from(t.letters).all()).toHaveLength(1);
  });

  it('allows repeat sends to the same friend while capacity remains', () => {
    const ada = w.user('ada');
    const bo = w.user('bo');
    releaseBottle(w.ctx, ada, releaseInput(bo.id, 'key-first-000001'));
    releaseBottle(w.ctx, ada, releaseInput(bo.id, 'key-second-00001'));
    expect(w.db.select().from(t.bottles).all()).toHaveLength(2);
    expect(heldReservations(w.db, 'shore_driftmoor_strand')).toBe(2);
  });

  it('rejects when no connected sea route exists', () => {
    w.db
      .insert(t.shores)
      .values({
        id: 'shore_mirror_lagoon',
        name: 'Mirror Lagoon',
        chartX: 60,
        chartY: 300,
        capacity: 5,
        active: true,
      })
      .run();
    // A shore node with no edges: reachable by nothing, never fabricated as a straight line.
    w.db
      .insert(t.routeNodes)
      .values({
        id: 'n_shore_mirror_lagoon',
        graphVersion: 1,
        kind: 'shore',
        shoreId: 'shore_mirror_lagoon',
        chartX: 60,
        chartY: 300,
      })
      .run();
    const ada = w.user('ada');
    const bo = w.user('bo');
    w.db.update(t.users).set({ shoreId: 'shore_mirror_lagoon' }).where(eq(t.users.id, bo.id)).run();
    expectRejection(() => releaseBottle(w.ctx, ada, releaseInput(bo.id)), 'route_unavailable');
    expect(previewRelease(w.ctx, ada, bo.id).route).toBeNull();
  });

  it('rejects an over-long letter server-side regardless of client counting', () => {
    const ada = w.user('ada');
    const bo = w.user('bo');
    expectRejection(
      () => releaseBottle(w.ctx, ada, { ...releaseInput(bo.id), text: 'x'.repeat(1001) }),
      'invalid_letter',
    );
    expect(w.db.select().from(t.bottles).all()).toHaveLength(0);
  });
});

describe('release idempotency (spec §11 invariant 5, §18 #3)', () => {
  it('a retried release creates exactly one bottle and one reservation', () => {
    const w = createTestWorld();
    const ada = w.user('ada');
    const bo = w.user('bo');
    const first = releaseBottle(w.ctx, ada, releaseInput(bo.id, 'retry-key-000001'));
    const second = releaseBottle(w.ctx, ada, releaseInput(bo.id, 'retry-key-000001'));
    expect(second.replayed).toBe(true);
    expect(second.bottleId).toBe(first.bottleId);
    expect(w.db.select().from(t.bottles).all()).toHaveLength(1);
    expect(w.db.select().from(t.capacityReservations).all()).toHaveLength(1);
    expect(w.db.select().from(t.journeyEvents).all()).toHaveLength(1);
  });

  it('a reused key with a different letter is refused instead of silently replayed', () => {
    const w = createTestWorld();
    const ada = w.user('ada');
    const bo = w.user('bo');
    releaseBottle(w.ctx, ada, releaseInput(bo.id, 'retry-key-000001'));
    expect(() =>
      releaseBottle(w.ctx, ada, {
        ...releaseInput(bo.id, 'retry-key-000001'),
        text: 'a different letter',
      }),
    ).toThrowError(AppError);
    expect(w.db.select().from(t.bottles).all()).toHaveLength(1);
  });

  it('idempotency keys are scoped per user', () => {
    const w = createTestWorld();
    const ada = w.user('ada');
    const bo = w.user('bo');
    const cy = w.user('cy');
    releaseBottle(w.ctx, ada, releaseInput(bo.id, 'shared-key-00001'));
    const out = releaseBottle(w.ctx, cy, releaseInput(bo.id, 'shared-key-00001'));
    expect(out.replayed).toBe(false);
    expect(w.db.select().from(t.bottles).all()).toHaveLength(2);
  });
});
