import { and, asc, eq } from 'drizzle-orm';
import type { AuditEntryDto } from '@mib/shared';
import type { DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';
import { newId } from '../lib/ids.js';

// The moderation audit trail (spec §16.6). Every action that changes what a person may do
// leaves a row here, written inside the same transaction as the action itself, so the trail
// cannot disagree with the outcome. It is append-only: nothing in the codebase updates or
// deletes a row, and retention never touches it — the whole point is that it outlives the
// evidence it describes. It is read by administrators (GET /api/admin/audit) and exported for
// a data-subject request by tools/audit-export.ts (audit SEC-011). It is not tamper-evident
// against someone with write access to the database file; see docs/REMEDIATION.md.
export type AuditAction =
  | 'notice_presented'
  | 'appeal_waived'
  | 'appeal_submitted'
  | 'appeal_decided'
  | 'case_decided'
  | 'critical_child_safety'
  | 'appeal_reopened'
  | 'urgent_child_safety_review'
  | 'urgent_threat_review'
  | 'hold_placed'
  | 'hold_released'
  | 'evidence_redacted';

export interface AuditEntry {
  action: AuditAction;
  caseId?: string | null;
  violationId?: string | null;
  appealId?: string | null;
  // Whose standing this concerns.
  subjectUserId?: string | null;
  // Null when the subject acted on their own record, or when the server did.
  actorUserId?: string | null;
  actorRole: 'admin' | 'developer' | 'member' | 'system';
  reason?: string | null;
  detail?: string | null;
}

export function writeAudit(tx: DbOrTx, entry: AuditEntry, now: number): string {
  const id = newId('aud');
  tx.insert(t.moderationAudit)
    .values({
      id,
      action: entry.action,
      caseId: entry.caseId ?? null,
      violationId: entry.violationId ?? null,
      appealId: entry.appealId ?? null,
      subjectUserId: entry.subjectUserId ?? null,
      actorUserId: entry.actorUserId ?? null,
      actorRole: entry.actorRole,
      reason: entry.reason?.trim() ? entry.reason.trim() : null,
      detail: entry.detail ?? null,
      createdAt: now,
    })
    .run();
  return id;
}

// Rows about one person (their standing) or one case, oldest first — the order they happened in.
export function readAudit(
  db: DbOrTx,
  filter: { subjectUserId?: string | undefined; caseId?: string | undefined },
  limit = 1000,
): AuditEntryDto[] {
  const conditions = [
    filter.subjectUserId ? eq(t.moderationAudit.subjectUserId, filter.subjectUserId) : undefined,
    filter.caseId ? eq(t.moderationAudit.caseId, filter.caseId) : undefined,
  ].filter((c) => c !== undefined);
  return db
    .select()
    .from(t.moderationAudit)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(t.moderationAudit.createdAt), asc(t.moderationAudit.id))
    .limit(limit)
    .all()
    .map((r) => ({
      id: r.id,
      action: r.action,
      caseId: r.caseId,
      violationId: r.violationId,
      appealId: r.appealId,
      subjectUserId: r.subjectUserId,
      actorUserId: r.actorUserId,
      actorRole: r.actorRole,
      reason: r.reason,
      detail: r.detail,
      createdAt: new Date(r.createdAt).toISOString(),
    }));
}
