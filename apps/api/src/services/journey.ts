import { and, eq, lte, max } from 'drizzle-orm';
import { canTransition, type BottleState, type JourneyEventType } from '@mib/shared';
import type { DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';
import { deriveAgingProfile } from '../domain/aging.js';
import { plannedArrivalAt } from '../domain/routing.js';
import { newId } from '../lib/ids.js';
import type { AppContext } from './context.js';
import { enqueueNotification } from './notifications.js';

export function activePlan(db: DbOrTx, bottleId: string) {
  return db
    .select()
    .from(t.routePlans)
    .where(and(eq(t.routePlans.bottleId, bottleId), eq(t.routePlans.active, true)))
    .get();
}

export function appendEvent(
  db: DbOrTx,
  bottleId: string,
  type: JourneyEventType,
  occurredAt: number,
  payload: Record<string, unknown>,
): number {
  const row = db
    .select({ seq: max(t.journeyEvents.seq) })
    .from(t.journeyEvents)
    .where(eq(t.journeyEvents.bottleId, bottleId))
    .get();
  const seq = (row?.seq ?? 0) + 1;
  db.insert(t.journeyEvents)
    .values({ id: newId('evt'), bottleId, seq, type, occurredAt, payload })
    .run();
  return seq;
}

// Optimistic transition: succeeds only if the row is still at (state, version). Returns false
// when a concurrent worker or request already moved it (spec §11 invariant 2 & 6).
export function transitionBottle(
  db: DbOrTx,
  bottle: { id: string; state: string; version: number },
  to: BottleState,
  patch: Partial<typeof t.bottles.$inferInsert>,
): boolean {
  if (!canTransition(bottle.state as BottleState, to)) return false;
  const res = db
    .update(t.bottles)
    .set({ ...patch, state: to, version: bottle.version + 1 })
    .where(
      and(
        eq(t.bottles.id, bottle.id),
        eq(t.bottles.state, bottle.state),
        eq(t.bottles.version, bottle.version),
      ),
    )
    .run();
  return res.changes === 1;
}

// Commits arrival for one bottle if its planned arrival time has passed. Idempotent: a bottle
// already delivered (or otherwise moved on) is left untouched.
export function commitArrivalIfDue(ctx: AppContext, bottleId: string, now: number): boolean {
  return ctx.db.transaction((tx) => {
    const bottle = tx.select().from(t.bottles).where(eq(t.bottles.id, bottleId)).get();
    if (!bottle || bottle.state !== 'at_sea') return false;
    const plan = activePlan(tx, bottleId);
    if (!plan) return false;
    const arrivalAt = plannedArrivalAt(plan);
    if (arrivalAt > now) return false;
    // Re-check eligibility transactionally before arrival (spec §11 invariant 4).
    const blocked = tx
      .select({ blockerId: t.blocks.blockerId })
      .from(t.blocks)
      .where(
        and(eq(t.blocks.blockerId, bottle.recipientId), eq(t.blocks.blockedId, bottle.senderId)),
      )
      .get();
    if (blocked) {
      const moved = transitionBottle(tx, bottle, 'cancelled', { completedAt: now });
      if (!moved) return false;
      releaseCapacityOnce(tx, bottleId, now);
      appendEvent(tx, bottleId, 'cancelled', now, { reason: 'delivery_unavailable' });
      enqueueNotification(tx, {
        userId: bottle.senderId,
        type: 'journey_event',
        bottleId,
        dedupeKey: `cancelled:${bottleId}`,
        message: 'Delivery unavailable. The journey has ended.',
        now,
      });
      return true;
    }
    const aging = deriveAgingProfile({
      bottleId,
      releasedAt: bottle.releasedAt,
      deliveredAt: arrivalAt,
      plannedDurationMs: plan.plannedDurationMs,
    });
    const moved = transitionBottle(tx, bottle, 'delivered', {
      deliveredAt: arrivalAt,
      agingProfile: aging,
    });
    if (!moved) return false;
    appendEvent(tx, bottleId, 'delivered', arrivalAt, { shoreId: bottle.destinationShoreId });
    // The recipient learns about the bottle only now, after the committed arrival (spec §14).
    enqueueNotification(tx, {
      userId: bottle.recipientId,
      type: 'bottle_arrived',
      bottleId,
      dedupeKey: `arrived:${bottleId}`,
      message: `A bottle from ${bottle.senderNameSnapshot} has washed up on your shore.`,
      now,
    });
    return true;
  });
}

export function releaseCapacityOnce(db: DbOrTx, bottleId: string, now: number): boolean {
  const res = db
    .update(t.capacityReservations)
    .set({ status: 'released', releasedAt: now })
    .where(
      and(eq(t.capacityReservations.bottleId, bottleId), eq(t.capacityReservations.status, 'held')),
    )
    .run();
  return res.changes === 1;
}

// Worker tick: deterministic catch-up from persisted plans; safe to run repeatedly or after downtime.
export function runJourneyTick(ctx: AppContext): { delivered: number } {
  const now = ctx.clock.now();
  const due = ctx.db
    .select({ bottleId: t.routePlans.bottleId })
    .from(t.routePlans)
    .innerJoin(t.bottles, eq(t.bottles.id, t.routePlans.bottleId))
    .where(
      and(
        eq(t.routePlans.active, true),
        eq(t.bottles.state, 'at_sea'),
        lte(t.routePlans.startsAt, now),
      ),
    )
    .all();
  let delivered = 0;
  for (const { bottleId } of due) if (commitArrivalIfDue(ctx, bottleId, now)) delivered++;
  return { delivered };
}
