import { and, asc, eq, isNull } from 'drizzle-orm';
import type {
  AccountStandingDto,
  ReportReason,
  ReportRequest,
  ReportResponse,
  ViolationNoticeDto,
} from '@mib/shared';
import type { DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import type { AppContext, AuthUser } from './context.js';
import { enqueueNotification } from './notifications.js';

// Reporting and account standing (spec §16). Everything here runs on the real clock: a
// suspension is seven elapsed days of a person's life, not seven days of journey time.
//
// Boundaries kept throughout:
//   • a report never scans, alters or judges a letter — it opens (or joins) a case and copies
//     the letter in as protected evidence, which only admins can read;
//   • only an accepted case creates a violation, and a case creates at most one;
//   • the sender is never told who reported them: no DTO built for the sender carries a
//     reporter, a report id or an explanation;
//   • standing is *derived* from the violations still in force, never stored, so revoking one
//     (an accepted appeal) recalculates the account at once.

export const SUSPENSION_MS = 7 * 24 * 60 * 60 * 1000;

const iso = (ms: number) => new Date(ms).toISOString();
const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));

type BottleRow = typeof t.bottles.$inferSelect;
type ViolationRow = typeof t.violations.$inferSelect;

// ---------- who may report what ----------

// The reader's relationship to the letter in front of them: the recipient of a bottle that
// arrived on their shore (sealed or opened), or the finder who holds — or held — a public
// opening. The sender cannot report their own letter. Anything else is "not found" so a report
// can never be used to probe for bottles.
export function readerContextOf(
  db: DbOrTx,
  user: AuthUser,
  bottle: BottleRow,
): 'shore' | 'public' | null {
  if (bottle.senderId === user.id) return null;
  if (bottle.recipientId === user.id && (bottle.state === 'delivered' || bottle.state === 'opened'))
    return 'shore';
  const opening = db
    .select({ openedById: t.publicOpenings.openedById })
    .from(t.publicOpenings)
    .where(eq(t.publicOpenings.bottleId, bottle.id))
    .get();
  if (opening && opening.openedById === user.id) return 'public';
  return null;
}

// ---------- reports and cases ----------

export function reportLetter(
  ctx: AppContext,
  user: AuthUser,
  input: ReportRequest,
): ReportResponse {
  const now = ctx.realClock.now();
  return ctx.db.transaction((tx) => {
    const bottle = tx.select().from(t.bottles).where(eq(t.bottles.id, input.bottleId)).get();
    if (!bottle) throw notFound('letter');
    const context = readerContextOf(tx, user, bottle);
    if (!context) throw notFound('letter');
    const letter = tx.select().from(t.letters).where(eq(t.letters.id, bottle.letterId)).get();
    if (!letter) throw notFound('letter');

    // One case per letter; the first report opens it and freezes the evidence.
    let kase = tx
      .select()
      .from(t.moderationCases)
      .where(eq(t.moderationCases.bottleId, bottle.id))
      .get();
    if (!kase) {
      tx.insert(t.moderationCases)
        .values({
          id: newId('cas'),
          bottleId: bottle.id,
          letterId: letter.id,
          senderId: bottle.senderId,
          recipientId: bottle.recipientId,
          context,
          status: 'pending',
          evidenceText: letter.text,
          evidenceFont: letter.originalFont,
          evidenceCharacters: letter.characters,
          createdAt: now,
          updatedAt: now,
          aiStatus: 'queued',
          aiAttempts: 0,
          aiNextAttemptAt: now,
        })
        .onConflictDoNothing()
        .run();
      kase = tx
        .select()
        .from(t.moderationCases)
        .where(eq(t.moderationCases.bottleId, bottle.id))
        .get()!;
    }

    const existing = tx
      .select()
      .from(t.letterReports)
      .where(and(eq(t.letterReports.caseId, kase.id), eq(t.letterReports.reporterId, user.id)))
      .get();
    if (existing) {
      // Reporting twice changes nothing — except that asking to hide it now is honoured.
      if (input.hide && !existing.hidden) {
        tx.update(t.letterReports)
          .set({ hidden: true })
          .where(eq(t.letterReports.id, existing.id))
          .run();
        endFinderReading(tx, user.id, bottle.id, now);
      }
      return {
        reportId: existing.id,
        caseId: kase.id,
        hidden: existing.hidden || input.hide,
        alreadyReported: true,
      };
    }
    const reportId = newId('rpt');
    tx.insert(t.letterReports)
      .values({
        id: reportId,
        caseId: kase.id,
        reporterId: user.id,
        reason: input.reason,
        explanation: input.explanation?.trim() ? input.explanation.trim() : null,
        context,
        hidden: input.hide,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
    tx.update(t.moderationCases)
      .set({ updatedAt: now })
      .where(eq(t.moderationCases.id, kase.id))
      .run();
    if (input.hide) endFinderReading(tx, user.id, bottle.id, now);
    return { reportId, caseId: kase.id, hidden: input.hide, alreadyReported: false };
  });
}

// A finder who hides a reported letter has ended their one reading of it.
function endFinderReading(tx: DbOrTx, userId: string, bottleId: string, now: number): void {
  tx.update(t.publicOpenings)
    .set({ closedAt: now })
    .where(
      and(
        eq(t.publicOpenings.bottleId, bottleId),
        eq(t.publicOpenings.openedById, userId),
        isNull(t.publicOpenings.closedAt),
      ),
    )
    .run();
}

// Has this reader hidden this letter from their own reads? Checked by every reader path.
export function hiddenByReporter(db: DbOrTx, userId: string, bottleId: string): boolean {
  const row = db
    .select({ hidden: t.letterReports.hidden })
    .from(t.letterReports)
    .innerJoin(t.moderationCases, eq(t.moderationCases.id, t.letterReports.caseId))
    .where(and(eq(t.moderationCases.bottleId, bottleId), eq(t.letterReports.reporterId, userId)))
    .get();
  return row?.hidden === true;
}

// The bottle ids this reader has hidden, for list filters.
export function hiddenBottleIds(db: DbOrTx, userId: string): Set<string> {
  return new Set(
    db
      .select({ bottleId: t.moderationCases.bottleId })
      .from(t.letterReports)
      .innerJoin(t.moderationCases, eq(t.moderationCases.id, t.letterReports.caseId))
      .where(and(eq(t.letterReports.reporterId, userId), eq(t.letterReports.hidden, true)))
      .all()
      .map((r) => r.bottleId),
  );
}

// ---------- violations and standing ----------

export function violationsInForce(db: DbOrTx, userId: string): ViolationRow[] {
  return db
    .select()
    .from(t.violations)
    .where(and(eq(t.violations.userId, userId), isNull(t.violations.revokedAt)))
    .orderBy(asc(t.violations.decidedAt), asc(t.violations.id))
    .all();
}

export interface Standing {
  standing: 'good' | 'warned' | 'suspended' | 'banned';
  suspendedUntil: number | null;
  violationsInForce: number;
}

// Derived, never stored. The count of distinct accepted violations still in force decides:
// one warns, two suspend for seven elapsed days from the second decision, three ban for good.
// After the seven days the account is usable again but still one violation from a ban.
export function standingOf(db: DbOrTx, userId: string, now: number): Standing {
  const inForce = violationsInForce(db, userId);
  const n = inForce.length;
  if (n === 0) return { standing: 'good', suspendedUntil: null, violationsInForce: 0 };
  if (n === 1) return { standing: 'warned', suspendedUntil: null, violationsInForce: 1 };
  if (n === 2) {
    const until = inForce[1]!.decidedAt + SUSPENSION_MS;
    return now < until
      ? { standing: 'suspended', suspendedUntil: until, violationsInForce: 2 }
      : { standing: 'warned', suspendedUntil: null, violationsInForce: 2 };
  }
  return { standing: 'banned', suspendedUntil: null, violationsInForce: n };
}

// May this account use the app beyond signing in, reading its status, appealing and signing out?
export function isRestricted(db: DbOrTx, userId: string, now: number): Standing | null {
  const s = standingOf(db, userId, now);
  return s.standing === 'suspended' || s.standing === 'banned' ? s : null;
}

function noticeOf(db: DbOrTx, v: ViolationRow, ordinal: number): ViolationNoticeDto {
  const bottle = db.select().from(t.bottles).where(eq(t.bottles.id, v.bottleId)).get()!;
  const appeal = db.select().from(t.appeals).where(eq(t.appeals.violationId, v.id)).get();
  return {
    id: v.id,
    ordinal,
    category: v.category as ReportReason,
    decidedAt: iso(v.decidedAt),
    revokedAt: isoOrNull(v.revokedAt),
    acknowledgedAt: isoOrNull(v.acknowledgedAt),
    bottle: {
      id: bottle.id,
      recipientDisplayName: bottle.recipientNameSnapshot,
      releasedAt: iso(bottle.releasedAt),
    },
    appeal: appeal
      ? {
          id: appeal.id,
          status: appeal.status,
          text: appeal.text,
          createdAt: iso(appeal.createdAt),
          decidedAt: isoOrNull(appeal.decidedAt),
        }
      : null,
  };
}

// The sender's own view: their standing, every violation (revoked ones included, as history)
// and the one-time warning still to be acknowledged. No reporter appears anywhere in it.
export function accountStanding(ctx: AppContext, userId: string): AccountStandingDto {
  const now = ctx.realClock.now();
  const s = standingOf(ctx.db, userId, now);
  const all = ctx.db
    .select()
    .from(t.violations)
    .where(eq(t.violations.userId, userId))
    .orderBy(asc(t.violations.decidedAt), asc(t.violations.id))
    .all();
  let ordinal = 0;
  const notices = all.map((v) => noticeOf(ctx.db, v, v.revokedAt === null ? ++ordinal : 0));
  // The first violation's warning: shown once, until acknowledged, as long as it is in force.
  const inForce = notices.filter((n) => n.revokedAt === null);
  const pendingWarning =
    inForce.length >= 1 && inForce[0]!.acknowledgedAt === null ? inForce[0]! : null;
  return {
    standing: s.standing,
    suspendedUntil: isoOrNull(s.suspendedUntil),
    violationsInForce: s.violationsInForce,
    pendingWarning,
    violations: notices,
  };
}

export function acknowledgeWarning(ctx: AppContext, user: AuthUser, violationId: string): void {
  const res = ctx.db
    .update(t.violations)
    .set({ acknowledgedAt: ctx.realClock.now() })
    .where(
      and(
        eq(t.violations.id, violationId),
        eq(t.violations.userId, user.id),
        isNull(t.violations.acknowledgedAt),
      ),
    )
    .run();
  if (res.changes === 0) {
    const exists = ctx.db
      .select({ id: t.violations.id })
      .from(t.violations)
      .where(and(eq(t.violations.id, violationId), eq(t.violations.userId, user.id)))
      .get();
    if (!exists) throw notFound('violation');
  }
}

// ---------- appeals (the sender's side) ----------

export function submitAppeal(
  ctx: AppContext,
  user: AuthUser,
  input: { violationId: string; text: string },
): ViolationNoticeDto {
  const now = ctx.realClock.now();
  return ctx.db.transaction((tx) => {
    const v = tx.select().from(t.violations).where(eq(t.violations.id, input.violationId)).get();
    if (!v || v.userId !== user.id) throw notFound('violation');
    if (v.revokedAt !== null) throw badRequest('already_revoked', 'this violation was revoked');
    const existing = tx.select().from(t.appeals).where(eq(t.appeals.violationId, v.id)).get();
    if (existing) {
      throw conflict(
        'already_appealed',
        existing.status === 'rejected'
          ? 'This decision was appealed and the appeal was rejected; it cannot be appealed again.'
          : 'This violation has already been appealed.',
      );
    }
    tx.insert(t.appeals)
      .values({
        id: newId('apl'),
        violationId: v.id,
        userId: user.id,
        text: input.text.trim(),
        status: 'pending',
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
    // A concurrent duplicate lost the unique index race: report the one that won.
    const ordinal = violationsInForce(tx, user.id).findIndex((x) => x.id === v.id) + 1;
    return noticeOf(tx, v, ordinal);
  });
}

// ---------- the sender's notifications ----------

// One row per event, deduplicated by key: retries and concurrent decisions insert nothing new.
export function notifyStanding(
  tx: DbOrTx,
  userId: string,
  violation: { id: string; recipientName: string },
  standing: Standing,
  now: number,
): void {
  const base = `Your letter to ${violation.recipientName} was reported and, after review, removed for breaking the community rules.`;
  if (standing.standing === 'banned') {
    enqueueNotification(tx, {
      userId,
      type: 'moderation',
      kind: 'moderation_banned',
      bottleId: null,
      dedupeKey: `banned:${violation.id}`,
      message: `${base} This is your third accepted violation: your account is permanently banned. You can still sign in to read this and to appeal.`,
      now,
    });
  } else if (standing.standing === 'suspended') {
    enqueueNotification(tx, {
      userId,
      type: 'moderation',
      kind: 'moderation_suspended',
      bottleId: null,
      dedupeKey: `suspended:${violation.id}`,
      message: `${base} This is your second accepted violation: your account is suspended for seven days, until ${new Date(standing.suspendedUntil!).toUTCString()}. Another accepted violation means a permanent ban.`,
      now,
    });
  } else {
    enqueueNotification(tx, {
      userId,
      type: 'moderation',
      kind: 'moderation_violation',
      bottleId: null,
      dedupeKey: `violation:${violation.id}`,
      message: `${base} This is a warning: a second accepted violation suspends your account for seven days, a third bans it permanently.`,
      now,
    });
  }
}

export function assertNotRestricted(ctx: AppContext, user: AuthUser): void {
  const s = isRestricted(ctx.db, user.id, ctx.realClock.now());
  if (!s) return;
  throw forbidden(
    s.standing === 'banned'
      ? 'This account is permanently banned.'
      : `This account is suspended until ${new Date(s.suspendedUntil!).toUTCString()}.`,
  );
}
