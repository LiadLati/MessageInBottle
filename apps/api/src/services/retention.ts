import { and, eq, isNull } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';
import { standingOf } from './moderation.js';

// Evidence retention (spec §16). A moderation case keeps a copy of the reported letter so that
// admins judge what was actually sent and so that an appeal is decided on the same text. That
// copy is the most sensitive thing this system stores, and keeping it for ever is not a
// neutral default — but neither is deleting it, because a person's suspension rests on it.
//
// The rule this module enforces is the one safe thing to say without a product decision:
//
//     evidence is redactable only once nothing can still need it,
//     and nothing is redacted at all until someone switches a policy on.
//
// "Redact" is deliberately not "delete the case": the case row, its category, its decision,
// who decided it, when, and the violation it produced all survive, so account standing, the
// admin history and the appeal record stay intact. Only the copied letter text (and the
// reporters' free-text explanations, which quote it) are cleared.
//
// Both retention windows and the appeal deadline default to null — meaning "keep for ever" —
// so out of the box this module never removes anything. docs/ARCHITECTURE.md carries the
// recommended values and the two product decisions they depend on.

export interface RetentionPolicy {
  // false (the default): `applyRetention` refuses to change anything. `planRetention` still
  // works, so a policy can be reviewed against real data before it is ever switched on.
  enabled: boolean;
  // Age, after the case was rejected, at which its evidence may be cleared. null: never.
  rejectedAfterMs: number | null;
  // Age, after the last thing that could need it, at which an accepted case's evidence may be
  // cleared. null: never. Only ever reached once the violation no longer counts and the appeal
  // deadline has passed, so it is inert unless `appealWindowMs` is set too.
  acceptedAfterMs: number | null;
  // How long after a violation is decided its owner may still appeal. null: no deadline, the
  // current product rule. A suspended or banned account may always appeal, whatever this says:
  // the appeal is its only remaining move.
  appealWindowMs: number | null;
}

export const RETENTION_OFF: RetentionPolicy = {
  enabled: false,
  rejectedAfterMs: null,
  acceptedAfterMs: null,
  appealWindowMs: null,
};

// Why a case's evidence is being kept. Every reason except `settled` is a hold.
export type RetentionHold =
  | 'case_pending' // nobody has decided the report yet
  | 'ai_in_queue' // the review queue still has to read it
  | 'appeal_pending' // an appeal is waiting on it
  | 'appeal_open' // the sender may still appeal
  | 'violation_in_force' // it justifies a sanction the account is still under
  | 'within_window' // settled, but younger than the policy's window
  | 'no_policy' // no window is configured for this outcome
  | 'already_redacted';

export interface RetentionRow {
  caseId: string;
  status: 'pending' | 'accepted' | 'rejected';
  hold: RetentionHold | null;
  // When this case becomes redactable under the policy, if that is already knowable.
  redactableAt: number | null;
}

export interface RetentionPlan {
  now: number;
  policy: RetentionPolicy;
  cases: RetentionRow[];
  redactable: string[];
  held: Record<string, number>;
}

// May this violation still be appealed? Unappealed, not revoked, and either the deadline is
// unset or has not passed — and always yes while the account is suspended or banned.
export function appealStillOpen(
  db: DbOrTx,
  violation: typeof t.violations.$inferSelect,
  now: number,
  appealWindowMs: number | null,
): boolean {
  if (violation.revokedAt !== null) return false;
  const appeal = db.select().from(t.appeals).where(eq(t.appeals.violationId, violation.id)).get();
  if (appeal) return false;
  if (appealWindowMs === null) return true;
  const standing = standingOf(db, violation.userId, now);
  if (standing.standing === 'suspended' || standing.standing === 'banned') return true;
  return now < violation.decidedAt + appealWindowMs;
}

// Reads every case and says, for each, whether its evidence could be cleared and why not.
// Pure with respect to the database: it writes nothing.
export function planRetention(db: DbOrTx, now: number, policy: RetentionPolicy): RetentionPlan {
  const cases = db.select().from(t.moderationCases).all();
  const rows: RetentionRow[] = [];
  const held: Record<string, number> = {};
  const redactable: string[] = [];

  for (const c of cases) {
    const { hold, redactableAt } = assess(db, c, now, policy);
    rows.push({ caseId: c.id, status: c.status, hold, redactableAt });
    if (hold === null) redactable.push(c.id);
    else held[hold] = (held[hold] ?? 0) + 1;
  }
  return { now, policy, cases: rows, redactable, held };
}

function assess(
  db: DbOrTx,
  c: typeof t.moderationCases.$inferSelect,
  now: number,
  policy: RetentionPolicy,
): { hold: RetentionHold | null; redactableAt: number | null } {
  if (c.evidenceRedactedAt !== null) return { hold: 'already_redacted', redactableAt: null };

  // Nothing about an undecided report is disposable: the admin has not read it yet.
  if (c.status === 'pending') return { hold: 'case_pending', redactableAt: null };
  // A review that is actually in flight is holding this text as its input. A case left at
  // `queued` after a decision is not: the worker only ever claims pending cases.
  if (c.aiStatus === 'running') return { hold: 'ai_in_queue', redactableAt: null };

  if (c.status === 'rejected') {
    if (policy.rejectedAfterMs === null) return { hold: 'no_policy', redactableAt: null };
    const at = (c.decidedAt ?? c.updatedAt) + policy.rejectedAfterMs;
    return now >= at
      ? { hold: null, redactableAt: at }
      : { hold: 'within_window', redactableAt: at };
  }

  // Accepted: the evidence is the justification for a sanction, so it outlives the decision.
  const violation = db.select().from(t.violations).where(eq(t.violations.caseId, c.id)).get();
  if (!violation) {
    // An accepted case with no violation should not exist; hold rather than guess.
    return { hold: 'violation_in_force', redactableAt: null };
  }
  const appeal = db
    .select()
    .from(t.appeals)
    .where(and(eq(t.appeals.violationId, violation.id), eq(t.appeals.status, 'pending')))
    .get();
  if (appeal) return { hold: 'appeal_pending', redactableAt: null };
  if (appealStillOpen(db, violation, now, policy.appealWindowMs))
    return { hold: 'appeal_open', redactableAt: null };
  if (violation.revokedAt === null) return { hold: 'violation_in_force', redactableAt: null };
  if (policy.acceptedAfterMs === null) return { hold: 'no_policy', redactableAt: null };

  // Age it from the last event that could have needed the text: the revocation, the appeal
  // decision, or the deadline that closed appeals — whichever came last.
  const decidedAppeal = db
    .select()
    .from(t.appeals)
    .where(eq(t.appeals.violationId, violation.id))
    .get();
  const closes = [
    violation.revokedAt,
    decidedAppeal?.decidedAt ?? null,
    policy.appealWindowMs === null ? null : violation.decidedAt + policy.appealWindowMs,
  ].filter((n): n is number => n !== null);
  const at = Math.max(...closes) + policy.acceptedAfterMs;
  return now >= at ? { hold: null, redactableAt: at } : { hold: 'within_window', redactableAt: at };
}

export interface RetentionResult {
  applied: boolean;
  redacted: string[];
  reason?: string;
}

// Clears the evidence of every case the plan marks redactable. Refuses outright unless the
// policy is enabled, so the default configuration cannot remove anything by accident.
export function applyRetention(db: Db, now: number, policy: RetentionPolicy): RetentionResult {
  const plan = planRetention(db, now, policy);
  if (!policy.enabled)
    return {
      applied: false,
      redacted: [],
      reason: 'retention is disabled (MIB_RETENTION_ENABLED is not true); nothing was changed',
    };
  if (plan.redactable.length === 0) return { applied: true, redacted: [] };

  return db.transaction((tx) => {
    const done: string[] = [];
    for (const caseId of plan.redactable) {
      // Re-check inside the transaction: a report or an appeal may have arrived since the plan
      // was drawn up, and that must win.
      const fresh = tx
        .select()
        .from(t.moderationCases)
        .where(eq(t.moderationCases.id, caseId))
        .get();
      if (!fresh) continue;
      const { hold } = assess(tx, fresh, now, policy);
      if (hold !== null) continue;
      tx.update(t.moderationCases)
        .set({ evidenceText: '', evidenceRedactedAt: now })
        .where(and(eq(t.moderationCases.id, caseId), isNull(t.moderationCases.evidenceRedactedAt)))
        .run();
      // The reporters' explanations quote the same letter, so they go with it. Who reported
      // stays: it is what stops one person reporting the same letter twice.
      tx.update(t.letterReports)
        .set({ explanation: null })
        .where(eq(t.letterReports.caseId, caseId))
        .run();
      done.push(caseId);
    }
    return { applied: true, redacted: done };
  });
}
