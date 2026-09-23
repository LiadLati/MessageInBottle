import { and, eq, lte, max, or } from 'drizzle-orm';
import { canTransition, type BottleState, type JourneyEventType } from '@mib/shared';
import type { DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';
import { deriveAgingProfile } from '../domain/aging.js';
import { plannedArrivalAt } from '../domain/routing.js';
import { newId } from '../lib/ids.js';
import type { AppContext } from './context.js';
import { enqueueNotification } from './notifications.js';
import { expirePublicListings, processRiskDecisions } from './risk.js';

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
    return commitArrival(tx, bottle, plan, arrivalAt, now);
  });
}

// The arrival transaction proper. Used by the worker when a journey's time is up and by the
// release of a same-harbour bottle, which arrives the moment it is released (spec §6.3 as
// amended): the same state change, slot handling, history and the same two notifications.
export function commitArrival(
  tx: DbOrTx,
  bottle: typeof t.bottles.$inferSelect,
  plan: { plannedDurationMs: number },
  arrivalAt: number,
  now: number,
): boolean {
  const bottleId = bottle.id;
  // Re-check eligibility transactionally before arrival (spec §11 invariant 4): a block placed
  // by either person during the journey, or a recipient whose account no longer exists, ends it
  // here with the same non-disclosing "delivery unavailable" (audit ARCH-014 / QA-005).
  const blocked = tx
    .select({ blockerId: t.blocks.blockerId })
    .from(t.blocks)
    .where(
      or(
        and(eq(t.blocks.blockerId, bottle.recipientId), eq(t.blocks.blockedId, bottle.senderId)),
        and(eq(t.blocks.blockerId, bottle.senderId), eq(t.blocks.blockedId, bottle.recipientId)),
      ),
    )
    .get();
  const recipient = tx
    .select({ status: t.users.status })
    .from(t.users)
    .where(eq(t.users.id, bottle.recipientId))
    .get();
  if (blocked || recipient?.status !== 'active') {
    const moved = transitionBottle(tx, bottle, 'cancelled', { completedAt: now });
    if (!moved) return false;
    releaseCapacityOnce(tx, bottleId, now);
    appendEvent(tx, bottleId, 'cancelled', now, { reason: 'delivery_unavailable' });
    enqueueNotification(tx, {
      userId: bottle.senderId,
      type: 'journey_event',
      kind: 'sent_cancelled',
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
  // The recipient learns about the bottle only now, after the committed arrival (spec §14);
  // the sender is told separately. Two events, two accounts, one row each.
  enqueueNotification(tx, {
    userId: bottle.recipientId,
    type: 'bottle_arrived',
    kind: 'received_arrived',
    bottleId,
    dedupeKey: `arrived:${bottleId}`,
    message: 'A new bottle has arrived at your shore.',
    now,
  });
  enqueueNotification(tx, {
    userId: bottle.senderId,
    type: 'journey_event',
    kind: 'sent_arrived',
    bottleId,
    dedupeKey: `sent_arrived:${bottleId}`,
    message: `The bottle you sent to ${recipientName(bottle)} reached its destination.`,
    now,
  });
  return true;
}

// The recipient's name as the sender already knows it; a natural fallback if it is missing.
export function recipientName(bottle: { recipientNameSnapshot: string }): string {
  return bottle.recipientNameSnapshot.trim() || 'your friend';
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

// Worker tick: deterministic catch-up from persisted plans; safe to run repeatedly or after
// downtime. Order matters and is fixed: risk decisions first (a storm that struck before an
// arrival that is also due must be applied first), then arrivals, then public-listing expiry.
export function runJourneyTick(ctx: AppContext): {
  delivered: number;
  // Arrivals refused at the shore (a block or an inactive recipient): the journey ended
  // without a delivery, and is not counted as one.
  cancelled: number;
  risk: { decided: number; lost: number };
  expired: number;
} {
  const now = ctx.clock.now();
  const risk = processRiskDecisions(ctx, now);
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
  let cancelled = 0;
  for (const { bottleId } of due) {
    if (!commitArrivalIfDue(ctx, bottleId, now)) continue;
    const state = ctx.db
      .select({ state: t.bottles.state })
      .from(t.bottles)
      .where(eq(t.bottles.id, bottleId))
      .get()?.state;
    if (state === 'delivered') delivered++;
    else cancelled++;
  }
  const expired = expirePublicListings(ctx, now);
  return { delivered, cancelled, risk, expired };
}
