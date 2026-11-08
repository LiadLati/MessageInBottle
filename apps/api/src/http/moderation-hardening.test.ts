import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { AccountStandingDto, AdminCaseDetailDto } from '@mib/shared';
import * as t from '../db/schema.js';
import { createApp } from './app.js';
import { decideCaseCritical, listAppeals, listCases } from '../services/admin.js';
import { listBlocked } from '../services/friends.js';
import { commitArrivalIfDue } from '../services/journey.js';
import { reportLetter, submitAppeal } from '../services/moderation.js';
import { openBottle } from '../services/bottles.js';
import { devLoseBottle, openPublicBottle } from '../services/outcomes.js';
import { releaseBottle } from '../services/release.js';
import {
  createTestWorld,
  evidenceDigest,
  loginAs,
  releaseInput,
  type TestWorld,
} from '../test/harness.js';

// Re-audit moderation findings SEC-R-003, SEC-R-005, SEC-R-012, SEC-R-013 and SEC-R-018, and
// the "automated review off" half of FE-R-005.

const DAY = 24 * 60 * 60 * 1000;
let n = 0;
const key = () => `hardening-${String(++n).padStart(8, '0')}`;
const json = (token: string) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
});
const makeAdmin = (w: TestWorld, username: string) =>
  w.db
    .update(t.users)
    .set({ role: 'admin' })
    .where(eq(t.users.id, w.user(username).id))
    .run();

// Ada → Bo, lost adrift and read by one finder, Cy, who reports it with an explanation. The
// finder is anonymous to the writer: that is what a sender-administrator must not learn.
function publicCase(w: TestWorld): { caseId: string; bottleId: string } {
  const bottleId = releaseBottle(
    w.ctx,
    w.user('ada'),
    releaseInput(w.user('bo').id, key()),
  ).bottleId;
  devLoseBottle(w.ctx, w.user('ada'), bottleId, 'adrift');
  openPublicBottle(w.ctx, w.user('cy'), bottleId);
  const { caseId } = reportLetter(w.ctx, w.user('cy'), {
    bottleId,
    reason: 'harassment',
    explanation: 'Cy explains',
    hide: false,
  });
  return { caseId, bottleId };
}

function deliveredCase(w: TestWorld): string {
  const id = releaseBottle(w.ctx, w.user('ada'), releaseInput(w.user('bo').id, key())).bottleId;
  w.clock.advance(60 * DAY);
  commitArrivalIfDue(w.ctx, id, w.clock.now());
  openBottle(w.ctx, w.user('bo'), id);
  return reportLetter(w.ctx, w.user('bo'), { bottleId: id, reason: 'harassment', hide: false })
    .caseId;
}

const auditRows = (w: TestWorld, caseId: string, action?: string) =>
  w.db
    .select()
    .from(t.moderationAudit)
    .where(
      action
        ? and(eq(t.moderationAudit.caseId, caseId), eq(t.moderationAudit.action, action))
        : eq(t.moderationAudit.caseId, caseId),
    )
    .all();

describe('a party administrator (SEC-R-003)', () => {
  it('as the sender, is not shown the anonymous finder who reported, nor what they wrote', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const app = createApp(w.ctx);
    makeAdmin(w, 'ada');
    const { caseId } = publicCase(w);
    const ada = await loginAs(app, 'ada');
    const res = await app.request(`/api/admin/reports/${caseId}`, { headers: json(ada.token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { case: AdminCaseDetailDto };
    expect(body.case.recused).toBe(true);
    expect(body.case.reports).toHaveLength(1);
    expect(body.case.reports[0]!.reporter).toBeNull();
    expect(body.case.reports[0]!.explanation).toBeNull();
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('Cy explains');
    expect(raw).not.toContain(w.user('cy').id);
    expect(raw).not.toContain('"cy"');
  });

  it('as the reporter, still sees their own report; a non-party sees everything', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const app = createApp(w.ctx);
    makeAdmin(w, 'cy');
    makeAdmin(w, 'dee');
    const { caseId } = publicCase(w);
    const read = async (username: string) => {
      const { token } = await loginAs(app, username);
      return (
        (await (
          await app.request(`/api/admin/reports/${caseId}`, { headers: json(token) })
        ).json()) as { case: AdminCaseDetailDto }
      ).case;
    };
    const asReporter = await read('cy');
    expect(asReporter.recused).toBe(true);
    expect(asReporter.reports[0]!.reporter?.username).toBe('cy');
    expect(asReporter.reports[0]!.explanation).toBe('Cy explains');
    const asOutsider = await read('dee');
    expect(asOutsider.recused).toBe(false);
    expect(asOutsider.reports[0]!.reporter?.username).toBe('cy');
    expect(asOutsider.reports[0]!.explanation).toBe('Cy explains');
  });

  it('cannot place or release a hold on the evidence about them', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const app = createApp(w.ctx);
    makeAdmin(w, 'bo');
    makeAdmin(w, 'dee');
    const caseId = deliveredCase(w);
    const bo = await loginAs(app, 'bo');
    const dee = await loginAs(app, 'dee');
    const place = (token: string) =>
      app.request(`/api/admin/reports/${caseId}/hold`, {
        method: 'POST',
        headers: json(token),
        body: JSON.stringify({ reason: 'legal', note: 'request from counsel' }),
      });
    const release = (token: string) =>
      app.request(`/api/admin/reports/${caseId}/hold/release`, {
        method: 'POST',
        headers: json(token),
      });
    expect((await place(bo.token)).status).toBe(403);
    expect(auditRows(w, caseId, 'hold_placed')).toHaveLength(0);
    expect((await place(dee.token)).status).toBe(200);
    expect((await release(bo.token)).status).toBe(403);
    expect(
      w.db.select().from(t.moderationCases).where(eq(t.moderationCases.id, caseId)).get()!
        .holdReleasedAt,
    ).toBeNull();
    expect((await release(dee.token)).status).toBe(200);
  });

  it('hides the appeal text from a reporter-administrator, not from the appellant', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    makeAdmin(w, 'dee');
    const caseId = deliveredCase(w);
    const app = createApp(w.ctx);
    const dee = await loginAs(app, 'dee');
    const res = await app.request(`/api/admin/reports/${caseId}/accept`, {
      method: 'POST',
      headers: json(dee.token),
      body: JSON.stringify({ reason: 'Upheld.', evidenceDigest: evidenceDigest(w, caseId) }),
    });
    expect(res.status).toBe(200);
    const violationId = w.db
      .select()
      .from(t.violations)
      .where(eq(t.violations.caseId, caseId))
      .get()!.id;
    submitAppeal(w.ctx, w.user('ada'), { violationId, text: 'Private appeal words.' });
    const asReporter = listAppeals(w.ctx, 'pending', w.user('bo')).appeals[0]!;
    expect(asReporter.text).toBe('');
    expect(asReporter.case.appeal?.text).toBe('');
    const asAppellant = listAppeals(w.ctx, 'pending', w.user('ada')).appeals[0]!;
    expect(asAppellant.text).toBe('Private appeal words.');
    expect(listAppeals(w.ctx, 'pending', w.user('dee')).appeals[0]!.text).toBe(
      'Private appeal words.',
    );
  });
});

describe('evidence reads are audited (SEC-R-003)', () => {
  it('records who opened a case, once per half hour, with ids and no content', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const app = createApp(w.ctx);
    makeAdmin(w, 'dee');
    const caseId = deliveredCase(w);
    const dee = await loginAs(app, 'dee');
    const open = () => app.request(`/api/admin/reports/${caseId}`, { headers: json(dee.token) });
    expect((await open()).status).toBe(200);
    expect((await open()).status).toBe(200);
    let rows = auditRows(w, caseId, 'evidence_viewed');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBe(w.user('dee').id);
    expect(rows[0]!.subjectUserId).toBe(w.user('ada').id);
    expect(rows[0]!.detail).not.toContain('tide');
    // The list of cases carries no evidence, so it is not a read.
    await app.request('/api/admin/reports?status=all', { headers: json(dee.token) });
    expect(auditRows(w, caseId, 'evidence_viewed')).toHaveLength(1);
    w.realClock.advance(31 * 60 * 1000);
    await open();
    rows = auditRows(w, caseId, 'evidence_viewed');
    expect(rows).toHaveLength(2);
  });

  it('listing appeals, which carries each case’s evidence, records a read of each', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const app = createApp(w.ctx);
    makeAdmin(w, 'dee');
    const caseId = deliveredCase(w);
    const dee = await loginAs(app, 'dee');
    await app.request(`/api/admin/reports/${caseId}/accept`, {
      method: 'POST',
      headers: json(dee.token),
      body: JSON.stringify({ reason: 'Upheld.', evidenceDigest: evidenceDigest(w, caseId) }),
    });
    const violationId = w.db
      .select()
      .from(t.violations)
      .where(eq(t.violations.caseId, caseId))
      .get()!.id;
    submitAppeal(w.ctx, w.user('ada'), { violationId, text: 'Please.' });
    expect(auditRows(w, caseId, 'evidence_viewed')).toHaveLength(0);
    await app.request('/api/admin/appeals?status=pending', { headers: json(dee.token) });
    expect(auditRows(w, caseId, 'evidence_viewed')).toHaveLength(1);
  });
});

describe('confirming a critical child-safety violation twice (SEC-R-005)', () => {
  it('changes nothing the second time: no audit rows, no new appeal window, no new notice', () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    makeAdmin(w, 'dee');
    makeAdmin(w, 'cy');
    const caseId = deliveredCase(w);
    // Upheld the ordinary way, then escalated once: that reopens one appeal window.
    decideCaseCritical(w.ctx, w.user('dee'), caseId, 'Confirmed by review.');
    const violation = () =>
      w.db.select().from(t.violations).where(eq(t.violations.caseId, caseId)).get()!;
    const before = {
      audit: auditRows(w, caseId).length,
      v: violation(),
      notes: w.db
        .select()
        .from(t.notifications)
        .where(eq(t.notifications.userId, w.user('ada').id))
        .all().length,
    };
    w.realClock.advance(3 * DAY);
    // A replay by the same administrator and a confirmation by another.
    decideCaseCritical(w.ctx, w.user('dee'), caseId, 'Confirmed by review.');
    decideCaseCritical(w.ctx, w.user('cy'), caseId, 'A second opinion.');
    expect(auditRows(w, caseId)).toHaveLength(before.audit);
    expect(violation()).toEqual(before.v);
    expect(
      w.db
        .select()
        .from(t.notifications)
        .where(eq(t.notifications.userId, w.user('ada').id))
        .all(),
    ).toHaveLength(before.notes);
  });

  it('an escalation of an upheld ordinary violation still reopens the appeal once', () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    makeAdmin(w, 'dee');
    const caseId = deliveredCase(w);
    const app = createApp(w.ctx);
    return loginAs(app, 'dee').then(async (dee) => {
      await app.request(`/api/admin/reports/${caseId}/accept`, {
        method: 'POST',
        headers: json(dee.token),
        body: JSON.stringify({ reason: 'Upheld.', evidenceDigest: evidenceDigest(w, caseId) }),
      });
      w.realClock.advance(40 * DAY);
      decideCaseCritical(w.ctx, w.user('dee'), caseId, 'Escalated.');
      expect(auditRows(w, caseId, 'appeal_reopened')).toHaveLength(1);
      w.realClock.advance(DAY);
      decideCaseCritical(w.ctx, w.user('dee'), caseId, 'Escalated.');
      expect(auditRows(w, caseId, 'appeal_reopened')).toHaveLength(1);
      expect(auditRows(w, caseId, 'critical_child_safety')).toHaveLength(1);
    });
  });
});

describe('a finder who reports can still block the writer (SEC-R-012)', () => {
  it('open → report and hide → block succeeds and lists a bottle-keyed entry', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const app = createApp(w.ctx);
    const bottleId = releaseBottle(
      w.ctx,
      w.user('ada'),
      releaseInput(w.user('bo').id, key()),
    ).bottleId;
    devLoseBottle(w.ctx, w.user('ada'), bottleId, 'adrift');
    const cy = await loginAs(app, 'cy');
    expect(
      (
        await app.request(`/api/ocean/public/${bottleId}/open`, {
          method: 'POST',
          headers: json(cy.token),
        })
      ).status,
    ).toBe(200);
    const reported = await app.request('/api/moderation/reports', {
      method: 'POST',
      headers: json(cy.token),
      body: JSON.stringify({ bottleId, reason: 'harassment', hide: true }),
    });
    expect(reported.status).toBeLessThan(300);
    const blocked = await app.request(`/api/ocean/public/${bottleId}/block`, {
      method: 'POST',
      headers: json(cy.token),
    });
    expect(blocked.status).toBe(204);
    const list = listBlocked(w.ctx, w.user('cy').id);
    expect(list.blocked).toHaveLength(1);
    expect(list.blocked[0]!.foundBottleId).toBe(bottleId);
    expect(JSON.stringify(list)).not.toContain('ada');
  });

  it('still refuses a finder who finished the reading without reporting', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const app = createApp(w.ctx);
    const bottleId = releaseBottle(
      w.ctx,
      w.user('ada'),
      releaseInput(w.user('bo').id, key()),
    ).bottleId;
    devLoseBottle(w.ctx, w.user('ada'), bottleId, 'adrift');
    const cy = await loginAs(app, 'cy');
    await app.request(`/api/ocean/public/${bottleId}/open`, {
      method: 'POST',
      headers: json(cy.token),
    });
    await app.request(`/api/ocean/public/${bottleId}/close`, {
      method: 'POST',
      headers: json(cy.token),
    });
    const blocked = await app.request(`/api/ocean/public/${bottleId}/block`, {
      method: 'POST',
      headers: json(cy.token),
    });
    expect(blocked.status).toBe(404);
  });
});

describe('the sender is not pointed at a recipient who never read it (SEC-R-013)', () => {
  it('a finder-reported letter is described as read by a finder', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const app = createApp(w.ctx);
    // Dee decides; she has no part in the case.
    makeAdmin(w, 'dee');
    const bottleId = releaseBottle(
      w.ctx,
      w.user('ada'),
      releaseInput(w.user('bo').id, key()),
    ).bottleId;
    devLoseBottle(w.ctx, w.user('ada'), bottleId, 'adrift');
    openPublicBottle(w.ctx, w.user('cy'), bottleId);
    const { caseId } = reportLetter(w.ctx, w.user('cy'), {
      bottleId,
      reason: 'harassment',
      hide: false,
    });
    const dee = await loginAs(app, 'dee');
    const res = await app.request(`/api/admin/reports/${caseId}/accept`, {
      method: 'POST',
      headers: json(dee.token),
      body: JSON.stringify({ reason: 'Upheld.', evidenceDigest: evidenceDigest(w, caseId) }),
    });
    expect(res.status).toBe(200);
    const note = w.db
      .select()
      .from(t.notifications)
      .where(
        and(
          eq(t.notifications.userId, w.user('ada').id),
          eq(t.notifications.kind, 'moderation_violation'),
        ),
      )
      .get()!;
    expect(note.message).toMatch(/lost at sea and read by a finder/);
    const ada = await loginAs(app, 'ada');
    const standing = (await (
      await app.request('/api/moderation/standing', { headers: json(ada.token) })
    ).json()) as AccountStandingDto;
    expect(standing.violations[0]!.bottle.readByFinder).toBe(true);
  });

  it('a letter the recipient reported reads as before', () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    makeAdmin(w, 'dee');
    const caseId = deliveredCase(w);
    decideCaseCritical(w.ctx, w.user('dee'), caseId, 'Confirmed.');
    const note = w.db
      .select()
      .from(t.notifications)
      .where(
        and(
          eq(t.notifications.userId, w.user('ada').id),
          eq(t.notifications.kind, 'moderation_banned'),
        ),
      )
      .get()!;
    expect(note.message).not.toMatch(/finder/);
    expect(note.message).toMatch(/^Your letter to /);
  });
});

describe('the moderation queues page instead of truncating (SEC-R-018)', () => {
  it('walks every case and every appeal exactly once, in queue order', () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const ids = Array.from({ length: 5 }, () => deliveredCase(w));
    // One urgent case: it heads the queue on the first page.
    w.db
      .update(t.moderationCases)
      .set({ urgentAt: w.realClock.now() })
      .where(eq(t.moderationCases.id, ids[3]!))
      .run();
    const seen: string[] = [];
    let before: string | undefined;
    do {
      const page = listCases(w.ctx, 'pending', { before, limit: 2 });
      seen.push(...page.cases.map((c) => c.id));
      before = page.nextCursor ?? undefined;
    } while (before);
    expect(seen[0]).toBe(ids[3]);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(ids.length);
    expect(() => listCases(w.ctx, 'pending', { before: 'x;drop' })).toThrow(/cursor/);
  });
});

describe('automated review switched off (FE-R-005, display half)', () => {
  it('says so on every case instead of implying a model will answer', () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    deliveredCase(w);
    expect(listCases(w.ctx, 'pending').cases[0]!.ai.enabled).toBe(w.ctx.config.ai.enabled);
    const off = createTestWorld({ defaultShoreCapacity: 80 });
    off.ctx.config.ai.enabled = false;
    deliveredCase(off);
    expect(listCases(off.ctx, 'pending').cases[0]!.ai.enabled).toBe(false);
  });
});
