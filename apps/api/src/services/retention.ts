import { and, eq, isNull } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';
import { EVIDENCE_RETENTION_MS } from '@mib/shared';
import { writeAudit } from './audit.js';

// Evidence retention (spec §16.5, product decision 5). A moderation case keeps a copy of the
// reported letter so that administrators judge what was actually sent, and so that an appeal is
// decided on the same text. That copy is the most sensitive thing this system stores, so it is
// kept for a fixed, documented time and then removed — automatically.
//
// The rule:
//
//     content evidence becomes redactable 30 days after the original administrator decision,
//     or once a timely appeal has been decided, whichever is later — unless a documented legal
//     or child-safety hold says otherwise.
//
// The clock runs on server time from the decision, whether or not the sender has opened
// SeaYou: an unanswered notice no longer keeps evidence forever. It is also the appeal window
// (moderation.ts), so an appeal can always be decided on the evidence it disputes, and a
// pending appeal holds the evidence however long it takes. An escalation to a critical ban that
// reopened the appeal counts from the escalation, for the same reason.
//
// "Redact" is not "delete the case". The case row, its category, its decision, who decided it,
// when, the reasons, the violation it produced and the whole audit trail all survive — upheld
// violations never expire. Only content goes: the copied letter, the reporters' free-text
// explanations and the model's translation and reasoning, all of which quote or paraphrase it.

export const THIRTY_DAYS_MS = EVIDENCE_RETENTION_MS;

export interface RetentionPolicy {
  // Whether `applyRetention` may actually change anything. On by default: the 30-day rule is
  // the published policy, not a plan. `planRetention` works either way, so a run can always be
  // previewed first.
  enabled: boolean;
  // How long after the decision content evidence is kept (30 days).
  afterDecisionMs: number;
}

export const RETENTION_DEFAULT: RetentionPolicy = {
  enabled: true,
  afterDecisionMs: THIRTY_DAYS_MS,
};
// For tests and for a deployment that deliberately wants to inspect before removing.
export const RETENTION_OFF: RetentionPolicy = { enabled: false, afterDecisionMs: THIRTY_DAYS_MS };

// Why a case's evidence is still being kept. Everything except `settled` is a reason to wait.
export type RetentionHold =
  | 'case_pending' // nobody has decided the report yet
  | 'ai_in_queue' // the review queue is reading it right now
  | 'appeal_pending' // a timely appeal is waiting on it
  | 'legal_hold' // a documented legal reason
  | 'child_safety_hold' // a documented immediate child-safety reason
  | 'within_window' // decided less than 30 days ago
  | 'already_redacted';

export interface RetentionRow {
  caseId: string;
  status: 'pending' | 'accepted' | 'rejected';
  hold: RetentionHold | null;
  // The decision (or reopened appeal window) the 30 days count from.
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

// The single definition of when a case's evidence may go, shared by the job, the planner and
// the admin view. `finalAt` is the decision instant the window counts from; `redactableAt` is
// null while something (an undecided report, a review in flight, a pending appeal) still needs
// the text.
export function finalityOf(
  db: DbOrTx,
  c: typeof t.moderationCases.$inferSelect,
  afterDecisionMs: number = THIRTY_DAYS_MS,
): { finalAt: number | null; redactableAt: number | null; hold: RetentionHold | null } {
  if (c.status === 'pending') return { finalAt: null, redactableAt: null, hold: 'case_pending' };
  if (c.aiStatus === 'running') return { finalAt: null, redactableAt: null, hold: 'ai_in_queue' };

  const decidedAt = c.decidedAt ?? c.updatedAt;
  if (c.status === 'rejected')
    return { finalAt: decidedAt, redactableAt: decidedAt + afterDecisionMs, hold: null };

  const violation = db.select().from(t.violations).where(eq(t.violations.caseId, c.id)).get();
  // An accepted case with no violation should not exist; count from the decision anyway.
  const anchor = violation
    ? Math.max(violation.decidedAt, violation.appealWindowStartsAt ?? violation.decidedAt)
    : decidedAt;
  const base = anchor + afterDecisionMs;
  if (!violation) return { finalAt: anchor, redactableAt: base, hold: null };
  const appeal = db.select().from(t.appeals).where(eq(t.appeals.violationId, violation.id)).get();
  if (appeal?.status === 'pending')
    return { finalAt: anchor, redactableAt: null, hold: 'appeal_pending' };
  if (appeal?.decidedAt != null)
    return { finalAt: anchor, redactableAt: Math.max(base, appeal.decidedAt), hold: null };
  return { finalAt: anchor, redactableAt: base, hold: null };
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

  const { finalAt, redactableAt, hold } = finalityOf(db, c, policy.afterDecisionMs);
  if (redactableAt === null) return { hold: hold ?? 'case_pending', finalAt, redactableAt: null };

  // A documented hold outranks the timer, and only a documented one can: there is no other
  // way for a case to sit beyond its window.
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
        // The model's translation and reasoning paraphrase or quote the letter, so they are
        // content evidence too. Its verdict, and every human decision and reason, stay.
        .set({
          evidenceText: '',
          evidenceRedactedAt: now,
          aiTranslation: null,
          aiReason: null,
          aiUncertainty: null,
        })
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
          detail:
            '30-day retention; letter copy, reporter explanations and model translation and reasoning cleared',
        },
        now,
      );
      done.push(caseId);
    }
    return { applied: true, redacted: done };
  });
}
