import { lte, or, isNotNull, and } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';

// Records that only ever grew (audit ARCH-024). Each is removed once nothing can use it:
//   • sessions after they expire — an expired token is refused anyway;
//   • password-reset records a day after they expired or were used or superseded;
//   • release idempotency records after 30 days — a client retries a release within minutes.
// Notifications and journey history are a person's own record and are not pruned here; how
// long to keep them is an open product decision (docs/REMEDIATION.md).
export const RESET_RECORD_GRACE_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export function pruneExpiredRecords(
  db: DbOrTx,
  now: number,
): { sessions: number; passwordResets: number; idempotencyKeys: number } {
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
  return { sessions, passwordResets, idempotencyKeys };
}
