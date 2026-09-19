import { and, desc, eq, isNull } from 'drizzle-orm';
import type {
  AdminAppealDto,
  AdminCaseDetailDto,
  AdminCaseSummaryDto,
  AiReviewDto,
  CaseStatus,
  LetterFont,
  PersonDto,
  ReportReason,
} from '@mib/shared';
import type { DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { conflict, notFound } from '../lib/errors.js';
import type { AppContext, AuthUser } from './context.js';
import { notifyStanding, standingOf } from './moderation.js';
import { enqueueNotification } from './notifications.js';

// The admin side of moderation: reading cases with their evidence, deciding them, and deciding
// appeals. Every state change here is one transaction guarded by the row's current status, so
// two admins (or an admin and the model) acting on the same case at the same moment produce
// exactly one decision, one violation and one notification.

const iso = (ms: number) => new Date(ms).toISOString();
const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));

type CaseRow = typeof t.moderationCases.$inferSelect;

function person(db: DbOrTx, userId: string): PersonDto {
  const u = db
    .select({ id: t.users.id, username: t.users.username, displayName: t.users.displayName })
    .from(t.users)
    .where(eq(t.users.id, userId))
    .get();
  return u ?? { id: userId, username: '(deleted)', displayName: 'Deleted account' };
}

function aiOf(c: CaseRow): AiReviewDto {
  return {
    status: c.aiStatus,
    verdict: c.aiVerdict,
    reason: c.aiReason,
    uncertainty: c.aiUncertainty,
    translation: c.aiTranslation,
    language: c.aiLanguage,
    model: c.aiModel,
    attempts: c.aiAttempts,
    completedAt: isoOrNull(c.aiCompletedAt),
    nextAttemptAt: isoOrNull(c.aiNextAttemptAt),
    lastError: c.aiLastError,
  };
}

function summaryOf(db: DbOrTx, c: CaseRow): AdminCaseSummaryDto {
  const reports = db
    .select()
    .from(t.letterReports)
    .where(eq(t.letterReports.caseId, c.id))
    .orderBy(t.letterReports.createdAt)
    .all();
  const violation = db
    .select({ id: t.violations.id })
    .from(t.violations)
    .where(eq(t.violations.caseId, c.id))
    .get();
  return {
    id: c.id,
    status: c.status,
    bottleId: c.bottleId,
    context: c.context,
    sender: person(db, c.senderId),
    intendedRecipient: person(db, c.recipientId),
    reportCount: reports.length,
    reasons: [...new Set(reports.map((r) => r.reason as ReportReason))],
    firstReportedAt: iso(reports[0]?.createdAt ?? c.createdAt),
    latestReportAt: iso(reports.at(-1)?.createdAt ?? c.updatedAt),
    ai: aiOf(c),
    decision:
      c.decidedOutcome && c.decidedAt && c.decidedBy
        ? {
            outcome: c.decidedOutcome,
            by: c.decidedBy,
            admin: c.decidedByUserId ? person(db, c.decidedByUserId) : null,
            at: iso(c.decidedAt),
            reason: c.decisionReason,
          }
        : null,
    violationId: violation?.id ?? null,
  };
}

function detailOf(db: DbOrTx, c: CaseRow): AdminCaseDetailDto {
  const bottle = db.select().from(t.bottles).where(eq(t.bottles.id, c.bottleId)).get()!;
  const reports = db
    .select()
    .from(t.letterReports)
    .where(eq(t.letterReports.caseId, c.id))
    .orderBy(t.letterReports.createdAt)
    .all();
  const violation = db.select().from(t.violations).where(eq(t.violations.caseId, c.id)).get();
  const appeal = violation
    ? db.select().from(t.appeals).where(eq(t.appeals.violationId, violation.id)).get()
    : undefined;
  return {
    ...summaryOf(db, c),
    letter: {
      text: c.evidenceText,
      font: c.evidenceFont as LetterFont,
      characters: c.evidenceCharacters,
    },
    releasedAt: iso(bottle.releasedAt),
    reports: reports.map((r) => ({
      id: r.id,
      reason: r.reason as ReportReason,
      explanation: r.explanation,
      context: r.context,
      hidden: r.hidden,
      createdAt: iso(r.createdAt),
      reporter: person(db, r.reporterId),
    })),
    appeal: appeal
      ? {
          id: appeal.id,
          status: appeal.status,
          text: appeal.text,
          createdAt: iso(appeal.createdAt),
        }
      : null,
  };
}

export function listCases(ctx: AppContext, status: CaseStatus | 'all'): AdminCaseSummaryDto[] {
  const rows = ctx.db
    .select()
    .from(t.moderationCases)
    .where(status === 'all' ? undefined : eq(t.moderationCases.status, status))
    .orderBy(desc(t.moderationCases.updatedAt))
    .limit(200)
    .all();
  return rows.map((c) => summaryOf(ctx.db, c));
}

export function getCase(ctx: AppContext, caseId: string): AdminCaseDetailDto {
  const c = ctx.db.select().from(t.moderationCases).where(eq(t.moderationCases.id, caseId)).get();
  if (!c) throw notFound('case');
  return detailOf(ctx.db, c);
}

// Decides a pending case. `admin` is null when the model decides under MIB_AI_AUTO_DECIDE.
// Returns false when the case was already decided the same way (an idempotent replay), throws
// 409 when it was decided the other way. Accepting creates the case's single violation,
// withdraws the letter from every future in-app read (the evidence on the case is untouched,
// as is the journey: no state, timing or public listing changes) and tells the sender once.
export function decideCase(
  ctx: AppContext,
  admin: AuthUser | null,
  caseId: string,
  outcome: 'accepted' | 'rejected',
  reason: string | null | undefined,
): boolean {
  const now = ctx.realClock.now();
  return ctx.db.transaction((tx) => {
    const c = tx.select().from(t.moderationCases).where(eq(t.moderationCases.id, caseId)).get();
    if (!c) throw notFound('case');
    if (c.status !== 'pending') {
      if (c.decidedOutcome === outcome) return false;
      throw conflict('already_decided', `This case was already ${c.decidedOutcome}.`);
    }
    const moved = tx
      .update(t.moderationCases)
      .set({
        status: outcome,
        decidedOutcome: outcome,
        decidedBy: admin ? 'admin' : 'ai',
        decidedByUserId: admin?.id ?? null,
        decidedAt: now,
        decisionReason: reason?.trim() ? reason.trim() : null,
        updatedAt: now,
      })
      .where(and(eq(t.moderationCases.id, caseId), eq(t.moderationCases.status, 'pending')))
      .run();
    if (moved.changes !== 1) throw conflict('already_decided', 'This case was decided meanwhile.');
    if (outcome === 'rejected') return true;

    const firstReport = tx
      .select()
      .from(t.letterReports)
      .where(eq(t.letterReports.caseId, caseId))
      .orderBy(t.letterReports.createdAt)
      .get();
    const violationId = newId('vio');
    tx.insert(t.violations)
      .values({
        id: violationId,
        caseId,
        userId: c.senderId,
        bottleId: c.bottleId,
        category: firstReport?.reason ?? 'other',
        decidedAt: now,
        decidedBy: admin ? 'admin' : 'ai',
        decidedByUserId: admin?.id ?? null,
        reason: reason?.trim() ? reason.trim() : null,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
    // Withdraw the letter from reads. Only the moderation status moves: the bottle's state,
    // timing, outcome and public listing stay exactly as they are.
    tx.update(t.bottles)
      .set({ moderationStatus: 'removed' })
      .where(eq(t.bottles.id, c.bottleId))
      .run();
    const bottle = tx.select().from(t.bottles).where(eq(t.bottles.id, c.bottleId)).get()!;
    const standing = standingOf(tx, c.senderId, now);
    notifyStanding(
      tx,
      c.senderId,
      { id: violationId, recipientName: bottle.recipientNameSnapshot },
      standing,
      ctx.clock.now(),
    );
    return true;
  });
}

// ---------- appeals ----------

function appealOf(db: DbOrTx, a: typeof t.appeals.$inferSelect): AdminAppealDto {
  const v = db.select().from(t.violations).where(eq(t.violations.id, a.violationId)).get()!;
  const c = db.select().from(t.moderationCases).where(eq(t.moderationCases.id, v.caseId)).get()!;
  return {
    id: a.id,
    status: a.status,
    text: a.text,
    createdAt: iso(a.createdAt),
    appellant: person(db, a.userId),
    violation: {
      id: v.id,
      category: v.category as ReportReason,
      decidedAt: iso(v.decidedAt),
      revokedAt: isoOrNull(v.revokedAt),
    },
    case: detailOf(db, c),
    decision:
      a.decidedAt && a.decidedByUserId && a.status !== 'pending'
        ? {
            outcome: a.status,
            admin: person(db, a.decidedByUserId),
            at: iso(a.decidedAt),
            reason: a.decisionReason,
          }
        : null,
  };
}

export function listAppeals(
  ctx: AppContext,
  status: 'pending' | 'accepted' | 'rejected' | 'all',
): AdminAppealDto[] {
  return ctx.db
    .select()
    .from(t.appeals)
    .where(status === 'all' ? undefined : eq(t.appeals.status, status))
    .orderBy(desc(t.appeals.createdAt))
    .limit(200)
    .all()
    .map((a) => appealOf(ctx.db, a));
}

export function getAppeal(ctx: AppContext, appealId: string): AdminAppealDto {
  const a = ctx.db.select().from(t.appeals).where(eq(t.appeals.id, appealId)).get();
  if (!a) throw notFound('appeal');
  return appealOf(ctx.db, a);
}

// Accepting an appeal revokes the violation (it stops counting at once, which is what lifts an
// unjustified suspension or ban) and restores the letter to reads; rejecting it is final. The
// appellant is told either way, once.
export function decideAppeal(
  ctx: AppContext,
  admin: AuthUser,
  appealId: string,
  outcome: 'accepted' | 'rejected',
  reason: string | null | undefined,
): boolean {
  const now = ctx.realClock.now();
  return ctx.db.transaction((tx) => {
    const a = tx.select().from(t.appeals).where(eq(t.appeals.id, appealId)).get();
    if (!a) throw notFound('appeal');
    if (a.status !== 'pending') {
      if (a.status === outcome) return false;
      throw conflict('already_decided', `This appeal was already ${a.status}.`);
    }
    const moved = tx
      .update(t.appeals)
      .set({
        status: outcome,
        decidedByUserId: admin.id,
        decidedAt: now,
        decisionReason: reason?.trim() ? reason.trim() : null,
      })
      .where(and(eq(t.appeals.id, appealId), eq(t.appeals.status, 'pending')))
      .run();
    if (moved.changes !== 1)
      throw conflict('already_decided', 'This appeal was decided meanwhile.');
    const v = tx.select().from(t.violations).where(eq(t.violations.id, a.violationId)).get()!;
    const bottle = tx.select().from(t.bottles).where(eq(t.bottles.id, v.bottleId)).get()!;
    if (outcome === 'accepted') {
      tx.update(t.violations)
        .set({ revokedAt: now, revokedByUserId: admin.id })
        .where(and(eq(t.violations.id, v.id), isNull(t.violations.revokedAt)))
        .run();
      // The letter was not a violation after all: it may be read again. Nothing about the
      // journey changes — an expired public listing stays expired.
      tx.update(t.bottles)
        .set({ moderationStatus: 'clear' })
        .where(and(eq(t.bottles.id, v.bottleId), eq(t.bottles.moderationStatus, 'removed')))
        .run();
      const standing = standingOf(tx, a.userId, now);
      enqueueNotification(tx, {
        userId: a.userId,
        type: 'moderation',
        kind: 'moderation_appeal_accepted',
        bottleId: null,
        dedupeKey: `appeal_accepted:${a.id}`,
        message: `Your appeal about the letter to ${bottle.recipientNameSnapshot} was accepted. The violation was withdrawn${
          standing.standing === 'good'
            ? ' and your account is in good standing again.'
            : standing.standing === 'suspended'
              ? '.'
              : ' and your account is no longer suspended or banned for it.'
        }`,
        now: ctx.clock.now(),
      });
    } else {
      enqueueNotification(tx, {
        userId: a.userId,
        type: 'moderation',
        kind: 'moderation_appeal_rejected',
        bottleId: null,
        dedupeKey: `appeal_rejected:${a.id}`,
        message: `Your appeal about the letter to ${bottle.recipientNameSnapshot} was reviewed and rejected. The decision stands and cannot be appealed again.`,
        now: ctx.clock.now(),
      });
    }
    return true;
  });
}
