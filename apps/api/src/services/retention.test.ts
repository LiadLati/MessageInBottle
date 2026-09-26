import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import * as t from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import {
  decideAppeal,
  decideCase,
  decideCaseCritical,
  getCase,
  placeHold,
  releaseHold,
} from './admin.js';
import { openBottle } from './bottles.js';
import type { AuthUser } from './context.js';
import { commitArrivalIfDue } from './journey.js';
import { reportLetter, standingOf, submitAppeal, waiveAppeal } from './moderation.js';
import { releaseBottle } from './release.js';
import {
  RETENTION_DEFAULT,
  RETENTION_OFF,
  THIRTY_DAYS_MS,
  applyRetention,
  planRetention,
} from './retention.js';
import { createTestWorld, releaseInput, type TestWorld } from '../test/harness.js';

const DAY = 24 * 60 * 60 * 1000;

function world() {
  const w = createTestWorld({ defaultShoreCapacity: 80 });
  w.db
    .update(t.users)
    .set({ role: 'admin' })
    .where(eq(t.users.id, w.user('cy').id))
    .run();
  return w;
}
const admin = (w: TestWorld): AuthUser => ({ ...w.user('cy'), role: 'admin' });

let keys = 0;
const nextKey = () => `key-${String(++keys).padStart(10, '0')}`;

// A letter from Ada that Bo has opened on their shore.
function deliveredLetter(w: TestWorld): string {
  const id = releaseBottle(w.ctx, w.user('ada'), releaseInput(w.user('bo').id, nextKey())).bottleId;
  w.clock.advance(40 * DAY);
  expect(commitArrivalIfDue(w.ctx, id, w.clock.now())).toBe(true);
  openBottle(w.ctx, w.user('bo'), id);
  return id;
}
function reportedCase(w: TestWorld): string {
  const id = deliveredLetter(w);
  return reportLetter(w.ctx, w.user('bo'), { bottleId: id, reason: 'harassment', hide: false })
    .caseId;
}
const violationOf = (w: TestWorld, caseId: string) =>
  w.db.select().from(t.violations).where(eq(t.violations.caseId, caseId)).get()!;
const caseRow = (w: TestWorld, caseId: string) =>
  w.db.select().from(t.moderationCases).where(eq(t.moderationCases.id, caseId)).get()!;
const planOf = (w: TestWorld, caseId: string) =>
  planRetention(w.db, w.realClock.now(), RETENTION_DEFAULT).cases.find((c) => c.caseId === caseId)!;
const holdOf = (w: TestWorld, caseId: string) => planOf(w, caseId).hold;
const run = (w: TestWorld) => applyRetention(w.db, w.realClock.now(), RETENTION_DEFAULT);
const audits = (w: TestWorld, caseId: string) =>
  w.db
    .select()
    .from(t.moderationAudit)
    .where(eq(t.moderationAudit.caseId, caseId))
    .all()
    .map((a) => a.action);

describe('evidence retention: 30 days after the decision (product decision 5)', () => {
  let w: TestWorld;
  beforeEach(() => {
    w = world();
  });

  it('keeps the evidence of an undecided report indefinitely', () => {
    const caseId = reportedCase(w);
    expect(holdOf(w, caseId)).toBe('case_pending');
    w.realClock.advance(365 * DAY);
    expect(holdOf(w, caseId)).toBe('case_pending');
    expect(run(w).redacted).toEqual([]);
    expect(caseRow(w, caseId).evidenceText).not.toBe('');
  });

  it('redacts a rejected case 30 days after the rejection, and not a moment before', () => {
    const caseId = reportedCase(w);
    const before = caseRow(w, caseId).evidenceText;
    expect(before).not.toBe('');
    decideCase(w.ctx, admin(w), caseId, 'rejected', 'not a violation');

    // The 30 days count from the rejection itself.
    expect(planOf(w, caseId).finalAt).toBe(w.realClock.now());
    expect(holdOf(w, caseId)).toBe('within_window');

    w.realClock.advance(THIRTY_DAYS_MS - 1);
    expect(holdOf(w, caseId)).toBe('within_window');
    expect(run(w).redacted).toEqual([]);
    expect(caseRow(w, caseId).evidenceText).toBe(before);

    w.realClock.advance(1);
    expect(holdOf(w, caseId)).toBeNull();
    expect(run(w).redacted).toEqual([caseId]);
    const after = caseRow(w, caseId);
    expect(after.evidenceText).toBe('');
    expect(after.evidenceRedactedAt).toBe(w.realClock.now());
    expect(audits(w, caseId)).toContain('evidence_redacted');
  });

  it('does not delete the letter itself when a report is rejected', () => {
    const bottleId = deliveredLetter(w);
    const caseId = reportLetter(w.ctx, w.user('bo'), {
      bottleId,
      reason: 'harassment',
      hide: false,
    }).caseId;
    const letterId = caseRow(w, caseId).letterId;
    decideCase(w.ctx, admin(w), caseId, 'rejected', 'not a violation');
    w.realClock.advance(THIRTY_DAYS_MS);
    run(w);

    // Only the moderation copy goes. The original letter and the bottle are untouched, and the
    // letter is readable again under its ordinary rules.
    const letter = w.db.select().from(t.letters).where(eq(t.letters.id, letterId)).get()!;
    expect(letter.text.length).toBeGreaterThan(0);
    const bottle = w.db.select().from(t.bottles).where(eq(t.bottles.id, bottleId)).get()!;
    expect(bottle.moderationStatus).not.toBe('removed');
  });

  it('does not keep evidence forever because the sender never opened the decision', () => {
    const caseId = reportedCase(w);
    decideCase(w.ctx, admin(w), caseId, 'accepted', 'harassment');
    const decidedAt = w.realClock.now();
    // The clock runs from the decision on server time; nobody has to open SeaYou.
    expect(planOf(w, caseId).finalAt).toBe(decidedAt);
    expect(planOf(w, caseId).redactableAt).toBe(decidedAt + THIRTY_DAYS_MS);
    expect(violationOf(w, caseId).noticePresentedAt).toBeNull();
    w.realClock.advance(THIRTY_DAYS_MS - 1);
    expect(holdOf(w, caseId)).toBe('within_window');
    expect(run(w).redacted).toEqual([]);
    w.realClock.advance(1);
    expect(run(w).redacted).toEqual([caseId]);
    expect(caseRow(w, caseId).evidenceText).toBe('');
    // Decision metadata survives the content.
    const v = violationOf(w, caseId);
    expect(v.reason).toBe('harassment');
    expect(v.decidedByUserId).toBe(admin(w).id);
    expect(caseRow(w, caseId).decisionReason).toBe('harassment');
  });

  it('does not shorten the window when the sender waives the appeal', () => {
    const caseId = reportedCase(w);
    decideCase(w.ctx, admin(w), caseId, 'accepted', 'harassment');
    const decidedAt = w.realClock.now();
    const v = violationOf(w, caseId);
    w.realClock.advance(3 * DAY);
    waiveAppeal(w.ctx, w.user('ada'), v.id);
    expect(planOf(w, caseId).redactableAt).toBe(decidedAt + THIRTY_DAYS_MS);
    w.realClock.advance(THIRTY_DAYS_MS - 3 * DAY - 1);
    expect(run(w).redacted).toEqual([]);
    w.realClock.advance(1);
    expect(run(w).redacted).toEqual([caseId]);
  });

  it('keeps the letter unavailable after an upheld case is redacted', () => {
    const bottleId = deliveredLetter(w);
    const caseId = reportLetter(w.ctx, w.user('bo'), {
      bottleId,
      reason: 'harassment',
      hide: false,
    }).caseId;
    decideCase(w.ctx, admin(w), caseId, 'accepted', 'upheld');
    waiveAppeal(w.ctx, w.user('ada'), violationOf(w, caseId).id);
    w.realClock.advance(THIRTY_DAYS_MS);
    expect(run(w).redacted).toEqual([caseId]);

    // The evidence is gone; the withdrawal of the letter is not undone by that.
    const bottle = w.db.select().from(t.bottles).where(eq(t.bottles.id, bottleId)).get()!;
    expect(bottle.moderationStatus).toBe('removed');
    expect(() => openBottle(w.ctx, w.user('bo'), bottleId)).toThrow(AppError);
  });

  it('keeps evidence for a timely appeal past 30 days, and redacts once it is decided', () => {
    const caseId = reportedCase(w);
    decideCase(w.ctx, admin(w), caseId, 'accepted', 'harassment');
    const v = violationOf(w, caseId);
    w.realClock.advance(29 * DAY);
    submitAppeal(w.ctx, w.user('ada'), { violationId: v.id, text: 'please reconsider' });
    expect(holdOf(w, caseId)).toBe('appeal_pending');
    w.realClock.advance(100 * DAY);
    expect(holdOf(w, caseId)).toBe('appeal_pending');
    expect(run(w).redacted).toEqual([]);

    const appeal = w.db.select().from(t.appeals).where(eq(t.appeals.violationId, v.id)).get()!;
    decideAppeal(w.ctx, admin(w), appeal.id, 'rejected', 'the decision stands');
    // Already more than 30 days after the decision: redactable as soon as the appeal is decided.
    expect(planOf(w, caseId).redactableAt).toBe(w.realClock.now());
    expect(run(w).redacted).toEqual([caseId]);
  });

  it('keeps evidence the full 30 days when an early appeal is decided quickly', () => {
    const caseId = reportedCase(w);
    decideCase(w.ctx, admin(w), caseId, 'accepted', 'harassment');
    const decidedAt = w.realClock.now();
    const v = violationOf(w, caseId);
    submitAppeal(w.ctx, w.user('ada'), { violationId: v.id, text: 'please reconsider' });
    w.realClock.advance(DAY);
    const appeal = w.db.select().from(t.appeals).where(eq(t.appeals.violationId, v.id)).get()!;
    decideAppeal(w.ctx, admin(w), appeal.id, 'rejected', 'the decision stands');
    expect(planOf(w, caseId).redactableAt).toBe(decidedAt + THIRTY_DAYS_MS);
  });

  it('clears the model translation and reasoning with the evidence, and keeps its verdict', () => {
    const caseId = reportedCase(w);
    w.db
      .update(t.moderationCases)
      .set({
        aiStatus: 'done',
        aiVerdict: 'uncertain',
        aiReason: 'quotes the letter',
        aiTranslation: 'the letter in English',
        aiUncertainty: 'slang',
      })
      .where(eq(t.moderationCases.id, caseId))
      .run();
    decideCase(w.ctx, admin(w), caseId, 'rejected', 'not a violation');
    w.realClock.advance(THIRTY_DAYS_MS);
    expect(run(w).redacted).toEqual([caseId]);
    const row = caseRow(w, caseId);
    expect([row.aiTranslation, row.aiReason, row.aiUncertainty]).toEqual([null, null, null]);
    expect(row.aiVerdict).toBe('uncertain');
  });

  it('restores the letter on an accepted appeal, then redacts only the moderation evidence', () => {
    const bottleId = deliveredLetter(w);
    const caseId = reportLetter(w.ctx, w.user('bo'), {
      bottleId,
      reason: 'harassment',
      hide: false,
    }).caseId;
    const letterId = caseRow(w, caseId).letterId;
    decideCase(w.ctx, admin(w), caseId, 'accepted', 'upheld');
    const v = violationOf(w, caseId);
    submitAppeal(w.ctx, w.user('ada'), { violationId: v.id, text: 'it was quoted out of context' });
    const appeal = w.db.select().from(t.appeals).where(eq(t.appeals.violationId, v.id)).get()!;
    decideAppeal(w.ctx, admin(w), appeal.id, 'accepted', 'on reflection, not a violation');

    // The letter comes back, and the account is clear again.
    const bottle = w.db.select().from(t.bottles).where(eq(t.bottles.id, bottleId)).get()!;
    expect(bottle.moderationStatus).toBe('clear');
    expect(standingOf(w.db, w.user('ada').id, w.realClock.now()).standing).toBe('good');

    w.realClock.advance(THIRTY_DAYS_MS);
    expect(run(w).redacted).toEqual([caseId]);
    // Only the evidence copy went: the letter people legitimately hold is still there.
    expect(caseRow(w, caseId).evidenceText).toBe('');
    const letter = w.db.select().from(t.letters).where(eq(t.letters.id, letterId)).get()!;
    expect(letter.text.length).toBeGreaterThan(0);
  });

  it('clears the reporters’ explanations but keeps who reported', () => {
    const bottleId = deliveredLetter(w);
    const caseId = reportLetter(w.ctx, w.user('bo'), {
      bottleId,
      reason: 'harassment',
      hide: false,
      explanation: 'he quoted my address back at me',
    }).caseId;
    decideCase(w.ctx, admin(w), caseId, 'rejected', 'not a violation');
    w.realClock.advance(THIRTY_DAYS_MS);
    run(w);
    const report = w.db
      .select()
      .from(t.letterReports)
      .where(eq(t.letterReports.caseId, caseId))
      .get()!;
    expect(report.explanation).toBeNull();
    // Kept: it is what stops one person reporting the same letter twice, and what makes a
    // pattern of abusive reporting visible. It is never shown to the sender.
    expect(report.reporterId).toBe(w.user('bo').id);
  });

  it('is idempotent: a second run changes nothing', () => {
    const caseId = reportedCase(w);
    decideCase(w.ctx, admin(w), caseId, 'rejected', 'not a violation');
    w.realClock.advance(THIRTY_DAYS_MS);
    expect(run(w).redacted).toEqual([caseId]);
    const redactedAt = caseRow(w, caseId).evidenceRedactedAt;
    const auditCount = audits(w, caseId).length;

    w.realClock.advance(DAY);
    expect(run(w).redacted).toEqual([]);
    expect(caseRow(w, caseId).evidenceRedactedAt).toBe(redactedAt);
    expect(audits(w, caseId)).toHaveLength(auditCount);
    expect(holdOf(w, caseId)).toBe('already_redacted');
  });

  it('can be disabled, and then plans without changing anything', () => {
    const caseId = reportedCase(w);
    decideCase(w.ctx, admin(w), caseId, 'rejected', 'not a violation');
    w.realClock.advance(THIRTY_DAYS_MS);

    const plan = planRetention(w.db, w.realClock.now(), RETENTION_OFF);
    expect(plan.redactable).toEqual([caseId]);
    const result = applyRetention(w.db, w.realClock.now(), RETENTION_OFF);
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/disabled/);
    expect(caseRow(w, caseId).evidenceText).not.toBe('');
  });
});

describe('legal and child-safety holds', () => {
  let w: TestWorld;
  beforeEach(() => {
    w = world();
  });

  it('keeps evidence past 30 days, and releases back to the ordinary calculation', () => {
    const caseId = reportedCase(w);
    decideCase(w.ctx, admin(w), caseId, 'rejected', 'not a violation');
    placeHold(w.ctx, admin(w), caseId, 'legal', 'preservation request 2026-04, ref 118');

    w.realClock.advance(40 * DAY);
    expect(holdOf(w, caseId)).toBe('legal_hold');
    expect(run(w).redacted).toEqual([]);
    expect(caseRow(w, caseId).evidenceText).not.toBe('');

    // The hold records why, who and when — there is no undocumented way to keep evidence.
    const row = caseRow(w, caseId);
    expect(row.holdReason).toBe('legal');
    expect(row.holdNote).toBe('preservation request 2026-04, ref 118');
    expect(row.holdByUserId).toBe(admin(w).id);
    expect(row.holdAt).not.toBeNull();
    expect(audits(w, caseId)).toContain('hold_placed');

    releaseHold(w.ctx, admin(w), caseId);
    expect(audits(w, caseId)).toContain('hold_released');
    // Already well past seven days after finality, so it goes on the next run.
    expect(holdOf(w, caseId)).toBeNull();
    expect(run(w).redacted).toEqual([caseId]);
  });

  it('a child-safety hold works the same way and is distinguishable', () => {
    const caseId = reportedCase(w);
    decideCase(w.ctx, admin(w), caseId, 'rejected', 'not a violation');
    placeHold(w.ctx, admin(w), caseId, 'child_safety', 'referred for review, do not redact');
    w.realClock.advance(60 * DAY);
    expect(holdOf(w, caseId)).toBe('child_safety_hold');
    expect(run(w).redacted).toEqual([]);
  });

  it('refuses a hold with no documented reason, and refuses to release one that is not there', () => {
    const caseId = reportedCase(w);
    expect(() => placeHold(w.ctx, admin(w), caseId, 'legal', '   ')).toThrow(AppError);
    expect(() => releaseHold(w.ctx, admin(w), caseId)).toThrow(AppError);
    expect(caseRow(w, caseId).holdReason).toBeNull();
  });

  it('reports the hold and the timetable to the administrator', () => {
    const caseId = reportedCase(w);
    decideCase(w.ctx, admin(w), caseId, 'rejected', 'not a violation');
    const detail = getCase(w.ctx, caseId);
    expect(detail.retention.finalAt).not.toBeNull();
    expect(detail.retention.redactableAt).not.toBeNull();
    expect(detail.hold).toBeNull();
    placeHold(w.ctx, admin(w), caseId, 'legal', 'ref 118');
    expect(getCase(w.ctx, caseId).hold).toMatchObject({ reason: 'legal', note: 'ref 118' });
    expect(getCase(w.ctx, caseId).retention.hold).toBe('legal_hold');
  });
});

describe('critical child-safety enforcement', () => {
  let w: TestWorld;
  beforeEach(() => {
    w = world();
  });

  it('bans immediately on the first violation, with the reason and actor recorded', () => {
    const caseId = reportedCase(w);
    const detail = decideCaseCritical(w.ctx, admin(w), caseId, 'confirmed CSAM, referred');

    expect(standingOf(w.db, w.user('ada').id, w.realClock.now())).toMatchObject({
      standing: 'banned',
      violationsInForce: 1,
    });
    const v = violationOf(w, caseId);
    expect(v.severity).toBe('critical');
    expect(v.decidedBy).toBe('admin');
    expect(v.decidedByUserId).toBe(admin(w).id);
    expect(v.reason).toBe('confirmed CSAM, referred');
    expect(detail.violation).toMatchObject({ severity: 'critical' });

    const audit = w.db
      .select()
      .from(t.moderationAudit)
      .where(eq(t.moderationAudit.caseId, caseId))
      .all()
      .find((a) => a.action === 'critical_child_safety')!;
    expect(audit.actorUserId).toBe(admin(w).id);
    expect(audit.actorRole).toBe('admin');
    expect(audit.reason).toBe('confirmed CSAM, referred');
    expect(audit.subjectUserId).toBe(w.user('ada').id);
    expect(audit.createdAt).toBe(w.realClock.now());
  });

  it('requires a reason', () => {
    const caseId = reportedCase(w);
    expect(() => decideCaseCritical(w.ctx, admin(w), caseId, '   ')).toThrow(AppError);
    expect(caseRow(w, caseId).status).toBe('pending');
    expect(standingOf(w.db, w.user('ada').id, w.realClock.now()).standing).toBe('good');
  });

  it('preserves the single appeal, and an accepted appeal lifts the ban', () => {
    const caseId = reportedCase(w);
    decideCaseCritical(w.ctx, admin(w), caseId, 'confirmed');
    const v = violationOf(w, caseId);

    submitAppeal(w.ctx, w.user('ada'), { violationId: v.id, text: 'this was a disclosure' });
    const appeal = w.db.select().from(t.appeals).where(eq(t.appeals.violationId, v.id)).get()!;
    decideAppeal(w.ctx, admin(w), appeal.id, 'accepted', 'good-faith victim disclosure');

    expect(standingOf(w.db, w.user('ada').id, w.realClock.now()).standing).toBe('good');
    expect(violationOf(w, caseId).revokedAt).not.toBeNull();
  });

  it('can escalate a case an administrator already upheld the ordinary way', () => {
    const caseId = reportedCase(w);
    decideCase(w.ctx, admin(w), caseId, 'accepted', 'first look');
    expect(standingOf(w.db, w.user('ada').id, w.realClock.now()).standing).toBe('warned');
    decideCaseCritical(w.ctx, admin(w), caseId, 'on review, confirmed child-safety material');
    expect(standingOf(w.db, w.user('ada').id, w.realClock.now()).standing).toBe('banned');
    // Still one violation: escalating a case does not invent a second one.
    expect(standingOf(w.db, w.user('ada').id, w.realClock.now()).violationsInForce).toBe(1);
  });

  it('refuses to classify a rejected case', () => {
    const caseId = reportedCase(w);
    decideCase(w.ctx, admin(w), caseId, 'rejected', 'not a violation');
    expect(() => decideCaseCritical(w.ctx, admin(w), caseId, 'reason')).toThrow(AppError);
  });
});
