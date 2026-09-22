import { and, eq, isNull } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';
import { writeAudit } from './audit.js';

// Evidence retention (spec §16.5). A moderation case keeps a copy of the reported letter so
// that administrators judge what was actually sent, and so that an appeal is decided on the
// same text. That copy is the most sensitive thing this system stores, so it is kept for a
// fixed, short, documented time and then removed — automatically.
//
// The rule:
//
//     seven elapsed days after a case becomes final, its content evidence is redacted,
//     unless a documented legal or child-safety hold says otherwise.
//
// A case becomes final when there is nothing left to decide about it:
//
//   • the report was rejected; or
//   • the report was upheld and the sender explicitly waived their appeal; or
//   • the appeal they submitted was decided (either way).
//
// It is deliberately *not* final while the report is undecided, while the sender has not yet
// seen and resolved the decision notice, or while an appeal is pending. Someone who closed
// SeaYou without answering the notice still has their appeal, and an appeal decided on
// redacted evidence would be no appeal at all.
//
// "Redact" is not "delete the case". The case row, its category, its decision, who decided it,
// when, the violation it produced and the whole audit trail all survive — upheld violations
// never expire, so the metadata that justifies one has to outlive the letter that proved it.
// Only the content goes: the copied letter and the reporters' free-text explanations, which
// quote it.

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface RetentionPolicy {
  // Whether `applyRetention` may actually change anything. On by default: the seven-day rule
  // is the published policy, not a plan. `planRetention` works either way, so a run can always
  // be previewed first.
  enabled: boolean;
  // How long after a case becomes final its content evidence is redacted.
  finalAfterMs: number;
}

export const RETENTION_DEFAULT: RetentionPolicy = { enabled: true, finalAfterMs: SEVEN_DAYS_MS };
// For tests and for a deployment that deliberately wants to inspect before removing.
export const RETENTION_OFF: RetentionPolicy = { enabled: false, finalAfterMs: SEVEN_DAYS_MS };

// Why a case's evidence is still being kept. Everything except `settled` is a reason to wait.
export type RetentionHold =
  | 'case_pending' // nobody has decided the report yet
  | 'ai_in_queue' // the review queue still has to read it
  | 'notice_unresolved' // the sender has not appealed or waived the appeal yet
  | 'appeal_pending' // an appeal is waiting on it
  | 'legal_hold' // a documented legal reason
  | 'child_safety_hold' // a documented immediate child-safety reason
  | 'within_window' // final, but less than seven days ago
  | 'already_redacted';

export interface RetentionRow {
  caseId: string;
  status: 'pending' | 'accepted' | 'rejected';
  hold: RetentionHold | null;
  // When the case became final, if it has.
  finalAt: number | null;
  // When its evidence becomes redactable, if that is already knowable.
  redactableAt: number | null;
}

export interface RetentionPlan {
  now: number;
  policy: RetentionPolicy;
  cases: RetentionRow[];
  redactable: string[];
  held: Record<string, number>;
}

// The instant a case stopped being able to need its evidence, or null while it still can.
// Exported because it is the single definition of "final" the whole system shares.
export function finalityOf(
  db: DbOrTx,
  c: typeof t.moderationCases.$inferSelect,
): { finalAt: number | null; hold: RetentionHold | null } {
  if (c.status === 'pending') return { finalAt: null, hold: 'case_pending' };
  // A review actually in flight is holding this text as its input.
  if (c.aiStatus === 'running') return { finalAt: null, hold: 'ai_in_queue' };

  // A rejected report is over the moment it is rejected: there is no violation to appeal.
  if (c.status === 'rejected') return { finalAt: c.decidedAt ?? c.updatedAt, hold: null };

  const violation = db.select().from(t.violations).where(eq(t.violations.caseId, c.id)).get();
  // An accepted case with no violation should not exist; wait rather than guess.
  if (!violation) return { finalAt: null, hold: 'notice_unresolved' };

  const appeal = db.select().from(t.appeals).where(eq(t.appeals.violationId, violation.id)).get();
  if (appeal)
    return appeal.status === 'pending'
      ? { finalAt: null, hold: 'appeal_pending' }
      : { finalAt: appeal.decidedAt, hold: null };
  // No appeal: final only once the sender has explicitly given the appeal up. Until then the
  // offer is still open, however long ago the decision was, and the evidence stays.
  if (violation.appealWaivedAt !== null) return { finalAt: violation.appealWaivedAt, hold: null };
  return { finalAt: null, hold: 'notice_unresolved' };
}

// Is this case under a documented hold that has not been released?
export function holdOf(c: typeof t.moderationCases.$inferSelect): RetentionHold | null {
  if (c.holdReason === null || c.holdReleasedAt !== null) return null;
  return c.holdReason === 'legal' ? 'legal_hold' : 'child_safety_hold';
}

// Reads every case and says, for each, whether its evidence could be cleared and why not.
// Pure with respect to the database: it writes nothing, so it is safe to run as a dry run
// against production data before any apply.
export function planRetention(db: DbOrTx, now: number, policy: RetentionPolicy): RetentionPlan {
  const cases = db.select().from(t.moderationCases).all();
  const rows: RetentionRow[] = [];
  const held: Record<string, number> = {};
  const redactable: string[] = [];

  for (const c of cases) {
    const row = assess(db, c, now, policy);
    rows.push({ caseId: c.id, status: c.status, ...row });
    if (row.hold === null) redactable.push(c.id);
    else held[row.hold] = (held[row.hold] ?? 0) + 1;
  }
  return { now, policy, cases: rows, redactable, held };
}

function assess(
  db: DbOrTx,
  c: typeof t.moderationCases.$inferSelect,
  now: number,
  policy: RetentionPolicy,
): { hold: RetentionHold | null; finalAt: number | null; redactableAt: number | null } {
  if (c.evidenceRedactedAt !== null)
    return { hold: 'already_redacted', finalAt: null, redactableAt: null };

  const { finalAt, hold } = finalityOf(db, c);
  if (finalAt === null) return { hold: hold ?? 'case_pending', finalAt: null, redactableAt: null };

  const redactableAt = finalAt + policy.finalAfterMs;
  // A documented hold outranks the timer, and only a documented one can: there is no other
  // way for a case to sit beyond seven days.
  const held = holdOf(c);
  if (held !== null) return { hold: held, finalAt, redactableAt };
  return now >= redactableAt
    ? { hold: null, finalAt, redactableAt }
    : { hold: 'within_window', finalAt, redactableAt };
}

export interface RetentionResult {
  applied: boolean;
  redacted: string[];
  reason?: string;
}

// Clears the content evidence of every case the plan marks redactable, and records each one in
// the audit trail. Idempotent: a redacted case is never touched again, so running this twice,
// or every hour, changes nothing the second time.
export function applyRetention(db: Db, now: number, policy: RetentionPolicy): RetentionResult {
  const plan = planRetention(db, now, policy);
  if (!policy.enabled)
    return {
      applied: false,
      redacted: [],
      reason: 'retention is disabled (MIB_RETENTION_ENABLED=false); nothing was changed',
    };
  if (plan.redactable.length === 0) return { applied: true, redacted: [] };

  return db.transaction((tx) => {
    const done: string[] = [];
    for (const caseId of plan.redactable) {
      // Re-check inside the transaction: an appeal or a hold may have arrived since the plan
      // was drawn up, and that must win.
      const fresh = tx
        .select()
        .from(t.moderationCases)
        .where(eq(t.moderationCases.id, caseId))
        .get();
      if (!fresh) continue;
      if (assess(tx, fresh, now, policy).hold !== null) continue;
      const changed = tx
        .update(t.moderationCases)
        .set({ evidenceText: '', evidenceRedactedAt: now })
        .where(and(eq(t.moderationCases.id, caseId), isNull(t.moderationCases.evidenceRedactedAt)))
        .run().changes;
      if (changed === 0) continue;
      // The reporters' explanations quote the same letter, so they go with it. *Who* reported
      // stays: it is what stops one person reporting the same letter twice, and what lets an
      // abusive reporter be found. It is never shown to the sender.
      tx.update(t.letterReports)
        .set({ explanation: null })
        .where(eq(t.letterReports.caseId, caseId))
        .run();
      writeAudit(
        tx,
        {
          action: 'evidence_redacted',
          caseId,
          subjectUserId: fresh.senderId,
          actorUserId: null,
          actorRole: 'system',
          detail: `seven-day retention; case final, evidence and reporter explanations cleared`,
        },
        now,
      );
      done.push(caseId);
    }
    return { applied: true, redacted: done };
  });
}
