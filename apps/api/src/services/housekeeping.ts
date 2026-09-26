import { lte, or, isNotNull, and } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';

// Operational records only (audit ARCH-024, product decision 6). Each is removed once nothing
// can use it:
//   • sessions after they expire — an expired token is refused anyway;
//   • password-reset records a day after they expired or were used or superseded;
//   • release idempotency records after 30 days — a client retries a release within minutes;
//   • the review worker's retry state (attempt count, last provider error, next attempt time)
//     90 days after the review finished — the only delivery/retry log SeaYou keeps.
//
// User-visible history is never touched here: notifications stay for the life of the account
// (marking them read only clears the badge), and letters, journeys and their events follow
// their own ownership and moderation rules. Nothing in this file deletes or edits either.
export const RESET_RECORD_GRACE_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
export const OPERATIONAL_LOG_KEEP_MS = 90 * 24 * 60 * 60 * 1000;

export function pruneExpiredRecords(
  db: DbOrTx,
  now: number,
): {
  sessions: number;
  passwordResets: number;
  idempotencyKeys: number;
  workerRetryLogs: number;
} {
  const sessions = db.delete(t.sessions).where(lte(t.sessions.expiresAt, now)).run().changes;
  const cutoff = now - RESET_RECORD_GRACE_MS;
  const passwordResets = db
    .delete(t.passwordResets)
    .where(
      or(
        lte(t.passwordResets.expiresAt, cutoff),
        and(isNotNull(t.passwordResets.usedAt), lte(t.passwordResets.usedAt, cutoff)),
        and(isNotNull(t.passwordResets.invalidatedAt), lte(t.passwordResets.invalidatedAt, cutoff)),
      ),
    )
    .run().changes;
  const idempotencyKeys = db
    .delete(t.idempotencyKeys)
    .where(lte(t.idempotencyKeys.createdAt, now - IDEMPOTENCY_KEEP_MS))
    .run().changes;
  const workerRetryLogs = db
    .update(t.moderationCases)
    .set({ aiLastError: null, aiNextAttemptAt: null, aiStartedAt: null })
    .where(
      and(
        or(isNotNull(t.moderationCases.aiLastError), isNotNull(t.moderationCases.aiStartedAt)),
        isNotNull(t.moderationCases.aiCompletedAt),
        lte(t.moderationCases.aiCompletedAt, now - OPERATIONAL_LOG_KEEP_MS),
      ),
    )
    .run().changes;
  return { sessions, passwordResets, idempotencyKeys, workerRetryLogs };
}
