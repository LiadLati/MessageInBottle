import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { AdminPendingCountsDto } from '@mib/shared';
import * as t from '../db/schema.js';
import { createApp } from './app.js';
import { openBottle } from '../services/bottles.js';
import { commitArrivalIfDue } from '../services/journey.js';
import { reportLetter, submitAppeal } from '../services/moderation.js';
import { releaseBottle } from '../services/release.js';
import {
  createTestWorld,
  evidenceDigest,
  loginAs,
  makeDeveloper,
  releaseInput,
  type TestWorld,
} from '../test/harness.js';

// The moderation badge (manual review round 1, item 3): an administrator sees how much
// undecided work is waiting. The count is actionable work only — it drops when an item is
// decided, never because a screen was opened — a case counts once however many reports it
// merges, and nothing the administrator is a party to (and so cannot decide) is counted.

const DAY = 24 * 60 * 60 * 1000;
const headers = (token: string) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
});

async function setup() {
  const w = createTestWorld({ defaultShoreCapacity: 80 });
  // Dee is the administrator, a party to none of the cases below.
  w.db
    .update(t.users)
    .set({ role: 'admin' })
    .where(eq(t.users.id, w.user('dee').id))
    .run();
  const app = createApp(w.ctx);
  const dee = await loginAs(app, 'dee');
  const counts = async (token = dee.token) => {
    const res = await app.request('/api/admin/pending-counts', { headers: headers(token) });
    return { status: res.status, body: (await res.json()) as AdminPendingCountsDto };
  };
  return { w, app, dee, counts };
}

let n = 0;
function reportedCase(w: TestWorld, from = 'ada', to = 'bo'): string {
  const id = releaseBottle(
    w.ctx,
    w.user(from),
    releaseInput(w.user(to).id, `badge-${String(++n).padStart(10, '0')}`),
  ).bottleId;
  w.clock.advance(60 * DAY);
  commitArrivalIfDue(w.ctx, id, w.clock.now());
  openBottle(w.ctx, w.user(to), id);
  return reportLetter(w.ctx, w.user(to), { bottleId: id, reason: 'harassment', hide: false })
    .caseId;
}

describe('the moderation badge counts actionable, undecided work', () => {
  it('rises with a new report, survives opening the screens, and falls when it is decided', async () => {
    const { w, app, dee, counts } = await setup();
    expect((await counts()).body).toEqual({ reports: 0, appeals: 0, total: 0 });
    const caseId = reportedCase(w);
    expect((await counts()).body).toEqual({ reports: 1, appeals: 0, total: 1 });

    // Looking at the queue and at the case clears nothing.
    await app.request('/api/admin/reports?status=pending', { headers: headers(dee.token) });
    await app.request(`/api/admin/reports/${caseId}`, { headers: headers(dee.token) });
    expect((await counts()).body.total).toBe(1);

    const decided = await app.request(`/api/admin/reports/${caseId}/accept`, {
      method: 'POST',
      headers: headers(dee.token),
      body: JSON.stringify({ reason: 'A threat.', evidenceDigest: evidenceDigest(w, caseId) }),
    });
    expect(decided.status).toBe(200);
    expect((await counts()).body).toEqual({ reports: 0, appeals: 0, total: 0 });

    // The sender appeals: one appeal waiting, until it is decided.
    const violation = w.db
      .select()
      .from(t.violations)
      .where(eq(t.violations.caseId, caseId))
      .get()!;
    const appealId = submitAppeal(w.ctx, w.user('ada'), {
      violationId: violation.id,
      text: 'Out of context.',
    }).appeal!.id;
    expect((await counts()).body).toEqual({ reports: 0, appeals: 1, total: 1 });
    await app.request('/api/admin/appeals?status=pending', { headers: headers(dee.token) });
    expect((await counts()).body.appeals).toBe(1);
    const appealDecided = await app.request(`/api/admin/appeals/${appealId}/reject`, {
      method: 'POST',
      headers: headers(dee.token),
      body: JSON.stringify({ reason: 'The threat is plain.' }),
    });
    expect(appealDecided.status).toBe(200);
    expect((await counts()).body).toEqual({ reports: 0, appeals: 0, total: 0 });
  });

  it('counts a case once however many reports it merges', async () => {
    const { w, counts } = await setup();
    const caseId = reportedCase(w);
    // A second reporter on the same case (as when a finder also reports a letter).
    const first = w.db
      .select()
      .from(t.letterReports)
      .where(eq(t.letterReports.caseId, caseId))
      .get()!;
    w.db
      .insert(t.letterReports)
      .values({ ...first, id: 'rpt_second', reporterId: w.user('cy').id })
      .run();
    expect((await counts()).body).toEqual({ reports: 1, appeals: 0, total: 1 });
  });

  it('leaves out a case the administrator is a party to', async () => {
    const { w, counts } = await setup();
    // A letter to Dee, reported by Dee: she cannot decide it, so it is not her work.
    // Dee's seeded request to Ada is accepted, so Ada can write to her.
    w.db.update(t.friendships).set({ status: 'accepted', acceptedAt: 0 }).run();
    w.db
      .update(t.users)
      .set({ shoreId: 'shore_gull_hollow' })
      .where(eq(t.users.id, w.user('dee').id))
      .run();
    reportedCase(w, 'ada', 'dee');
    expect((await counts()).body).toEqual({ reports: 0, appeals: 0, total: 0 });
    reportedCase(w, 'ada', 'bo');
    expect((await counts()).body.reports).toBe(1);
  });

  it('is for administrators only: members and developers are refused', async () => {
    const { w, app, counts } = await setup();
    makeDeveloper(w, 'cy');
    const cy = await loginAs(app, 'cy');
    const bo = await loginAs(app, 'bo');
    expect((await counts(cy.token)).status).toBe(403);
    expect((await counts(bo.token)).status).toBe(403);
    expect((await app.request('/api/admin/pending-counts')).status).toBe(401);
  });
});
