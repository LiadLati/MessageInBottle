import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';
import { appendEvent, releaseCapacityOnce } from './journey.js';
import { isRestricted } from './moderation.js';
import { enqueueNotification } from './notifications.js';

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

// Called after every decision that can change an account's standing. A suspension or ban
// ends the journeys travelling to the account at once; nothing else changes, and nothing
// needs undoing when a suspension expires — it is derived from server time.
export function applyStandingEffects(tx: DbOrTx, userId: string, now: number): number {
  return isRestricted(tx, userId, now) ? endInboundJourneys(tx, userId, now) : 0;
}
