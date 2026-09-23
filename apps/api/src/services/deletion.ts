import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import type { BottleState } from '@mib/shared';
import type { DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';
import { AppError, notFound } from '../lib/errors.js';
import { newSecretToken } from '../lib/ids.js';
import { appendEvent, releaseCapacityOnce } from './journey.js';
import { dummyPasswordHash, verifyPasswordAsync } from '../lib/password.js';
import type { AppContext } from './context.js';
import { enqueueNotification } from './notifications.js';
import { writeAudit } from './audit.js';

// Deleting an account, at its owner's request, as one transactional and idempotent operation.
//
// The account row is kept and emptied rather than dropped. Every letter in SeaYou is a row
// pointing at two accounts, and moderation cases point at a third; deleting the row would
// either break those references or force the deletion of letters that belong to the people who
// received them. So the row survives as an anonymous marker — no name, no address, no password,
// unable to sign in — and everything that identifies the person is removed.
//
// What goes immediately:
//   • every session (sign-in is refused the moment the status changes, and the rows go too);
//   • password-recovery records;
//   • the username, display name, email address, password, chosen harbour and time zone;
//   • friendships, friend requests and blocks, so the account leaves everyone's lists;
//   • notifications, map-marker state and stored idempotency records;
//   • letters still at sea, which nobody has received: their journeys are cancelled, the
//     reserved place at the destination harbour is given back, and the text is cleared;
//   • letters lost at sea — adrift in the public ocean or sunk: an adrift listing is withdrawn
//     at once (any finder's open reading ends with it) and the text of every lost letter is
//     cleared, so no deleted account's letter can still be found and opened (audit ARCH-002);
//   • letters travelling TO the account: their journeys end as "delivery unavailable" for the
//     sender, and the harbour place is released, as is the place held by any letter that
//     reached the account but was never opened (audit ARCH-014) — nobody can open it now;
//
// What remains, and why:
//   • letters that already reached their recipient, or were opened, stay with that recipient —
//     they are the other person's correspondence, and the sender now reads as a deleted account;
//   • moderation cases, reports, violations and appeals are kept under the evidence-retention
//     rules (services/retention.ts), because an open report, a pending appeal or a restriction
//     still in force must survive the account that caused it. They are never used for anything
//     else, and the retention policy releases them on its own terms.

export interface AccountDeletionSummary {
  userId: string;
  alreadyDeleted: boolean;
  deletedAt: string;
  sessionsRevoked: number;
  journeysCancelled: number;
  // Letters travelling to the account that can no longer arrive, and harbour places released
  // by letters that had arrived unopened.
  inboundJourneysEnded: number;
  harbourPlacesReleased: number;
  lettersClearedForSender: number;
  friendshipsRemoved: number;
  blocksRemoved: number;
  notificationsRemoved: number;
  moderationRecordsRetained: number;
}

export const invalidPassword = () =>
  new AppError(401, 'invalid_password', 'that password is not correct');

// Re-authentication: the person at the keyboard must know the password, not merely hold the
// session. Runs in constant time for a missing hash so it cannot be used to probe accounts.
export async function verifyAccountPassword(
  ctx: AppContext,
  userId: string,
  password: string,
): Promise<void> {
  const row = ctx.db.select().from(t.users).where(eq(t.users.id, userId)).get();
  const { ok } = await verifyPasswordAsync(password, row?.passwordHash ?? dummyPasswordHash());
  if (!row || !row.passwordHash || !ok) throw invalidPassword();
}

// Bottles that nobody has received yet: cancelling one harms no other person's record.
const IN_FLIGHT: BottleState[] = ['at_sea'];

function countModerationRecords(db: DbOrTx, userId: string): number {
  const cases = db
    .select({ id: t.moderationCases.id })
    .from(t.moderationCases)
    .where(or(eq(t.moderationCases.senderId, userId), eq(t.moderationCases.recipientId, userId)))
    .all().length;
  const reports = db
    .select({ id: t.letterReports.id })
    .from(t.letterReports)
    .where(eq(t.letterReports.reporterId, userId))
    .all().length;
  const violations = db
    .select({ id: t.violations.id })
    .from(t.violations)
    .where(eq(t.violations.userId, userId))
    .all().length;
  const appeals = db
    .select({ id: t.appeals.id })
    .from(t.appeals)
    .where(eq(t.appeals.userId, userId))
    .all().length;
  return cases + reports + violations + appeals;
}

export function accountDeletionSummary(
  ctx: AppContext,
  userId: string,
): AccountDeletionSummary | null {
  const row = ctx.db.select().from(t.users).where(eq(t.users.id, userId)).get();
  if (!row || row.deletedAt === null) return null;
  return {
    userId,
    alreadyDeleted: true,
    deletedAt: new Date(row.deletedAt).toISOString(),
    sessionsRevoked: 0,
    journeysCancelled: 0,
    inboundJourneysEnded: 0,
    harbourPlacesReleased: 0,
    lettersClearedForSender: 0,
    friendshipsRemoved: 0,
    blocksRemoved: 0,
    notificationsRemoved: 0,
    moderationRecordsRetained: countModerationRecords(ctx.db, userId),
  };
}

// Deletes the account. Calling it again for an account already deleted changes nothing and
// reports the original deletion, so a retried request or a double submit is safe.
export function deleteAccount(ctx: AppContext, userId: string): AccountDeletionSummary {
  const now = ctx.realClock.now();
  return ctx.db.transaction((tx) => {
    const user = tx.select().from(t.users).where(eq(t.users.id, userId)).get();
    if (!user) throw notFound('account');
    if (user.deletedAt !== null) {
      return {
        userId,
        alreadyDeleted: true,
        deletedAt: new Date(user.deletedAt).toISOString(),
        sessionsRevoked: 0,
        journeysCancelled: 0,
        inboundJourneysEnded: 0,
        harbourPlacesReleased: 0,
        lettersClearedForSender: 0,
        friendshipsRemoved: 0,
        blocksRemoved: 0,
        notificationsRemoved: 0,
        moderationRecordsRetained: countModerationRecords(tx, userId),
      };
    }

    // 1. Access ends here. The status alone already refuses every sign-in and every existing
    //    session; removing the rows leaves nothing to resolve either.
    const sessionsRevoked = tx
      .delete(t.sessions)
      .where(eq(t.sessions.userId, userId))
      .run().changes;
    tx.delete(t.passwordResets).where(eq(t.passwordResets.userId, userId)).run();

    // 2. Letters nobody has received: cancel the journey, free the harbour place, clear the text.
    const inFlight = tx
      .select({ id: t.bottles.id, letterId: t.bottles.letterId, version: t.bottles.version })
      .from(t.bottles)
      .where(and(eq(t.bottles.senderId, userId), inArray(t.bottles.state, IN_FLIGHT)))
      .all();
    for (const b of inFlight) {
      tx.update(t.bottles)
        .set({
          state: 'cancelled',
          version: b.version + 1,
          completedAt: now,
          publicDeadlineAt: null,
          publicExpiredAt: now,
        })
        .where(eq(t.bottles.id, b.id))
        .run();
      tx.update(t.capacityReservations)
        .set({ status: 'released', releasedAt: now })
        .where(
          and(eq(t.capacityReservations.bottleId, b.id), eq(t.capacityReservations.status, 'held')),
        )
        .run();
      appendEvent(tx, b.id, 'cancelled', now, { reason: 'account_deleted' });
    }
    const swept = sweepDeletedAccount(tx, userId, now);

    // The text of the deleted account's own unreceived and lost letters is of no use to anyone
    // now. A letter that reached its recipient is left alone: it is their correspondence, not
    // only the sender's.
    const clearable = inFlight.map((b) => b.letterId);
    if (clearable.length)
      tx.update(t.letters)
        .set({ text: '', characters: 0 })
        .where(inArray(t.letters.id, clearable))
        .run();

    // 3. The account disappears from other people's lists and from discovery.
    const friendshipsRemoved = tx
      .delete(t.friendships)
      .where(or(eq(t.friendships.userLowId, userId), eq(t.friendships.userHighId, userId)))
      .run().changes;
    const blocksRemoved = tx
      .delete(t.blocks)
      .where(or(eq(t.blocks.blockerId, userId), eq(t.blocks.blockedId, userId)))
      .run().changes;

    // 4. Everything the account alone held.
    const notificationsRemoved = tx
      .delete(t.notifications)
      .where(eq(t.notifications.userId, userId))
      .run().changes;
    tx.delete(t.bottleOutcomeViews).where(eq(t.bottleOutcomeViews.userId, userId)).run();
    tx.delete(t.idempotencyKeys).where(eq(t.idempotencyKeys.userId, userId)).run();

    // 5. The name other people would still see on a letter they hold.
    tx.update(t.bottles)
      .set({ senderNameSnapshot: DELETED_DISPLAY_NAME })
      .where(eq(t.bottles.senderId, userId))
      .run();
    tx.update(t.bottles)
      .set({ recipientNameSnapshot: DELETED_DISPLAY_NAME })
      .where(eq(t.bottles.recipientId, userId))
      .run();

    // 6. The account row itself: emptied, unusable, and no longer anybody in particular.
    tx.update(t.users)
      .set({
        username: `deleted_${newSecretToken().slice(0, 16)}`,
        displayName: DELETED_DISPLAY_NAME,
        email: null,
        passwordHash: null,
        passwordUpdatedAt: now,
        shoreId: null,
        timeZone: null,
        timeZoneSince: null,
        role: 'member',
        roleGrantedAt: null,
        roleGrantedBy: null,
        status: 'deleted',
        deletedAt: now,
      })
      .where(eq(t.users.id, userId))
      .run();

    return {
      userId,
      alreadyDeleted: false,
      deletedAt: new Date(now).toISOString(),
      sessionsRevoked,
      journeysCancelled: inFlight.length,
      inboundJourneysEnded: swept.inboundJourneysEnded,
      harbourPlacesReleased: inFlight.length + swept.harbourPlacesReleased,
      lettersClearedForSender: clearable.length + swept.lostLettersCleared,
      friendshipsRemoved,
      blocksRemoved,
      notificationsRemoved,
      moderationRecordsRetained: countModerationRecords(tx, userId),
    };
  });
}

export const DELETED_DISPLAY_NAME = 'Deleted account';

export interface DeletionSweep {
  adriftWithdrawn: number;
  lostLettersCleared: number;
  inboundJourneysEnded: number;
  harbourPlacesReleased: number;
  appealsClosed: number;
}

// The parts of a deletion that concern letters and moderation records other people's journeys
// touch. Idempotent: every write is guarded on the state it changes, so running it again — on
// the same deletion, or later over accounts deleted before these rules existed
// (tools/deletion-backfill.ts) — changes nothing that is already right.
export function sweepDeletedAccount(tx: DbOrTx, userId: string, now: number): DeletionSweep {
  // Letters lost at sea (audit ARCH-002). An adrift one is withdrawn from the public ocean now
  // rather than at the end of its 72 hours, and a finder's reading in progress closes with it;
  // the text of every lost letter is cleared.
  const lost = tx
    .select({
      id: t.bottles.id,
      letterId: t.bottles.letterId,
      lossReason: t.bottles.lossReason,
      publicExpiredAt: t.bottles.publicExpiredAt,
    })
    .from(t.bottles)
    .where(and(eq(t.bottles.senderId, userId), eq(t.bottles.state, 'lost')))
    .all();
  let adriftWithdrawn = 0;
  for (const b of lost) {
    if (b.lossReason !== 'adrift' || b.publicExpiredAt !== null) continue;
    const withdrawn = tx
      .update(t.bottles)
      .set({ publicExpiredAt: now })
      .where(and(eq(t.bottles.id, b.id), isNull(t.bottles.publicExpiredAt)))
      .run().changes;
    if (withdrawn === 0) continue;
    adriftWithdrawn++;
    appendEvent(tx, b.id, 'public_expired', now, { reason: 'account_deleted' });
  }
  if (lost.length)
    tx.update(t.publicOpenings)
      .set({ closedAt: now })
      .where(
        and(
          inArray(
            t.publicOpenings.bottleId,
            lost.map((b) => b.id),
          ),
          isNull(t.publicOpenings.closedAt),
        ),
      )
      .run();
  const lostLettersCleared = lost.length
    ? tx
        .update(t.letters)
        .set({ text: '', characters: 0 })
        .where(
          and(
            inArray(
              t.letters.id,
              lost.map((b) => b.letterId),
            ),
            ne(t.letters.text, ''),
          ),
        )
        .run().changes
    : 0;

  // Letters travelling TO the account can no longer be received (audit ARCH-014): the journey
  // ends for the sender exactly as a block would end it, and the harbour place goes back. A
  // letter that already arrived but was never opened frees its place too.
  const inbound = tx
    .select({ id: t.bottles.id, version: t.bottles.version, senderId: t.bottles.senderId })
    .from(t.bottles)
    .where(and(eq(t.bottles.recipientId, userId), eq(t.bottles.state, 'at_sea')))
    .all();
  let harbourPlacesReleased = 0;
  for (const b of inbound) {
    const ended = tx
      .update(t.bottles)
      .set({ state: 'cancelled', version: b.version + 1, completedAt: now })
      .where(and(eq(t.bottles.id, b.id), eq(t.bottles.state, 'at_sea')))
      .run().changes;
    if (ended === 0) continue;
    if (releaseCapacityOnce(tx, b.id, now)) harbourPlacesReleased++;
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
  const unopened = tx
    .select({ id: t.bottles.id })
    .from(t.bottles)
    .where(and(eq(t.bottles.recipientId, userId), eq(t.bottles.state, 'delivered')))
    .all();
  for (const b of unopened) if (releaseCapacityOnce(tx, b.id, now)) harbourPlacesReleased++;

  // A deleted account can never answer a decision notice, so its unused appeal opportunity
  // ends with the account (audit SEC-012). Without this, the case never became final and the
  // evidence copy was kept forever — contrary to the Privacy Policy's seven-day rule.
  const open = tx
    .select({ id: t.violations.id, caseId: t.violations.caseId })
    .from(t.violations)
    .where(and(eq(t.violations.userId, userId), isNull(t.violations.appealWaivedAt)))
    .all();
  let appealsClosed = 0;
  for (const v of open) {
    const appealed = tx
      .select({ id: t.appeals.id })
      .from(t.appeals)
      .where(eq(t.appeals.violationId, v.id))
      .get();
    if (appealed) continue;
    const closed = tx
      .update(t.violations)
      .set({ appealWaivedAt: now })
      .where(and(eq(t.violations.id, v.id), isNull(t.violations.appealWaivedAt)))
      .run().changes;
    if (closed === 0) continue;
    appealsClosed++;
    writeAudit(
      tx,
      {
        action: 'appeal_waived',
        caseId: v.caseId,
        violationId: v.id,
        subjectUserId: userId,
        actorUserId: null,
        actorRole: 'system',
        reason: 'account deleted',
        detail: 'the appeal opportunity ended with the account',
      },
      now,
    );
  }
  return {
    adriftWithdrawn,
    lostLettersCleared,
    inboundJourneysEnded: inbound.length,
    harbourPlacesReleased,
    appealsClosed,
  };
}
