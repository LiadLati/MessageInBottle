import { and, eq, gt, isNotNull, isNull, notExists } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';
import { plannedArrivalAt } from '../domain/routing.js';
import type { AppContext } from './context.js';
import { activePlan, appendEvent, commitArrival, releaseCapacityOnce } from './journey.js';
import { isRestricted } from './moderation.js';
import { enqueueNotification } from './notifications.js';
import { decideDueStorms } from './risk.js';
import { ensureRollsIn } from './weather.js';

// An account that cannot currently receive letters: deleted, or suspended or banned (product
// decision 14). Everywhere a recipient is checked — release, arrival, friend lists — the
// sender learns only that delivery is unavailable, never why.
export function recipientUnavailable(db: DbOrTx, userId: string, now: number): boolean {
  const row = db
    .select({ status: t.users.status })
    .from(t.users)
    .where(eq(t.users.id, userId))
    .get();
  if (!row || row.status !== 'active') return true;
  return isRestricted(db, userId, now) !== null;
}

// Ends every journey still travelling to this account, exactly as a block at arrival would:
// the bottle is cancelled, its shore place released once, and the sender told only
// "Delivery unavailable". The recipient is told nothing. Returns the number ended.
export function endInboundJourneys(tx: DbOrTx, recipientId: string, now: number): number {
  const inbound = tx
    .select({ id: t.bottles.id, version: t.bottles.version, senderId: t.bottles.senderId })
    .from(t.bottles)
    .where(and(eq(t.bottles.recipientId, recipientId), eq(t.bottles.state, 'at_sea')))
    .all();
  let ended = 0;
  for (const b of inbound) {
    const moved = tx
      .update(t.bottles)
      .set({ state: 'cancelled', version: b.version + 1, completedAt: now })
      .where(and(eq(t.bottles.id, b.id), eq(t.bottles.state, 'at_sea')))
      .run().changes;
    if (moved === 0) continue;
    ended++;
    releaseCapacityOnce(tx, b.id, now);
    appendEvent(tx, b.id, 'cancelled', now, { reason: 'delivery_unavailable' });
    enqueueNotification(tx, {
      userId: b.senderId,
      type: 'journey_event',
      kind: 'sent_cancelled',
      bottleId: b.id,
      dedupeKey: `cancelled:${b.id}`,
      message: 'Delivery unavailable. The journey has ended.',
      now,
    });
  }
  return ended;
}

// Ends what a restricted sender still has on its way to someone (audit ARCH-R-002): every bottle
// still travelling, and every adrift bottle still listed in the public ocean that no finder has
// opened. Letters already delivered or opened are never touched.
//
// First, everything that had already happened by now is settled exactly as the worker would
// settle it, so the result never depends on how far behind the worker was: storm midpoints
// already passed are decided (a storm that struck before the restriction still struck), then
// arrivals already due are committed (a letter that reached its shore before the restriction
// is delivered). Only then are the remaining journeys ended.
//
// A travelling bottle is cancelled, its shore place released once, and its history records the
// same neutral "delivery unavailable" as any refused arrival. The sender is told only that; the
// recipient, who was never told the bottle existed, is told nothing. An unopened adrift listing
// is withdrawn from the public ocean now (a listing whose 72 hours have already run out is left
// for the ordinary expiry, which records it at its deadline). Nothing is restored if the
// restriction later ends: cancelled journeys stay ended.
//
// Idempotent and transactional: runs inside the caller's transaction, and every write is guarded
// on the state it changes, so a retried decision, a repeated standing calculation or a restart
// changes nothing twice and writes no second notification.
export function endOutboundJourneys(
  ctx: AppContext,
  tx: DbOrTx,
  senderId: string,
): { settledArrivals: number; cancelled: number; listingsWithdrawn: number } {
  // Journeys, storms and listings run on the journey clock; standing on server time.
  const journeyNow = ctx.clock.now();
  const realNow = ctx.realClock.now();

  // 1. What already happened. Storms first, then arrivals — the worker's own order.
  const atRisk = tx
    .select({ id: t.bottles.id })
    .from(t.bottles)
    .where(
      and(
        eq(t.bottles.senderId, senderId),
        eq(t.bottles.state, 'at_sea'),
        isNotNull(t.bottles.riskPolicyVersion),
      ),
    )
    .get();
  if (atRisk) {
    ensureRollsIn(ctx, tx, senderId, journeyNow);
    decideDueStorms(ctx, tx, senderId, journeyNow);
  }
  let settledArrivals = 0;
  const travelling = () =>
    tx
      .select()
      .from(t.bottles)
      .where(and(eq(t.bottles.senderId, senderId), eq(t.bottles.state, 'at_sea')))
      .orderBy(t.bottles.releasedAt, t.bottles.id)
      .all();
  for (const bottle of travelling()) {
    const plan = activePlan(tx, bottle.id);
    if (!plan || plan.startsAt > journeyNow) continue;
    const arrivalAt = plannedArrivalAt(plan);
    if (arrivalAt > journeyNow) continue;
    if (commitArrival(tx, bottle, plan, arrivalAt, journeyNow, realNow)) settledArrivals++;
  }

  // 2. What is still on its way ends here.
  let cancelled = 0;
  for (const b of travelling()) {
    const moved = tx
      .update(t.bottles)
      .set({ state: 'cancelled', version: b.version + 1, completedAt: journeyNow })
      .where(and(eq(t.bottles.id, b.id), eq(t.bottles.state, 'at_sea')))
      .run().changes;
    if (moved === 0) continue;
    cancelled++;
    releaseCapacityOnce(tx, b.id, journeyNow);
    appendEvent(tx, b.id, 'cancelled', journeyNow, { reason: 'delivery_unavailable' });
    enqueueNotification(tx, {
      userId: b.senderId,
      type: 'journey_event',
      kind: 'sent_cancelled',
      bottleId: b.id,
      dedupeKey: `cancelled:${b.id}`,
      message: 'Delivery unavailable. The journey has ended.',
      now: journeyNow,
    });
  }

  // 3. Adrift and still listed, unopened: withdrawn from the public ocean.
  const listed = tx
    .select({ id: t.bottles.id })
    .from(t.bottles)
    .where(
      and(
        eq(t.bottles.senderId, senderId),
        eq(t.bottles.state, 'lost'),
        eq(t.bottles.lossReason, 'adrift'),
        isNull(t.bottles.publicExpiredAt),
        gt(t.bottles.publicDeadlineAt, journeyNow),
        notExists(
          tx
            .select({ id: t.publicOpenings.bottleId })
            .from(t.publicOpenings)
            .where(eq(t.publicOpenings.bottleId, t.bottles.id)),
        ),
      ),
    )
    .all();
  let listingsWithdrawn = 0;
  for (const { id } of listed) {
    const withdrawn = tx
      .update(t.bottles)
      .set({ publicExpiredAt: journeyNow })
      .where(and(eq(t.bottles.id, id), isNull(t.bottles.publicExpiredAt)))
      .run().changes;
    if (withdrawn === 0) continue;
    listingsWithdrawn++;
    appendEvent(tx, id, 'public_expired', journeyNow, { reason: 'delivery_unavailable' });
  }
  return { settledArrivals, cancelled, listingsWithdrawn };
}

// Called inside every decision that can change an account's standing: upholding a report, a
// critical child-safety decision, and an appeal decision. While the account is suspended or
// banned, the journeys travelling to it end (product decision 14) and so do the ones it still
// has travelling to others (ARCH-R-002). Nothing needs undoing when a suspension expires or an
// appeal is accepted: standing is derived from server time, and ended journeys stay ended.
export function applyStandingEffects(
  ctx: AppContext,
  tx: DbOrTx,
  userId: string,
  now: number,
): number {
  if (!isRestricted(tx, userId, now)) return 0;
  const outbound = endOutboundJourneys(ctx, tx, userId);
  return endInboundJourneys(tx, userId, now) + outbound.cancelled + outbound.listingsWithdrawn;
}
