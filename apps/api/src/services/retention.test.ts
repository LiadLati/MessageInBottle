import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import * as t from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { decideAppeal, decideCase, getCase } from './admin.js';
import { openBottle } from './bottles.js';
import type { AuthUser } from './context.js';
import { commitArrivalIfDue } from './journey.js';
import { reportLetter, standingOf, submitAppeal } from './moderation.js';
import { releaseBottle } from './release.js';
import { RETENTION_OFF, applyRetention, planRetention, type RetentionPolicy } from './retention.js';
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

// A policy that would remove everything the moment it is allowed to, so that a case still
// held under it is held by the safety rules rather than by a long window.
const AGGRESSIVE: RetentionPolicy = {
  enabled: true,
  rejectedAfterMs: 0,
  acceptedAfterMs: 0,
  appealWindowMs: 1 * DAY,
};
const holdOf = (w: TestWorld, caseId: string, policy: RetentionPolicy) =>
  planRetention(w.db, w.realClock.now(), policy).cases.find((c) => c.caseId === caseId)?.hold;

describe('evidence retention', () => {
  let w: TestWorld;
  beforeEach(() => {
    w = world();
  });

  it('never redacts anything under the shipped defaults', () => {
    const caseId = reportedCase(w);
    decideCase(w.ctx, admin(w), caseId, 'rejected', 'not a violation');
    w.realClock.advance(365 * DAY);
    const plan = planRetention(w.db, w.realClock.now(), RETENTION_OFF);
    expect(plan.redactable).toEqual([]);
    expect(holdOf(w, caseId, RETENTION_OFF)).toBe('no_policy');
  });

  it('holds a case nobody has decided yet, however old it is', () => {
    const caseId = reportedCase(w);
    w.realClock.advance(365 * DAY);
    expect(holdOf(w, caseId, AGGRESSIVE)).toBe('case_pending');
    expect(applyRetention(w.db, w.realClock.now(), AGGRESSIVE).redacted).toEqual([]);
    expect(getCase(w.ctx, caseId).letter.text.length).toBeGreaterThan(0);
  });

  it('holds a decided case while a model review is still in flight', () => {
    const caseId = reportedCase(w);
    decideCase(w.ctx, admin(w), caseId, 'rejected', 'fine');
    w.db
      .update(t.moderationCases)
      .set({ aiStatus: 'running' })
      .where(eq(t.moderationCases.id, caseId))
      .run();
    w.realClock.advance(365 * DAY);
    expect(holdOf(w, caseId, AGGRESSIVE)).toBe('ai_in_queue');
  });

  it('holds an accepted case while its violation is still in force', () => {
    const caseId = reportedCase(w);
    decideCase(w.ctx, admin(w), caseId, 'accepted', 'threats');
    w.realClock.advance(365 * DAY);
    // The appeal deadline has passed, but the sanction it justifies has not been lifted.
    expect(holdOf(w, caseId, AGGRESSIVE)).toBe('violation_in_force');
    expect(applyRetention(w.db, w.realClock.now(), AGGRESSIVE).redacted).toEqual([]);
  });

  it('holds an accepted case while the sender can still appeal', () => {
    const caseId = reportedCase(w);
    decideCase(w.ctx, admin(w), caseId, 'accepted', 'threats');
    w.realClock.advance(1000);
    expect(holdOf(w, caseId, AGGRESSIVE)).toBe('appeal_open');
  });

  it('holds a case whose appeal is waiting to be decided', () => {
    const caseId = reportedCase(w);
    decideCase(w.ctx, admin(w), caseId, 'accepted', 'threats');
    const violation = w.db
      .select()
      .from(t.violations)
      .where(eq(t.violations.caseId, caseId))
      .get()!;
    submitAppeal(w.ctx, w.user('ada'), { violationId: violation.id, text: 'it was a joke' });
    w.realClock.advance(365 * DAY);
    expect(holdOf(w, caseId, AGGRESSIVE)).toBe('appeal_pending');
    expect(applyRetention(w.db, w.realClock.now(), AGGRESSIVE).redacted).toEqual([]);
  });

  it('holds a case whose appeal was rejected, because the sanction stands', () => {
    const caseId = reportedCase(w);
    decideCase(w.ctx, admin(w), caseId, 'accepted', 'threats');
    const violation = w.db
      .select()
      .from(t.violations)
      .where(eq(t.violations.caseId, caseId))
      .get()!;
    const appeal = submitAppeal(w.ctx, w.user('ada'), {
      violationId: violation.id,
      text: 'please reconsider',
    }).appeal!;
    decideAppeal(w.ctx, admin(w), appeal.id, 'rejected', 'stands');
    w.realClock.advance(365 * DAY);
    expect(holdOf(w, caseId, AGGRESSIVE)).toBe('violation_in_force');
  });

  it('redacts a rejected case only once the window has passed', () => {
    const caseId = reportedCase(w);
    decideCase(w.ctx, admin(w), caseId, 'rejected', 'not a violation');
    const policy: RetentionPolicy = { ...RETENTION_OFF, enabled: true, rejectedAfterMs: 30 * DAY };
    w.realClock.advance(29 * DAY);
    expect(holdOf(w, caseId, policy)).toBe('within_window');
    expect(applyRetention(w.db, w.realClock.now(), policy).redacted).toEqual([]);

    w.realClock.advance(2 * DAY);
    expect(holdOf(w, caseId, policy)).toBeNull();
    expect(applyRetention(w.db, w.realClock.now(), policy).redacted).toEqual([caseId]);

    // The case survives; only the copied letter and the reporters' words are gone.
    const detail = getCase(w.ctx, caseId);
    expect(detail.letter.text).toBe('');
    expect(detail.letter.redactedAt).not.toBeNull();
    expect(detail.status).toBe('rejected');
    expect(detail.decision?.reason).toBe('not a violation');
    expect(detail.reports[0]!.explanation).toBeNull();
    expect(detail.reports[0]!.reporter.username).toBe('bo');
  });

  it('redacts an accepted case once the violation is revoked and the window has passed', () => {
    const caseId = reportedCase(w);
    decideCase(w.ctx, admin(w), caseId, 'accepted', 'threats');
    const violation = w.db
      .select()
      .from(t.violations)
      .where(eq(t.violations.caseId, caseId))
      .get()!;
    const appeal = submitAppeal(w.ctx, w.user('ada'), {
      violationId: violation.id,
      text: 'context was missing',
    }).appeal!;
    w.realClock.advance(60_000);
    decideAppeal(w.ctx, admin(w), appeal.id, 'accepted', 'fair point');
    // The account is clear again, so nothing depends on the evidence any more.
    expect(standingOf(w.db, w.user('ada').id, w.realClock.now()).standing).toBe('good');

    const policy: RetentionPolicy = { ...AGGRESSIVE, acceptedAfterMs: 30 * DAY };
    expect(holdOf(w, caseId, policy)).toBe('within_window');
    w.realClock.advance(31 * DAY);
    expect(applyRetention(w.db, w.realClock.now(), policy).redacted).toEqual([caseId]);
    expect(getCase(w.ctx, caseId).letter.text).toBe('');
  });

  it('refuses to change anything while retention is disabled', () => {
    const caseId = reportedCase(w);
    decideCase(w.ctx, admin(w), caseId, 'rejected', 'fine');
    w.realClock.advance(365 * DAY);
    const policy: RetentionPolicy = { ...AGGRESSIVE, enabled: false };
    // The plan still reports what would go, so a policy can be reviewed before it is enabled.
    expect(planRetention(w.db, w.realClock.now(), policy).redactable).toEqual([caseId]);
    const result = applyRetention(w.db, w.realClock.now(), policy);
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/disabled/);
    expect(getCase(w.ctx, caseId).letter.text.length).toBeGreaterThan(0);
  });

  it('redacts each case once and leaves an already redacted one alone', () => {
    const caseId = reportedCase(w);
    decideCase(w.ctx, admin(w), caseId, 'rejected', 'fine');
    w.realClock.advance(365 * DAY);
    expect(applyRetention(w.db, w.realClock.now(), AGGRESSIVE).redacted).toEqual([caseId]);
    const at = getCase(w.ctx, caseId).letter.redactedAt;
    w.realClock.advance(DAY);
    expect(applyRetention(w.db, w.realClock.now(), AGGRESSIVE).redacted).toEqual([]);
    expect(holdOf(w, caseId, AGGRESSIVE)).toBe('already_redacted');
    expect(getCase(w.ctx, caseId).letter.redactedAt).toBe(at);
  });
});

describe('appeal deadline', () => {
  it('is unlimited by default', () => {
    const w = world();
    const caseId = reportedCase(w);
    decideCase(w.ctx, admin(w), caseId, 'accepted', 'threats');
    const v = w.db.select().from(t.violations).where(eq(t.violations.caseId, caseId)).get()!;
    w.realClock.advance(5 * 365 * DAY);
    expect(() =>
      submitAppeal(w.ctx, w.user('ada'), { violationId: v.id, text: 'late but true' }),
    ).not.toThrow();
  });

  it('closes for a warned account once a configured deadline passes', () => {
    const w = createTestWorld({
      defaultShoreCapacity: 80,
      retention: { ...RETENTION_OFF, appealWindowMs: 30 * DAY },
    });
    w.db
      .update(t.users)
      .set({ role: 'admin' })
      .where(eq(t.users.id, w.user('cy').id))
      .run();
    const caseId = reportedCase(w);
    decideCase(w.ctx, admin(w), caseId, 'accepted', 'threats');
    const v = w.db.select().from(t.violations).where(eq(t.violations.caseId, caseId)).get()!;
    w.realClock.advance(31 * DAY);
    expect(standingOf(w.db, w.user('ada').id, w.realClock.now()).standing).toBe('warned');
    const err = (() => {
      try {
        submitAppeal(w.ctx, w.user('ada'), { violationId: v.id, text: 'too late' });
        return null;
      } catch (e) {
        return e as AppError;
      }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect(err!.code).toBe('appeal_window_closed');
  });

  it('never closes while the account is suspended or banned', () => {
    const w = createTestWorld({
      defaultShoreCapacity: 80,
      retention: { ...RETENTION_OFF, appealWindowMs: 1 * DAY },
    });
    w.db
      .update(t.users)
      .set({ role: 'admin' })
      .where(eq(t.users.id, w.user('cy').id))
      .run();
    const first = reportedCase(w);
    decideCase(w.ctx, admin(w), first, 'accepted', 'one');
    const second = reportedCase(w);
    decideCase(w.ctx, admin(w), second, 'accepted', 'two');
    expect(standingOf(w.db, w.user('ada').id, w.realClock.now()).standing).toBe('suspended');

    const v = w.db.select().from(t.violations).where(eq(t.violations.caseId, second)).get()!;
    w.realClock.advance(2 * DAY);
    // Well past the deadline, but appealing is the only move a suspended account has left.
    expect(() =>
      submitAppeal(w.ctx, w.user('ada'), { violationId: v.id, text: 'hear me out' }),
    ).not.toThrow();
  });
});
