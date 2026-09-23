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
import { newId, sha256 } from '../lib/ids.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { badRequest } from '../lib/errors.js';
import type { AppContext, AuthUser } from './context.js';
import { appealAvailable, notifyStanding, standingOf, violationsInForce } from './moderation.js';
import { enqueueNotification } from './notifications.js';
import { writeAudit } from './audit.js';
import { finalityOf, holdOf } from './retention.js';

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

function detailOf(
  db: DbOrTx,
  c: CaseRow,
  finalAfterMs: number,
  viewerId: string | null,
): AdminCaseDetailDto {
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
      redactedAt: c.evidenceRedactedAt === null ? null : iso(c.evidenceRedactedAt),
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
    retention: (() => {
      const { finalAt, hold } = finalityOf(db, c);
      const held = holdOf(c);
      return {
        finalAt: isoOrNull(finalAt),
        redactableAt: finalAt === null ? null : iso(finalAt + finalAfterMs),
        hold:
          c.evidenceRedactedAt !== null ? 'already_redacted' : (held ?? hold ?? 'within_window'),
      };
    })(),
    hold:
      c.holdReason === null
        ? null
        : {
            reason: c.holdReason,
            note: c.holdNote ?? '',
            placedAt: iso(c.holdAt!),
            placedBy: c.holdByUserId === null ? null : person(db, c.holdByUserId),
            releasedAt: isoOrNull(c.holdReleasedAt),
          },
    violation: violation
      ? {
          id: violation.id,
          severity: violation.severity,
          appealAvailable: appealAvailable(db, violation),
          appealWaivedAt: isoOrNull(violation.appealWaivedAt),
          noticePresentedAt: isoOrNull(violation.noticePresentedAt),
        }
      : null,
    evidenceDigest: sha256(c.evidenceText),
    consequence: consequenceOf(db, c.senderId),
    recused: viewerId !== null && partiesOf(db, c).has(viewerId),
  };
}

// The people a case is about or came from: its sender, its recipient and every reporter. An
// administrator who is one of them may not decide it (audit SEC-010), however the case arose.
export function partiesOf(db: DbOrTx, c: CaseRow): Set<string> {
  const reporters = db
    .select({ id: t.letterReports.reporterId })
    .from(t.letterReports)
    .where(eq(t.letterReports.caseId, c.id))
    .all()
    .map((r) => r.id);
  return new Set([c.senderId, c.recipientId, ...reporters].filter((x): x is string => !!x));
}

function assertNotParty(db: DbOrTx, admin: AuthUser | null, c: CaseRow): void {
  if (admin && partiesOf(db, c).has(admin.id))
    throw new AppError(
      403,
      'recused',
      'You are the sender, the recipient or a reporter on this case, so another administrator must decide it.',
    );
}

// What upholding this case would do, from the violations in force now: the ladder is one
// warns, two suspend, three ban (moderation.ts, standingOf).
function consequenceOf(
  db: DbOrTx,
  senderId: string,
): { violationsInForce: number; ifUpheld: 'warning' | 'suspension' | 'ban' } {
  const inForce = violationsInForce(db, senderId);
  const next = inForce.length + 1;
  const ifUpheld = inForce.some((v) => v.severity === 'critical')
    ? 'ban'
    : next === 1
      ? 'warning'
      : next === 2
        ? 'suspension'
        : 'ban';
  return { violationsInForce: inForce.length, ifUpheld };
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

export function getCase(
  ctx: AppContext,
  caseId: string,
  viewer: AuthUser | null = null,
): AdminCaseDetailDto {
  const c = ctx.db.select().from(t.moderationCases).where(eq(t.moderationCases.id, caseId)).get();
  if (!c) throw notFound('case');
  return detailOf(ctx.db, c, ctx.config.retention.finalAfterMs, viewer?.id ?? null);
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
  // The digest of the evidence the administrator was shown. Given by every HTTP decision; a
  // mismatch means the screen is stale (audit SEC-010).
  expectedDigest?: string,
): boolean {
  const now = ctx.realClock.now();
  return ctx.db.transaction((tx) => {
    const c = tx.select().from(t.moderationCases).where(eq(t.moderationCases.id, caseId)).get();
    if (!c) throw notFound('case');
    assertNotParty(tx, admin, c);
    if (c.status !== 'pending') {
      if (c.decidedOutcome === outcome) return false;
      throw conflict('already_decided', `This case was already ${c.decidedOutcome}.`);
    }
    if (expectedDigest !== undefined && expectedDigest !== sha256(c.evidenceText))
      throw conflict(
        'stale_case',
        'This case changed since it was opened. Reload it and decide again.',
      );
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
    if (outcome === 'rejected') {
      writeAudit(
        tx,
        {
          action: 'case_decided',
          caseId,
          subjectUserId: c.senderId,
          actorUserId: admin?.id ?? null,
          actorRole: admin ? 'admin' : 'system',
          reason: reason ?? null,
          detail: 'rejected; no violation recorded',
        },
        now,
      );
      return true;
    }

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
    writeAudit(
      tx,
      {
        action: 'case_decided',
        caseId,
        violationId,
        subjectUserId: c.senderId,
        actorUserId: admin?.id ?? null,
        actorRole: admin ? 'admin' : 'system',
        reason: reason ?? null,
        detail: `upheld (${admin ? 'administrator' : 'automatic'})`,
      },
      now,
    );
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

function appealOf(
  db: DbOrTx,
  a: typeof t.appeals.$inferSelect,
  finalAfterMs: number,
): AdminAppealDto {
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
    case: detailOf(db, c, finalAfterMs, null),
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
    .map((a) => appealOf(ctx.db, a, ctx.config.retention.finalAfterMs));
}

export function getAppeal(ctx: AppContext, appealId: string): AdminAppealDto {
  const a = ctx.db.select().from(t.appeals).where(eq(t.appeals.id, appealId)).get();
  if (!a) throw notFound('appeal');
  return appealOf(ctx.db, a, ctx.config.retention.finalAfterMs);
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
    const av = tx.select().from(t.violations).where(eq(t.violations.id, a.violationId)).get();
    const ac = av
      ? tx.select().from(t.moderationCases).where(eq(t.moderationCases.id, av.caseId)).get()
      : undefined;
    if (ac) assertNotParty(tx, admin, ac);
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
    writeAudit(
      tx,
      {
        action: 'appeal_decided',
        caseId: v.caseId,
        violationId: v.id,
        appealId: a.id,
        subjectUserId: a.userId,
        actorUserId: admin.id,
        actorRole: 'admin',
        reason: reason ?? null,
        detail:
          outcome === 'accepted'
            ? 'accepted; violation revoked and standing recalculated'
            : 'rejected; the decision is final and cannot be appealed again',
      },
      now,
    );
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

// ---------- confirmed critical child-safety enforcement ----------

// Upholds a report as a confirmed critical child-safety violation, which bans the account
// immediately instead of walking the warning ladder (one warns, two suspend, three ban).
//
// Every guard here is deliberate:
//
//   • `admin` is a required administrator, not `AuthUser | null` as an ordinary decision is.
//     There is no code path that reaches this from the AI review worker, and none that can be
//     added by flipping a configuration flag: the model can only ever recommend.
//   • the reason is mandatory and is validated before it gets here, so no account is ever
//     banned this way without an administrator writing down why.
//   • the classification is recorded on the violation (`severity = 'critical'`), so the ban
//     survives an accepted appeal being reasoned about later, and the audit row survives the
//     evidence itself being redacted.
//   • the single appeal opportunity is untouched. A critical decision is still appealable
//     exactly once, and an accepted appeal revokes it and recalculates standing like any
//     other — a ban is not a way around review.
//
// The UI puts this behind a strong confirmation, but that is a courtesy, not the control:
// the authority lives here.
export function decideCaseCritical(
  ctx: AppContext,
  admin: AuthUser,
  caseId: string,
  reason: string,
  expectedDigest?: string,
): AdminCaseDetailDto {
  const trimmed = reason.trim();
  if (!trimmed)
    throw badRequest('reason_required', 'a critical child-safety decision requires a reason');
  const now = ctx.realClock.now();
  ctx.db.transaction((tx) => {
    const c = tx.select().from(t.moderationCases).where(eq(t.moderationCases.id, caseId)).get();
    if (!c) throw notFound('case');
    assertNotParty(tx, admin, c);
    if (c.status === 'rejected')
      throw conflict('already_decided', 'This case was already rejected.');
    if (expectedDigest !== undefined && expectedDigest !== sha256(c.evidenceText))
      throw conflict(
        'stale_case',
        'This case changed since it was opened. Reload it and decide again.',
      );

    // Upholding it, if that has not happened yet. A case already accepted the ordinary way can
    // still be escalated: the classification is what changes, not the outcome.
    if (c.status === 'pending') {
      tx.update(t.moderationCases)
        .set({
          status: 'accepted',
          decidedOutcome: 'accepted',
          decidedBy: 'admin',
          decidedByUserId: admin.id,
          decidedAt: now,
          decisionReason: trimmed,
          updatedAt: now,
        })
        .where(and(eq(t.moderationCases.id, caseId), eq(t.moderationCases.status, 'pending')))
        .run();
      const firstReport = tx
        .select()
        .from(t.letterReports)
        .where(eq(t.letterReports.caseId, caseId))
        .orderBy(t.letterReports.createdAt)
        .get();
      tx.insert(t.violations)
        .values({
          id: newId('vio'),
          caseId,
          userId: c.senderId,
          bottleId: c.bottleId,
          category: firstReport?.reason ?? 'child_safety',
          decidedAt: now,
          decidedBy: 'admin',
          decidedByUserId: admin.id,
          reason: trimmed,
          severity: 'critical',
          createdAt: now,
        })
        .onConflictDoNothing()
        .run();
      tx.update(t.bottles)
        .set({ moderationStatus: 'removed' })
        .where(eq(t.bottles.id, c.bottleId))
        .run();
    }

    const violation = tx.select().from(t.violations).where(eq(t.violations.caseId, caseId)).get();
    if (!violation) throw conflict('no_violation', 'This case has no violation to classify.');
    if (violation.revokedAt !== null)
      throw conflict('already_revoked', 'This violation was revoked on appeal.');
    tx.update(t.violations)
      .set({ severity: 'critical', reason: trimmed })
      .where(eq(t.violations.id, violation.id))
      .run();

    writeAudit(
      tx,
      {
        action: 'critical_child_safety',
        caseId,
        violationId: violation.id,
        subjectUserId: c.senderId,
        actorUserId: admin.id,
        actorRole: 'admin',
        reason: trimmed,
        detail: 'classified as a confirmed critical child-safety violation; permanent ban applied',
      },
      now,
    );
    const bottle = tx.select().from(t.bottles).where(eq(t.bottles.id, c.bottleId)).get()!;
    notifyStanding(
      tx,
      c.senderId,
      { id: violation.id, recipientName: bottle.recipientNameSnapshot },
      standingOf(tx, c.senderId, now),
      ctx.clock.now(),
    );
  });
  return getCase(ctx, caseId);
}

// ---------- legal and child-safety holds ----------

// Keeps a case's evidence beyond the ordinary seven days, for a documented reason. A hold is
// never implicit and never permanent by accident: it records why, who placed it and when, and
// releasing it returns the case to the normal retention calculation immediately.
export function placeHold(
  ctx: AppContext,
  admin: AuthUser,
  caseId: string,
  reason: 'legal' | 'child_safety',
  note: string,
): AdminCaseDetailDto {
  const trimmed = note.trim();
  if (!trimmed) throw badRequest('note_required', 'a hold requires a documented reason');
  const now = ctx.realClock.now();
  ctx.db.transaction((tx) => {
    const c = tx.select().from(t.moderationCases).where(eq(t.moderationCases.id, caseId)).get();
    if (!c) throw notFound('case');
    if (c.evidenceRedactedAt !== null)
      throw conflict('already_redacted', 'This case’s evidence has already been redacted.');
    tx.update(t.moderationCases)
      .set({
        holdReason: reason,
        holdNote: trimmed,
        holdByUserId: admin.id,
        holdAt: now,
        // Placing a hold again clears any previous release: this is the live hold now.
        holdReleasedAt: null,
        holdReleasedByUserId: null,
        updatedAt: now,
      })
      .where(eq(t.moderationCases.id, caseId))
      .run();
    writeAudit(
      tx,
      {
        action: 'hold_placed',
        caseId,
        subjectUserId: c.senderId,
        actorUserId: admin.id,
        actorRole: 'admin',
        reason: trimmed,
        detail: `${reason} hold; evidence retained beyond the seven-day window`,
      },
      now,
    );
  });
  return getCase(ctx, caseId);
}

export function releaseHold(ctx: AppContext, admin: AuthUser, caseId: string): AdminCaseDetailDto {
  const now = ctx.realClock.now();
  ctx.db.transaction((tx) => {
    const c = tx.select().from(t.moderationCases).where(eq(t.moderationCases.id, caseId)).get();
    if (!c) throw notFound('case');
    if (c.holdReason === null || c.holdReleasedAt !== null)
      throw conflict('no_hold', 'This case is not under a hold.');
    tx.update(t.moderationCases)
      .set({ holdReleasedAt: now, holdReleasedByUserId: admin.id, updatedAt: now })
      .where(and(eq(t.moderationCases.id, caseId), isNull(t.moderationCases.holdReleasedAt)))
      .run();
    writeAudit(
      tx,
      {
        action: 'hold_released',
        caseId,
        subjectUserId: c.senderId,
        actorUserId: admin.id,
        actorRole: 'admin',
        detail: 'hold released; the case returns to the ordinary seven-day calculation',
      },
      now,
    );
  });
  return getCase(ctx, caseId);
}
