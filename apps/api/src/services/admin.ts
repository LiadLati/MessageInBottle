import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { APPEAL_WINDOW_MS, formatDateTime } from '@mib/shared';
import type {
  AdminAppealDto,
  AdminPendingCountsDto,
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
import { releaseCapacityOnce } from './journey.js';
import { applyStandingEffects } from './restriction.js';

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
  return u ?? { id: userId, username: '(deleted)', displayName: 'Deleted user' };
}

function aiOf(c: CaseRow, aiEnabled: boolean): AiReviewDto {
  return {
    // Whether the review model runs on this server at all (MIB_AI_ENABLED). When it does not, a
    // queued case is not "waiting for the model": nothing will ever answer (audit FE-R-005).
    enabled: aiEnabled,
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
    childSafety: c.aiChildSafety,
  };
}

function summaryOf(db: DbOrTx, c: CaseRow, aiEnabled: boolean): AdminCaseSummaryDto {
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
    urgentAt: isoOrNull(c.urgentAt),
    // Only the review worker sets urgentAt: for a child-safety flag, or else for a threat.
    urgentReason: c.urgentAt === null ? null : c.aiChildSafety ? 'child_safety' : 'threat',
    bottleId: c.bottleId,
    context: c.context,
    sender: person(db, c.senderId),
    intendedRecipient: person(db, c.recipientId),
    reportCount: reports.length,
    reasons: [...new Set(reports.map((r) => r.reason as ReportReason))],
    firstReportedAt: iso(reports[0]?.createdAt ?? c.createdAt),
    latestReportAt: iso(reports.at(-1)?.createdAt ?? c.updatedAt),
    ai: aiOf(c, aiEnabled),
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
  afterDecisionMs: number,
  viewerId: string | null,
  now: number,
  aiEnabled: boolean,
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
  // An administrator who is a party to the case (sender, recipient or reporter) may not decide
  // it, and is not shown who else reported it, what they wrote, or the sender's appeal text
  // (audit SEC-R-003). They still see their own report and, as the sender, their own appeal.
  const recused = viewerId !== null && partiesOf(db, c).has(viewerId);
  return {
    ...summaryOf(db, c, aiEnabled),
    letter: {
      text: c.evidenceText,
      font: c.evidenceFont as LetterFont,
      characters: c.evidenceCharacters,
      redactedAt: c.evidenceRedactedAt === null ? null : iso(c.evidenceRedactedAt),
    },
    releasedAt: iso(bottle.releasedAt),
    reports: reports.map((r) => {
      const shown = !recused || r.reporterId === viewerId;
      return {
        id: r.id,
        reason: r.reason as ReportReason,
        explanation: shown ? r.explanation : null,
        context: r.context,
        hidden: r.hidden,
        createdAt: iso(r.createdAt),
        reporter: shown ? person(db, r.reporterId) : null,
      };
    }),
    appeal: appeal
      ? {
          id: appeal.id,
          status: appeal.status,
          text: !recused || appeal.userId === viewerId ? appeal.text : '',
          createdAt: iso(appeal.createdAt),
        }
      : null,
    retention: (() => {
      const { finalAt, redactableAt, hold } = finalityOf(db, c, afterDecisionMs);
      const held = holdOf(c);
      return {
        finalAt: isoOrNull(finalAt),
        redactableAt: isoOrNull(redactableAt),
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
          appealAvailable: appealAvailable(db, violation, now),
          appealWaivedAt: isoOrNull(violation.appealWaivedAt),
          noticePresentedAt: isoOrNull(violation.noticePresentedAt),
        }
      : null,
    evidenceDigest: sha256(c.evidenceText),
    consequence: consequenceOf(db, c.senderId),
    recused,
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
      'You are the sender, the recipient or a reporter on this case, so another administrator must act on it.',
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

// One page of the queue (audit SEC-R-018): urgent reviews first (product decision 2), then the
// most recent activity, as before; `before` continues after the last case of the previous page,
// so a queue longer than one page is never silently cut off.
export const ADMIN_PAGE_SIZE = 100;

function parseCursor(raw: string | undefined, parts: number): string[] | null {
  if (!raw) return null;
  const bits = raw.split('.');
  if (bits.length !== parts || bits.some((b) => !/^[A-Za-z0-9_-]+$/.test(b)))
    throw badRequest('bad_cursor', 'unrecognised page cursor');
  return bits;
}

export function listCases(
  ctx: AppContext,
  status: CaseStatus | 'all',
  page: { before?: string | undefined; limit?: number | undefined } = {},
): { cases: AdminCaseSummaryDto[]; nextCursor: string | null } {
  const limit = Math.min(Math.max(page.limit ?? ADMIN_PAGE_SIZE, 1), ADMIN_PAGE_SIZE);
  const cursor = parseCursor(page.before, 3);
  const urgentLast = sql<number>`(${t.moderationCases.urgentAt} is null)`;
  const after = cursor
    ? sql`(${urgentLast} > ${Number(cursor[0])} or (${urgentLast} = ${Number(cursor[0])} and (${t.moderationCases.updatedAt} < ${Number(cursor[1])} or (${t.moderationCases.updatedAt} = ${Number(cursor[1])} and ${t.moderationCases.id} < ${cursor[2]}))))`
    : undefined;
  const rows = ctx.db
    .select()
    .from(t.moderationCases)
    .where(and(status === 'all' ? undefined : eq(t.moderationCases.status, status), after))
    .orderBy(urgentLast, desc(t.moderationCases.updatedAt), desc(t.moderationCases.id))
    .limit(limit + 1)
    .all();
  const more = rows.length > limit;
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return {
    cases: shown.map((c) => summaryOf(ctx.db, c, ctx.config.ai.enabled)),
    nextCursor:
      more && last ? `${last.urgentAt === null ? 1 : 0}.${last.updatedAt}.${last.id}` : null,
  };
}

export function getCase(
  ctx: AppContext,
  caseId: string,
  viewer: AuthUser | null = null,
): AdminCaseDetailDto {
  const c = ctx.db.select().from(t.moderationCases).where(eq(t.moderationCases.id, caseId)).get();
  if (!c) throw notFound('case');
  return detailOf(
    ctx.db,
    c,
    ctx.config.retention.afterDecisionMs,
    viewer?.id ?? null,
    ctx.realClock.now(),
    ctx.config.ai.enabled,
  );
}

// Evidence reads are logged (audit SEC-R-003): who opened which case's letter, reports and
// appeal, and when. One row per administrator and case per half hour, so a screen that is
// re-read while it stays open does not flood the trail. The row holds ids only.
const EVIDENCE_VIEW_WINDOW_MS = 30 * 60 * 1000;

export function recordEvidenceViews(ctx: AppContext, admin: AuthUser, caseIds: string[]): void {
  if (caseIds.length === 0) return;
  const now = ctx.realClock.now();
  ctx.db.transaction((tx) => {
    for (const caseId of new Set(caseIds)) {
      const recent = tx
        .select({ id: t.moderationAudit.id })
        .from(t.moderationAudit)
        .where(
          and(
            eq(t.moderationAudit.caseId, caseId),
            eq(t.moderationAudit.action, 'evidence_viewed'),
            eq(t.moderationAudit.actorUserId, admin.id),
            sql`${t.moderationAudit.createdAt} > ${now - EVIDENCE_VIEW_WINDOW_MS}`,
          ),
        )
        .get();
      if (recent) continue;
      const c = tx
        .select({ senderId: t.moderationCases.senderId })
        .from(t.moderationCases)
        .where(eq(t.moderationCases.id, caseId))
        .get();
      if (!c) continue;
      writeAudit(
        tx,
        {
          action: 'evidence_viewed',
          caseId,
          subjectUserId: c.senderId,
          actorUserId: admin.id,
          actorRole: 'admin',
          detail: 'case evidence opened in the moderation console',
        },
        now,
      );
    }
  });
}

// Decides a pending case. `admin` is null when the model decides under MIB_AI_AUTO_DECIDE.
// Returns false when the case was already decided the same way (an idempotent replay), throws
// 409 when it was decided the other way. Accepting creates the case's single violation,
// withdraws the letter from every future in-app read (the evidence on the case is untouched,
// as is the journey: no state, timing or public listing changes) and tells the sender once.
export function decideCase(
  ctx: AppContext,
  // Always a person (product decision 2): there is no automated caller any more, and the type
  // leaves no value a worker could pass.
  admin: AuthUser,
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
    // The withdrawn letter can no longer be opened, so its shore place goes back now
    // (product decision 8); a no-op if it was already released on opening.
    releaseCapacityOnce(tx, c.bottleId, now);
    const standing = standingOf(tx, c.senderId, now);
    notifyStanding(
      tx,
      c.senderId,
      {
        id: violationId,
        recipientName: bottle.recipientNameSnapshot,
        readByFinder: c.context === 'public',
      },
      standing,
      now,
    );
    applyStandingEffects(ctx, tx, c.senderId, now);
    return true;
  });
}

// ---------- the moderation badge ----------

// What is waiting for this administrator to decide (the moderation badge). Opening a screen
// clears nothing: an item leaves the count only when it is decided. A case counts once however
// many reports it merges, and a case or appeal this administrator is a party to is left out,
// because they cannot decide it (audit SEC-010).
export function pendingCounts(ctx: AppContext, admin: AuthUser): AdminPendingCountsDto {
  const decidable = (c: CaseRow) => !partiesOf(ctx.db, c).has(admin.id);
  const reports = ctx.db
    .select()
    .from(t.moderationCases)
    .where(eq(t.moderationCases.status, 'pending'))
    .all()
    .filter(decidable).length;
  const appeals = ctx.db
    .select({ c: t.moderationCases })
    .from(t.appeals)
    .innerJoin(t.violations, eq(t.violations.id, t.appeals.violationId))
    .innerJoin(t.moderationCases, eq(t.moderationCases.id, t.violations.caseId))
    .where(eq(t.appeals.status, 'pending'))
    .all()
    .filter((r) => decidable(r.c)).length;
  return { reports, appeals, total: reports + appeals };
}

// ---------- appeals ----------

function appealOf(
  db: DbOrTx,
  a: typeof t.appeals.$inferSelect,
  afterDecisionMs: number,
  now: number,
  viewerId: string | null,
  aiEnabled: boolean,
): AdminAppealDto {
  const v = db.select().from(t.violations).where(eq(t.violations.id, a.violationId)).get()!;
  const c = db.select().from(t.moderationCases).where(eq(t.moderationCases.id, v.caseId)).get()!;
  const detail = detailOf(db, c, afterDecisionMs, viewerId, now, aiEnabled);
  return {
    id: a.id,
    status: a.status,
    // Hidden from a party administrator other than the appellant (audit SEC-R-003).
    text: detail.recused && a.userId !== viewerId ? '' : a.text,
    createdAt: iso(a.createdAt),
    appellant: person(db, a.userId),
    violation: {
      id: v.id,
      category: v.category as ReportReason,
      decidedAt: iso(v.decidedAt),
      revokedAt: isoOrNull(v.revokedAt),
    },
    case: detail,
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
  viewer: AuthUser | null = null,
  page: { before?: string | undefined; limit?: number | undefined } = {},
): { appeals: AdminAppealDto[]; nextCursor: string | null } {
  const limit = Math.min(Math.max(page.limit ?? ADMIN_PAGE_SIZE, 1), ADMIN_PAGE_SIZE);
  const cursor = parseCursor(page.before, 2);
  const after = cursor
    ? sql`(${t.appeals.createdAt} < ${Number(cursor[0])} or (${t.appeals.createdAt} = ${Number(cursor[0])} and ${t.appeals.id} < ${cursor[1]}))`
    : undefined;
  const rows = ctx.db
    .select()
    .from(t.appeals)
    .where(and(status === 'all' ? undefined : eq(t.appeals.status, status), after))
    .orderBy(desc(t.appeals.createdAt), desc(t.appeals.id))
    .limit(limit + 1)
    .all();
  const more = rows.length > limit;
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  const now = ctx.realClock.now();
  return {
    appeals: shown.map((a) =>
      appealOf(
        ctx.db,
        a,
        ctx.config.retention.afterDecisionMs,
        now,
        viewer?.id ?? null,
        ctx.config.ai.enabled,
      ),
    ),
    nextCursor: more && last ? `${last.createdAt}.${last.id}` : null,
  };
}

export function getAppeal(
  ctx: AppContext,
  appealId: string,
  viewer: AuthUser | null = null,
): AdminAppealDto {
  const a = ctx.db.select().from(t.appeals).where(eq(t.appeals.id, appealId)).get();
  if (!a) throw notFound('appeal');
  return appealOf(
    ctx.db,
    a,
    ctx.config.retention.afterDecisionMs,
    ctx.realClock.now(),
    viewer?.id ?? null,
    ctx.config.ai.enabled,
  );
}

// The appeal result, as the appellant reads it in the notification and the one-time popup
// (manual review round 1): what was decided, what it did, and nothing about who reported.
export function appealResultMessage(
  outcome: 'accepted' | 'rejected',
  sentOn: string,
  standing: 'good' | 'warned' | 'suspended' | 'banned' | null,
): string {
  if (outcome === 'rejected') {
    return `Your appeal about the letter you sent on ${sentOn} was reviewed and rejected. The decision stands. This is final within SeaYou, and it cannot be appealed again.`;
  }
  const now =
    standing === 'good'
      ? 'Your account is in good standing.'
      : standing === 'warned'
        ? 'Another decision still counts against your account.'
        : standing === 'suspended'
          ? 'Other decisions still keep your account suspended.'
          : 'Other decisions still keep your account banned.';
  return `Your appeal about the letter you sent on ${sentOn} was accepted. The violation was withdrawn, and your account standing was recalculated. ${now}`;
}

function sentOnLabel(releasedAt: number, zone: string | null): string {
  try {
    return formatDateTime(releasedAt, zone ?? 'UTC');
  } catch {
    return formatDateTime(releasedAt, 'UTC');
  }
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
    // The letter is named by when it was sent, in the appellant's own zone: never by who it was
    // written to, which for a delivered letter would point at the reporter.
    const zone = tx
      .select({ z: t.users.timeZone })
      .from(t.users)
      .where(eq(t.users.id, a.userId))
      .get()?.z;
    const sentOn = sentOnLabel(bottle.releasedAt, zone ?? null);
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
        message: appealResultMessage('accepted', sentOn, standing.standing),
        now,
      });
    } else {
      enqueueNotification(tx, {
        userId: a.userId,
        type: 'moderation',
        kind: 'moderation_appeal_rejected',
        bottleId: null,
        dedupeKey: `appeal_rejected:${a.id}`,
        message: appealResultMessage('rejected', sentOn, null),
        now,
      });
    }
    // Whatever the outcome, the standing it leaves applies at once; an accepted appeal restores
    // no ended journey (ARCH-R-002).
    applyStandingEffects(ctx, tx, a.userId, now);
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
    // Withdrawn from every further reading, and its shore place released (decision 8).
    releaseCapacityOnce(tx, c.bottleId, now);

    const violation = tx.select().from(t.violations).where(eq(t.violations.caseId, caseId)).get();
    if (!violation) throw conflict('no_violation', 'This case has no violation to classify.');
    if (violation.revokedAt !== null)
      throw conflict('already_revoked', 'This violation was revoked on appeal.');
    const escalated = c.status === 'accepted';
    // Already confirmed critical: a replay (a double submit, a retried request, a second
    // administrator confirming the same case) changes nothing. It must not write new audit
    // rows, restart the appeal window, clear the notice state or move the retention anchor
    // (audit SEC-R-005). The first confirmation and its reason stand.
    if (escalated && violation.severity === 'critical') return;
    // Escalating an ordinary violation changes its consequence to a permanent ban. When no
    // appeal was ever filed — it was waived, or its window lapsed, or it is still open — the
    // person gets one appeal opportunity against the ban, with a fresh 30-day window from
    // now (product decision 2). An appeal already filed covers it; a rejected one stays final.
    const filed = tx
      .select({ id: t.appeals.id })
      .from(t.appeals)
      .where(eq(t.appeals.violationId, violation.id))
      .get();
    const reopen = escalated && !filed;
    const wasClosed =
      violation.appealWaivedAt !== null ||
      now >= (violation.appealWindowStartsAt ?? violation.decidedAt) + APPEAL_WINDOW_MS;
    tx.update(t.violations)
      .set({
        severity: 'critical',
        reason: trimmed,
        ...(reopen
          ? {
              appealWaivedAt: null,
              appealWindowStartsAt: now,
              appealReopenedAt: wasClosed ? now : violation.appealReopenedAt,
              acknowledgedAt: null,
              noticePresentedAt: null,
            }
          : {}),
      })
      .where(eq(t.violations.id, violation.id))
      .run();
    if (reopen)
      writeAudit(
        tx,
        {
          action: 'appeal_reopened',
          caseId,
          violationId: violation.id,
          subjectUserId: c.senderId,
          actorUserId: admin.id,
          actorRole: 'admin',
          reason: trimmed,
          detail: wasClosed
            ? `escalated to a permanent ban after the appeal ${violation.appealWaivedAt !== null ? 'was waived' : 'window lapsed'}; one new 30-day appeal window opened`
            : 'escalated to a permanent ban; the 30-day appeal window restarts from the escalation',
        },
        now,
      );

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
        detail: JSON.stringify({
          classification: 'critical_child_safety',
          action: 'permanent_ban',
          letter: 'withdrawn from reading',
          path: escalated ? 'escalated from an upheld violation' : 'decided from the report',
        }),
      },
      now,
    );
    const bottle = tx.select().from(t.bottles).where(eq(t.bottles.id, c.bottleId)).get()!;
    notifyStanding(
      tx,
      c.senderId,
      {
        id: violation.id,
        recipientName: bottle.recipientNameSnapshot,
        readByFinder: c.context === 'public',
        critical: true,
      },
      standingOf(tx, c.senderId, now),
      now,
    );
    applyStandingEffects(ctx, tx, c.senderId, now);
  });
  return getCase(ctx, caseId, admin);
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
    // A party may not decide how long the evidence about them is kept (audit SEC-R-003).
    assertNotParty(tx, admin, c);
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
  return getCase(ctx, caseId, admin);
}

export function releaseHold(ctx: AppContext, admin: AuthUser, caseId: string): AdminCaseDetailDto {
  const now = ctx.realClock.now();
  ctx.db.transaction((tx) => {
    const c = tx.select().from(t.moderationCases).where(eq(t.moderationCases.id, caseId)).get();
    if (!c) throw notFound('case');
    assertNotParty(tx, admin, c);
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
  return getCase(ctx, caseId, admin);
}
