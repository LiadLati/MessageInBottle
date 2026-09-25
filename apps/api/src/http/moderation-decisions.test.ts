import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { AccountStandingDto, AdminCaseDetailDto } from '@mib/shared';
import { APPEAL_WINDOW_MS } from '@mib/shared';
import * as t from '../db/schema.js';
import { createApp } from './app.js';
import { openBottle } from '../services/bottles.js';
import { commitArrivalIfDue } from '../services/journey.js';
import { reportLetter } from '../services/moderation.js';
import { releaseBottle } from '../services/release.js';
import {
  createTestWorld,
  evidenceDigest,
  loginAs,
  releaseInput,
  type TestWorld,
} from '../test/harness.js';

// Product decisions 1, 2 and 5: every administrator decision is a person's, with a reason and
// a stated consequence; decisions are final except through the sender's single appeal, which
// must come within 30 days; a critical child-safety confirmation bans at once and still leaves
// one appeal — reopened if the ordinary appeal was already given up.

const DAY = 24 * 60 * 60 * 1000;
const json = (token: string) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
});

async function setup() {
  const w = createTestWorld({ defaultShoreCapacity: 80 });
  w.db
    .update(t.users)
    .set({ role: 'admin' })
    .where(eq(t.users.id, w.user('cy').id))
    .run();
  const app = createApp(w.ctx);
  const cy = await loginAs(app, 'cy');
  return { w, app, cy };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

let n = 0;
function reportedCase(w: TestWorld): string {
  const id = releaseBottle(
    w.ctx,
    w.user('ada'),
    releaseInput(w.user('bo').id, `decisions-${String(++n).padStart(8, '0')}`),
  ).bottleId;
  w.clock.advance(60 * DAY);
  commitArrivalIfDue(w.ctx, id, w.clock.now());
  openBottle(w.ctx, w.user('bo'), id);
  return reportLetter(w.ctx, w.user('bo'), { bottleId: id, reason: 'sexual', hide: false }).caseId;
}

const post = (c: Ctx, path: string, body: unknown, token = c.cy.token) =>
  c.app.request(path, { method: 'POST', headers: json(token), body: JSON.stringify(body) });
const caseOf = async (c: Ctx, id: string) =>
  (
    (await (
      await c.app.request(`/api/admin/reports/${id}`, { headers: json(c.cy.token) })
    ).json()) as {
      case: AdminCaseDetailDto;
    }
  ).case;
const standing = async (c: Ctx, token: string) =>
  (await (
    await c.app.request('/api/moderation/standing', { headers: json(token) })
  ).json()) as AccountStandingDto;
const violationOf = (w: TestWorld, caseId: string) =>
  w.db.select().from(t.violations).where(eq(t.violations.caseId, caseId)).get()!;
const audit = (w: TestWorld, caseId: string) =>
  w.db.select().from(t.moderationAudit).where(eq(t.moderationAudit.caseId, caseId)).all();

describe('the three administrator decisions', () => {
  it('rejects a report, with a reason, and records no violation', async () => {
    const c = await setup();
    const id = reportedCase(c.w);
    const res = await post(c, `/api/admin/reports/${id}/reject`, {
      reason: 'a quotation, not a threat',
      evidenceDigest: evidenceDigest(c.w, id),
    });
    expect(res.status).toBe(200);
    const kase = await caseOf(c, id);
    expect(kase.status).toBe('rejected');
    expect(kase.decision).toMatchObject({ by: 'admin', reason: 'a quotation, not a threat' });
    expect(c.w.db.select().from(t.violations).all()).toEqual([]);
  });

  it('upholds an ordinary violation after showing its consequence', async () => {
    const c = await setup();
    const id = reportedCase(c.w);
    // The administrator sees what upholding will do before confirming it.
    expect((await caseOf(c, id)).consequence.ifUpheld).toBe('warning');
    const res = await post(c, `/api/admin/reports/${id}/accept`, {
      reason: 'harassment',
      evidenceDigest: evidenceDigest(c.w, id),
    });
    expect(res.status).toBe(200);
    const v = violationOf(c.w, id);
    expect(v.severity).toBe('standard');
    expect(v.decidedByUserId).toBe(c.w.user('cy').id);
  });

  it('confirms a critical child-safety violation straight from the report', async () => {
    const c = await setup();
    const id = reportedCase(c.w);
    const withoutReason = await post(c, `/api/admin/reports/${id}/critical`, {
      reason: '  ',
      classification: 'critical_child_safety',
      evidenceDigest: evidenceDigest(c.w, id),
    });
    expect(withoutReason.status).toBe(400);
    const res = await post(c, `/api/admin/reports/${id}/critical`, {
      reason: 'sexualisation of a minor, confirmed on review',
      classification: 'critical_child_safety',
      evidenceDigest: evidenceDigest(c.w, id),
    });
    expect(res.status).toBe(200);
    const v = violationOf(c.w, id);
    expect(v.severity).toBe('critical');
    // Banned at once, on the first violation.
    const ada = await loginAs(c.app, 'ada');
    const s = await standing(c, ada.token);
    expect(s.standing).toBe('banned');
    // The letter is withdrawn from reading, and its shore place released.
    const bottle = c.w.db.select().from(t.bottles).where(eq(t.bottles.id, v.bottleId)).get()!;
    expect(bottle.moderationStatus).toBe('removed');
    const held = c.w.db
      .select()
      .from(t.capacityReservations)
      .where(eq(t.capacityReservations.bottleId, v.bottleId))
      .get();
    expect(held?.status ?? 'released').toBe('released');
    // The audit records who, when, the classification, the reason and the action.
    const row = audit(c.w, id).find((a) => a.action === 'critical_child_safety')!;
    expect(row.actorUserId).toBe(c.w.user('cy').id);
    expect(row.reason).toBe('sexualisation of a minor, confirmed on review');
    expect(row.createdAt).toBe(c.w.realClock.now());
    expect(JSON.parse(row.detail!)).toMatchObject({
      classification: 'critical_child_safety',
      action: 'permanent_ban',
    });
    // One appeal remains.
    expect(s.pendingDecision?.id).toBe(v.id);
    expect(s.pendingDecision?.appealAvailable).toBe(true);
    // The notice says what happened, not "third violation".
    const notice = c.w.db
      .select()
      .from(t.notifications)
      .where(eq(t.notifications.userId, c.w.user('ada').id))
      .all()
      .find((x) => x.kind === 'moderation_banned')!;
    expect(notice.message).toMatch(/critical child-safety violation/);
    expect(notice.message).not.toMatch(/third/);
  });

  it('requires a reason to decide an appeal either way', async () => {
    const c = await setup();
    const id = reportedCase(c.w);
    await post(c, `/api/admin/reports/${id}/accept`, {
      reason: 'harassment',
      evidenceDigest: evidenceDigest(c.w, id),
    });
    const ada = await loginAs(c.app, 'ada');
    const v = violationOf(c.w, id);
    expect(
      (await post(c, '/api/moderation/appeals', { violationId: v.id, text: 'context' }, ada.token))
        .status,
    ).toBe(201);
    const appeal = c.w.db.select().from(t.appeals).where(eq(t.appeals.violationId, v.id)).get()!;
    for (const outcome of ['accept', 'reject'])
      expect((await post(c, `/api/admin/appeals/${appeal.id}/${outcome}`, {})).status).toBe(400);
    expect(
      (await post(c, `/api/admin/appeals/${appeal.id}/reject`, { reason: 'stands' })).status,
    ).toBe(200);
  });
});

describe('decisions are final outside the appeal (product decision 1)', () => {
  it('offers no administrator route that revokes, reopens or reverses a decision', () => {
    const app = createApp(createTestWorld().ctx);
    const adminRoutes = app.routes
      .filter((r) => r.path.startsWith('/api/admin') && r.method !== 'ALL')
      .map((r) => `${r.method} ${r.path}`);
    for (const route of adminRoutes) expect(route).not.toMatch(/revoke|reopen|reverse|undo/);
    // The only ways a violation stops counting are the sender's appeal being accepted.
    expect(adminRoutes).toContain('POST /api/admin/appeals/:id/accept');
  });

  it('refuses to decide an already decided case again', async () => {
    const c = await setup();
    const id = reportedCase(c.w);
    const digest = evidenceDigest(c.w, id);
    await post(c, `/api/admin/reports/${id}/accept`, {
      reason: 'harassment',
      evidenceDigest: digest,
    });
    const again = await post(c, `/api/admin/reports/${id}/reject`, {
      reason: 'changed my mind',
      evidenceDigest: digest,
    });
    expect(again.status).toBe(409);
  });
});

describe('the 30-day appeal window (product decision 5)', () => {
  it('runs from the decision on server time, then shows the decision as final', async () => {
    const c = await setup();
    const id = reportedCase(c.w);
    await post(c, `/api/admin/reports/${id}/accept`, {
      reason: 'harassment',
      evidenceDigest: evidenceDigest(c.w, id),
    });
    const decidedAt = c.w.realClock.now();
    const v = violationOf(c.w, id);
    // The sender never opens SeaYou; the window runs anyway.
    c.w.realClock.advance(APPEAL_WINDOW_MS - 1);
    let ada = await loginAs(c.app, 'ada');
    let s = await standing(c, ada.token);
    expect(s.pendingDecision?.appealAvailable).toBe(true);
    expect(s.pendingDecision?.appealDeadlineAt).toBe(
      new Date(decidedAt + APPEAL_WINDOW_MS).toISOString(),
    );

    c.w.realClock.advance(1);
    ada = await loginAs(c.app, 'ada');
    s = await standing(c, ada.token);
    // Still shown once, now saying the appeal period has ended.
    expect(s.pendingDecision?.id).toBe(v.id);
    expect(s.pendingDecision?.appealAvailable).toBe(false);
    expect(s.pendingDecision?.appealExpired).toBe(true);
    const late = await post(
      c,
      '/api/moderation/appeals',
      { violationId: v.id, text: 'late' },
      ada.token,
    );
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: { code: string } }).error.code).toBe('appeal_expired');
    // Acknowledging it closes the notice; the violation stays in force.
    await post(c, `/api/moderation/violations/${v.id}/acknowledge`, {}, ada.token);
    s = await standing(c, ada.token);
    expect(s.pendingDecision).toBeNull();
    expect(s.violationsInForce).toBe(1);
  });

  it('accepts an appeal on the last day and keeps its evidence until it is decided', async () => {
    const c = await setup();
    const id = reportedCase(c.w);
    await post(c, `/api/admin/reports/${id}/accept`, {
      reason: 'harassment',
      evidenceDigest: evidenceDigest(c.w, id),
    });
    c.w.realClock.advance(APPEAL_WINDOW_MS - DAY);
    const ada = await loginAs(c.app, 'ada');
    const v = violationOf(c.w, id);
    expect(
      (await post(c, '/api/moderation/appeals', { violationId: v.id, text: 'context' }, ada.token))
        .status,
    ).toBe(201);
    c.w.realClock.advance(10 * DAY);
    c.cy = await loginAs(c.app, 'cy'); // test sessions last an hour of real time
    const kase = await caseOf(c, id);
    expect(kase.retention.hold).toBe('appeal_pending');
    expect(kase.letter.text).not.toBe('');
  });
});

describe('escalation to a critical ban after the appeal was given up (product decision 2)', () => {
  it('opens exactly one new appeal opportunity, recorded in the audit', async () => {
    const c = await setup();
    const id = reportedCase(c.w);
    const digest = evidenceDigest(c.w, id);
    await post(c, `/api/admin/reports/${id}/accept`, {
      reason: 'harassment',
      evidenceDigest: digest,
    });
    const ada = await loginAs(c.app, 'ada');
    const v = violationOf(c.w, id);
    await post(c, '/api/moderation/appeals/waive', { violationId: v.id }, ada.token);
    expect((await standing(c, ada.token)).pendingDecision).toBeNull();

    c.w.realClock.advance(5 * DAY);
    c.cy = await loginAs(c.app, 'cy'); // test sessions last an hour of real time
    const ada2 = await loginAs(c.app, 'ada');
    const res = await post(c, `/api/admin/reports/${id}/critical`, {
      reason: 'grooming, confirmed on further review',
      classification: 'critical_child_safety',
      evidenceDigest: digest,
    });
    expect(res.status).toBe(200);
    const after = violationOf(c.w, id);
    expect(after.appealWaivedAt).toBeNull();
    expect(after.appealReopenedAt).toBe(c.w.realClock.now());
    expect(after.appealWindowStartsAt).toBe(c.w.realClock.now());
    expect(audit(c.w, id).map((a) => a.action)).toContain('appeal_reopened');

    const s = await standing(c, ada2.token);
    expect(s.standing).toBe('banned');
    expect(s.pendingDecision?.appealAvailable).toBe(true);
    expect(s.pendingDecision?.appealReopenedAt).not.toBeNull();
    // One opportunity: once used, it is gone.
    expect(
      (await post(c, '/api/moderation/appeals', { violationId: v.id, text: 'please' }, ada2.token))
        .status,
    ).toBe(201);
    expect(
      (await post(c, '/api/moderation/appeals', { violationId: v.id, text: 'again' }, ada2.token))
        .status,
    ).toBe(409);
  });

  it('leaves a rejected appeal final when the case is later escalated', async () => {
    const c = await setup();
    const id = reportedCase(c.w);
    const digest = evidenceDigest(c.w, id);
    await post(c, `/api/admin/reports/${id}/accept`, {
      reason: 'harassment',
      evidenceDigest: digest,
    });
    const ada = await loginAs(c.app, 'ada');
    const v = violationOf(c.w, id);
    await post(c, '/api/moderation/appeals', { violationId: v.id, text: 'context' }, ada.token);
    const appeal = c.w.db.select().from(t.appeals).where(eq(t.appeals.violationId, v.id)).get()!;
    await post(c, `/api/admin/appeals/${appeal.id}/reject`, { reason: 'stands' });
    await post(c, `/api/admin/reports/${id}/critical`, {
      reason: 'confirmed',
      classification: 'critical_child_safety',
      evidenceDigest: digest,
    });
    expect(violationOf(c.w, id).appealReopenedAt).toBeNull();
    expect((await standing(c, ada.token)).pendingDecision).toBeNull();
  });
});

describe('several reports about one letter (product decision 13)', () => {
  // Today a letter has one possible reader, so a second, different reporter is not reachable
  // through the product. The merge is kept deliberately for forward compatibility (for example
  // a letter read by more than one person); this test inserts the second report directly to
  // keep that path covered.
  it('join one case, produce at most one violation, and all lose their explanations', async () => {
    const c = await setup();
    const id = reportedCase(c.w);
    c.w.db
      .insert(t.letterReports)
      .values({
        id: 'rpt_second_reader',
        caseId: id,
        reporterId: c.w.user('dee').id,
        reason: 'harassment',
        explanation: 'a second reader quoting the letter',
        context: 'public',
        hidden: false,
        createdAt: c.w.realClock.now(),
      })
      .run();
    const kase = await caseOf(c, id);
    expect(kase.reportCount).toBe(2);
    expect(kase.reasons.sort()).toEqual(['harassment', 'sexual']);
    await post(c, `/api/admin/reports/${id}/accept`, {
      reason: 'harassment',
      evidenceDigest: evidenceDigest(c.w, id),
    });
    expect(
      c.w.db.select().from(t.violations).where(eq(t.violations.caseId, id)).all(),
    ).toHaveLength(1);
    c.w.realClock.advance(31 * DAY);
    const { applyRetention, RETENTION_DEFAULT } = await import('../services/retention.js');
    expect(applyRetention(c.w.db, c.w.realClock.now(), RETENTION_DEFAULT).redacted).toEqual([id]);
    const explanations = c.w.db
      .select({ e: t.letterReports.explanation })
      .from(t.letterReports)
      .where(eq(t.letterReports.caseId, id))
      .all();
    expect(explanations).toEqual([{ e: null }, { e: null }]);
  });
});
