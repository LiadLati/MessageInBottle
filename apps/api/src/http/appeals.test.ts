import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  APPEAL_ACTION_APPEAL,
  APPEAL_ACTION_CONTINUE,
  APPEAL_ACTION_GO_BACK,
  APPEAL_ACTION_SKIP,
  APPEAL_WAIVER_CONFIRMATION,
  type AccountStandingDto,
} from '@mib/shared';
import * as t from '../db/schema.js';
import { createApp } from './app.js';
import { commitArrivalIfDue } from '../services/journey.js';
import { SUSPENSION_MS } from '../services/moderation.js';
import { devLoseBottle } from '../services/outcomes.js';
import {
  createTestWorld,
  loginAs as login,
  releaseInput,
  type TestWorld,
  evidenceDigest,
} from '../test/harness.js';

const auth = (token: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});
const DAY = 24 * 60 * 60 * 1000;

// Everything here goes through the real HTTP surface, because "server-authoritative" is a
// claim about the API and not about a service function.
async function setup() {
  const w = createTestWorld({ defaultShoreCapacity: 80 });
  const app = createApp(w.ctx);
  w.db
    .update(t.users)
    .set({ role: 'admin' })
    .where(eq(t.users.id, w.user('cy').id))
    .run();
  const ada = await login(app, 'ada');
  const bo = await login(app, 'bo');
  const cy = await login(app, 'cy');
  return { w, app, ada, bo, cy };
}

// Ada writes to Bo; Bo opens it and reports it. Returns the case, still undecided.
async function reportedCaseFor(
  ctx: Awaited<ReturnType<typeof setup>>,
  key: string,
): Promise<string> {
  const { w, app, ada, bo } = ctx;
  const release = await app.request('/api/bottles/release', {
    method: 'POST',
    headers: auth(ada.token),
    body: JSON.stringify(releaseInput(bo.id, key)),
  });
  expect(release.status).toBe(201);
  const { bottle } = (await release.json()) as { bottle: { id: string } };
  w.clock.advance(40 * DAY);
  // Arrival through the service rather than a DEV route: the account under test is an
  // ordinary member, and DEV controls now require the developer role.
  expect(commitArrivalIfDue(w.ctx, bottle.id, w.clock.now())).toBe(true);
  await app.request(`/api/shore/bottles/${bottle.id}/open`, {
    method: 'POST',
    headers: auth(bo.token),
  });
  const report = await app.request('/api/moderation/reports', {
    method: 'POST',
    headers: auth(bo.token),
    body: JSON.stringify({ bottleId: bottle.id, reason: 'harassment', hide: false }),
  });
  expect(report.status).toBe(201);
  return ((await report.json()) as { caseId: string }).caseId;
}

async function upheldOne(ctx: Awaited<ReturnType<typeof setup>>, caseId: string): Promise<string> {
  const accepted = await ctx.app.request(`/api/admin/reports/${caseId}/accept`, {
    method: 'POST',
    headers: auth(ctx.cy.token),
    body: JSON.stringify({ reason: 'upheld', evidenceDigest: evidenceDigest(ctx.w, caseId) }),
  });
  expect(accepted.status).toBe(200);
  return caseId;
}

async function upheldViolation(
  ctx: Awaited<ReturnType<typeof setup>>,
  key: string,
): Promise<string> {
  return upheldOne(ctx, await reportedCaseFor(ctx, key));
}

// Several violations in a row. Every letter is written and reported *first*, because a
// suspended account cannot send anything: the second and third violations in real life come
// from letters that were already on their way when the first was decided.
async function upheldViolations(
  ctx: Awaited<ReturnType<typeof setup>>,
  keys: string[],
  expected: number,
  // How many of the prepared cases to uphold now. The rest are left pending for the test to
  // uphold later, when the account can no longer send anything.
  upholdNow = keys.length,
): Promise<string[]> {
  const cases: string[] = [];
  for (const key of keys) cases.push(await reportedCaseFor(ctx, key));
  for (const caseId of cases.slice(0, upholdNow)) await upheldOne(ctx, caseId);
  expect(cases).toHaveLength(expected);
  return cases;
}

const standingOfAda = async (
  ctx: Awaited<ReturnType<typeof setup>>,
): Promise<AccountStandingDto> => {
  const res = await ctx.app.request('/api/moderation/standing', {
    headers: auth(ctx.ada.token),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as AccountStandingDto;
};

// Test sessions last an hour, so coming back after a jump in real time means signing in
// again — which is exactly what the person whose notice is still waiting would do.
const comeBackLater = async (ctx: Awaited<ReturnType<typeof setup>>, ms: number) => {
  ctx.w.realClock.advance(ms);
  ctx.ada = await login(ctx.app, 'ada');
  ctx.bo = await login(ctx.app, 'bo');
  ctx.cy = await login(ctx.app, 'cy');
};
const violationOf = (w: TestWorld, caseId: string) =>
  w.db.select().from(t.violations).where(eq(t.violations.caseId, caseId)).get()!;
const auditActions = (w: TestWorld, violationId: string) =>
  w.db.select().from(t.moderationAudit).where(eq(t.moderationAudit.violationId, violationId)).all();

describe('the single appeal opportunity', () => {
  it('offers the decision notice, and keeps offering it until it is answered', async () => {
    const ctx = await setup();
    const caseId = await upheldViolation(ctx, 'appeal-key-000001');
    const v = violationOf(ctx.w, caseId);

    const first = await standingOfAda(ctx);
    expect(first.pendingDecision?.id).toBe(v.id);
    expect(first.pendingDecision?.appealAvailable).toBe(true);

    // Reading the notice and going away again — the client closing, the tab reloading, the
    // connection dropping — resolves nothing at all.
    await ctx.app.request(`/api/moderation/violations/${v.id}/presented`, {
      method: 'POST',
      headers: auth(ctx.ada.token),
    });
    await comeBackLater(ctx, 30 * DAY);
    const later = await standingOfAda(ctx);
    expect(later.pendingDecision?.id).toBe(v.id);
    expect(later.pendingDecision?.appealAvailable).toBe(true);
    expect(violationOf(ctx.w, caseId).appealWaivedAt).toBeNull();
  });

  it('records the presentation once, server-side, and audits it', async () => {
    const ctx = await setup();
    const caseId = await upheldViolation(ctx, 'appeal-key-000002');
    const v = violationOf(ctx.w, caseId);
    expect(v.noticePresentedAt).toBeNull();

    const res = await ctx.app.request(`/api/moderation/violations/${v.id}/presented`, {
      method: 'POST',
      headers: auth(ctx.ada.token),
    });
    expect(res.status).toBe(200);
    const at = violationOf(ctx.w, caseId).noticePresentedAt;
    expect(at).toBe(ctx.w.realClock.now());

    // Idempotent: presenting again keeps the first instant and writes no second audit row.
    ctx.w.realClock.advance(DAY);
    await ctx.app.request(`/api/moderation/violations/${v.id}/presented`, {
      method: 'POST',
      headers: auth(ctx.ada.token),
    });
    expect(violationOf(ctx.w, caseId).noticePresentedAt).toBe(at);
    expect(auditActions(ctx.w, v.id).filter((a) => a.action === 'notice_presented')).toHaveLength(
      1,
    );
  });

  it('waives the appeal permanently, only on an explicit request, and audits it', async () => {
    const ctx = await setup();
    const caseId = await upheldViolation(ctx, 'appeal-key-000003');
    const v = violationOf(ctx.w, caseId);

    const res = await ctx.app.request('/api/moderation/appeals/waive', {
      method: 'POST',
      headers: auth(ctx.ada.token),
      body: JSON.stringify({ violationId: v.id }),
    });
    expect(res.status).toBe(200);
    expect(violationOf(ctx.w, caseId).appealWaivedAt).toBe(ctx.w.realClock.now());

    // The notice is answered: it does not come back.
    expect((await standingOfAda(ctx)).pendingDecision).toBeNull();

    const audit = auditActions(ctx.w, v.id).find((a) => a.action === 'appeal_waived')!;
    expect(audit.subjectUserId).toBe(ctx.ada.id);
    expect(audit.actorUserId).toBe(ctx.ada.id);
    expect(audit.actorRole).toBe('member');

    // And it cannot be undone by appealing afterwards.
    const late = await ctx.app.request('/api/moderation/appeals', {
      method: 'POST',
      headers: auth(ctx.ada.token),
      body: JSON.stringify({ violationId: v.id, text: 'actually I would like to appeal' }),
    });
    expect(late.status).toBe(409);
  });

  it('is idempotent: confirming the waiver twice keeps the first instant', async () => {
    const ctx = await setup();
    const caseId = await upheldViolation(ctx, 'appeal-key-000004');
    const v = violationOf(ctx.w, caseId);
    const waive = () =>
      ctx.app.request('/api/moderation/appeals/waive', {
        method: 'POST',
        headers: auth(ctx.ada.token),
        body: JSON.stringify({ violationId: v.id }),
      });
    expect((await waive()).status).toBe(200);
    const at = violationOf(ctx.w, caseId).appealWaivedAt;
    ctx.w.realClock.advance(60_000);
    expect((await waive()).status).toBe(200);
    expect(violationOf(ctx.w, caseId).appealWaivedAt).toBe(at);
    expect(auditActions(ctx.w, v.id).filter((a) => a.action === 'appeal_waived')).toHaveLength(1);
  });

  it('allows exactly one appeal', async () => {
    const ctx = await setup();
    const caseId = await upheldViolation(ctx, 'appeal-key-000005');
    const v = violationOf(ctx.w, caseId);
    const appeal = (text: string) =>
      ctx.app.request('/api/moderation/appeals', {
        method: 'POST',
        headers: auth(ctx.ada.token),
        body: JSON.stringify({ violationId: v.id, text }),
      });
    expect((await appeal('please reconsider')).status).toBe(201);
    expect((await appeal('and again')).status).toBe(409);
    expect(
      ctx.w.db.select().from(t.appeals).where(eq(t.appeals.violationId, v.id)).all(),
    ).toHaveLength(1);
    // The offer is spent, so the notice stops coming back.
    expect((await standingOfAda(ctx)).pendingDecision).toBeNull();
  });

  it('refuses a waiver once an appeal has been submitted', async () => {
    const ctx = await setup();
    const caseId = await upheldViolation(ctx, 'appeal-key-000006');
    const v = violationOf(ctx.w, caseId);
    await ctx.app.request('/api/moderation/appeals', {
      method: 'POST',
      headers: auth(ctx.ada.token),
      body: JSON.stringify({ violationId: v.id, text: 'please reconsider' }),
    });
    const res = await ctx.app.request('/api/moderation/appeals/waive', {
      method: 'POST',
      headers: auth(ctx.ada.token),
      body: JSON.stringify({ violationId: v.id }),
    });
    expect(res.status).toBe(409);
    expect(violationOf(ctx.w, caseId).appealWaivedAt).toBeNull();
  });

  it('makes a rejected appeal final', async () => {
    const ctx = await setup();
    const caseId = await upheldViolation(ctx, 'appeal-key-000007');
    const v = violationOf(ctx.w, caseId);
    await ctx.app.request('/api/moderation/appeals', {
      method: 'POST',
      headers: auth(ctx.ada.token),
      body: JSON.stringify({ violationId: v.id, text: 'please reconsider' }),
    });
    const a = ctx.w.db.select().from(t.appeals).where(eq(t.appeals.violationId, v.id)).get()!;
    const decided = await ctx.app.request(`/api/admin/appeals/${a.id}/reject`, {
      method: 'POST',
      headers: auth(ctx.cy.token),
      body: JSON.stringify({ reason: 'the decision stands' }),
    });
    expect(decided.status).toBe(200);

    const standing = await standingOfAda(ctx);
    expect(standing.pendingDecision).toBeNull();
    expect(standing.violations[0]!.appealAvailable).toBe(false);
    expect(standing.violations[0]!.appeal?.status).toBe('rejected');
    // No second appeal, and no waiver either: there is nothing left to give up.
    const again = await ctx.app.request('/api/moderation/appeals', {
      method: 'POST',
      headers: auth(ctx.ada.token),
      body: JSON.stringify({ violationId: v.id, text: 'again' }),
    });
    expect(again.status).toBe(409);
  });

  it('recalculates standing immediately when an appeal is accepted', async () => {
    const ctx = await setup();
    const cases = await upheldViolations(ctx, ['appeal-key-000008', 'appeal-key-000009'], 2, 2);
    const first = cases[0]!;
    expect((await standingOfAda(ctx)).standing).toBe('suspended');

    const v = violationOf(ctx.w, first);
    await ctx.app.request('/api/moderation/appeals', {
      method: 'POST',
      headers: auth(ctx.ada.token),
      body: JSON.stringify({ violationId: v.id, text: 'the first one was wrong' }),
    });
    const a = ctx.w.db.select().from(t.appeals).where(eq(t.appeals.violationId, v.id)).get()!;
    await ctx.app.request(`/api/admin/appeals/${a.id}/accept`, {
      method: 'POST',
      headers: auth(ctx.cy.token),
      body: JSON.stringify({ reason: 'withdrawn' }),
    });

    const after = await standingOfAda(ctx);
    expect(after.standing).toBe('warned');
    expect(after.violationsInForce).toBe(1);
    expect(after.suspendedUntil).toBeNull();
  });

  it('stays reachable while suspended and while banned', async () => {
    const ctx = await setup();
    // The letters are written first: a suspended account cannot send, so the second and third
    // violations have to come from letters that were already on their way.
    const cases = await upheldViolations(
      ctx,
      ['appeal-key-000010', 'appeal-key-000011', 'appeal-key-000013'],
      3,
      2,
    );
    const second = cases[1]!;
    expect((await standingOfAda(ctx)).standing).toBe('suspended');

    // Suspended: the decision, the appeal, the waiver, support and sign-out all still work…
    const v = violationOf(ctx.w, second);
    expect(
      (
        await ctx.app.request(`/api/moderation/violations/${v.id}/presented`, {
          method: 'POST',
          headers: auth(ctx.ada.token),
        })
      ).status,
    ).toBe(200);
    expect((await ctx.app.request('/support')).status).toBe(200);
    // …while ordinary use does not.
    const release = await ctx.app.request('/api/bottles/release', {
      method: 'POST',
      headers: auth(ctx.ada.token),
      body: JSON.stringify(releaseInput(ctx.bo.id, 'appeal-key-000012')),
    });
    expect(release.status).toBe(403);

    await upheldOne(ctx, cases[2]!);
    expect((await standingOfAda(ctx)).standing).toBe('banned');
    expect((await standingOfAda(ctx)).pendingDecision).not.toBeNull();
    const waive = await ctx.app.request('/api/moderation/appeals/waive', {
      method: 'POST',
      headers: auth(ctx.ada.token),
      body: JSON.stringify({ violationId: violationOf(ctx.w, second).id }),
    });
    expect(waive.status).toBe(200);
    expect(
      (await ctx.app.request('/api/auth/logout', { method: 'POST', headers: auth(ctx.ada.token) }))
        .status,
    ).toBe(204);
  });

  it('never names the reporter anywhere in the sender’s view', async () => {
    const ctx = await setup();
    const { w, app, ada, bo, cy } = ctx;
    // Cy is the reporter here, and neither the sender nor the recipient — so anything of Cy's
    // appearing in Ada's view is a leak, with no innocent explanation.
    const release = await app.request('/api/bottles/release', {
      method: 'POST',
      headers: auth(ada.token),
      body: JSON.stringify(releaseInput(bo.id, 'appeal-key-000014')),
    });
    const { bottle } = (await release.json()) as { bottle: { id: string } };
    devLoseBottle(w.ctx, w.user('ada'), bottle.id, 'adrift');
    await app.request(`/api/ocean/public/${bottle.id}/open`, {
      method: 'POST',
      headers: auth(cy.token),
    });
    const report = await app.request('/api/moderation/reports', {
      method: 'POST',
      headers: auth(cy.token),
      body: JSON.stringify({
        bottleId: bottle.id,
        reason: 'harassment',
        hide: false,
        explanation: 'zzz-reporter-explanation-zzz',
      }),
    });
    const { caseId } = (await report.json()) as { caseId: string };
    // Cy reported it, so Cy may not decide it (audit SEC-010): an uninvolved administrator does.
    w.db
      .update(t.users)
      .set({ role: 'admin' })
      .where(eq(t.users.id, w.user('dee').id))
      .run();
    const dee = await login(app, 'dee');
    const upheld = await app.request(`/api/admin/reports/${caseId}/accept`, {
      method: 'POST',
      headers: auth(dee.token),
      body: JSON.stringify({ reason: 'upheld', evidenceDigest: evidenceDigest(w, caseId) }),
    });
    expect(upheld.status).toBe(200);

    const body = await (
      await app.request('/api/moderation/standing', { headers: auth(ada.token) })
    ).text();
    const notes = await (
      await app.request('/api/notifications', { headers: auth(ada.token) })
    ).text();
    const reportRow = w.db
      .select()
      .from(t.letterReports)
      .where(eq(t.letterReports.caseId, caseId))
      .get()!;
    for (const text of [body, notes]) {
      expect(text).not.toContain(cy.id);
      expect(text).not.toContain('Cy');
      expect(text).not.toContain(reportRow.id);
      expect(text).not.toContain('zzz-reporter-explanation-zzz');
    }
  });

  it('refuses to act on somebody else’s violation', async () => {
    const ctx = await setup();
    const caseId = await upheldViolation(ctx, 'appeal-key-000015');
    const v = violationOf(ctx.w, caseId);
    for (const path of [
      `/api/moderation/violations/${v.id}/presented`,
      '/api/moderation/appeals/waive',
    ]) {
      const res = await ctx.app.request(path, {
        method: 'POST',
        headers: auth(ctx.bo.token),
        body: JSON.stringify({ violationId: v.id }),
      });
      expect(res.status).toBe(404);
    }
    expect(violationOf(ctx.w, caseId).appealWaivedAt).toBeNull();
  });
});

describe('violations never expire', () => {
  it('keeps counting an upheld violation after its suspension has been served', async () => {
    const ctx = await setup();
    const cases = await upheldViolations(
      ctx,
      ['expiry-key-000001', 'expiry-key-000002', 'expiry-key-000003'],
      3,
      2,
    );
    expect((await standingOfAda(ctx)).standing).toBe('suspended');

    // Serve the suspension: the account is usable again…
    await comeBackLater(ctx, SUSPENSION_MS + 1);
    const served = await standingOfAda(ctx);
    expect(served.standing).toBe('warned');
    // …but both violations still count, so a third is still a ban.
    expect(served.violationsInForce).toBe(2);

    await comeBackLater(ctx, 90 * DAY);
    expect((await standingOfAda(ctx)).violationsInForce).toBe(2);
    // A third still bans, however long ago the first two were.
    await upheldOne(ctx, cases[2]!);
    expect((await standingOfAda(ctx)).standing).toBe('banned');
    expect((await standingOfAda(ctx)).standing).toBe('banned');
  });

  it('counts neither rejected nor undecided reports', async () => {
    const ctx = await setup();
    const { w, app, ada, bo, cy } = ctx;
    const bottles: string[] = [];
    for (const key of ['count-key-000001', 'count-key-000002']) {
      const release = await app.request('/api/bottles/release', {
        method: 'POST',
        headers: auth(ada.token),
        body: JSON.stringify(releaseInput(bo.id, key)),
      });
      bottles.push(((await release.json()) as { bottle: { id: string } }).bottle.id);
    }
    w.clock.advance(40 * DAY);
    for (const id of bottles) expect(commitArrivalIfDue(w.ctx, id, w.clock.now())).toBe(true);
    const cases: string[] = [];
    for (const id of bottles) {
      await app.request(`/api/shore/bottles/${id}/open`, {
        method: 'POST',
        headers: auth(bo.token),
      });
      const r = await app.request('/api/moderation/reports', {
        method: 'POST',
        headers: auth(bo.token),
        body: JSON.stringify({ bottleId: id, reason: 'harassment', hide: false }),
      });
      cases.push(((await r.json()) as { caseId: string }).caseId);
    }
    // One rejected, one left undecided.
    await app.request(`/api/admin/reports/${cases[0]!}/reject`, {
      method: 'POST',
      headers: auth(cy.token),
      body: JSON.stringify({
        reason: 'not a violation',
        evidenceDigest: evidenceDigest(ctx.w, cases[0]!),
      }),
    });
    const standing = await standingOfAda(ctx);
    expect(standing.standing).toBe('good');
    expect(standing.violationsInForce).toBe(0);
    expect(standing.pendingDecision).toBeNull();
  });

  it('produces one case and one violation when the same reader reports a letter twice', async () => {
    const ctx = await setup();
    const { w, app, bo, cy } = ctx;
    const caseId = await reportedCaseFor(ctx, 'dedupe-key-00001');
    const bottleId = w.db
      .select()
      .from(t.moderationCases)
      .where(eq(t.moderationCases.id, caseId))
      .get()!.bottleId;

    // The same reader reporting the letter again joins the same case rather than opening a
    // second one. (A different second reporter cannot exist: a letter has one reader.)
    const second = await app.request('/api/moderation/reports', {
      method: 'POST',
      headers: auth(bo.token),
      body: JSON.stringify({ bottleId, reason: 'other', hide: true }),
    });
    expect(second.status).toBe(201);
    expect(((await second.json()) as { caseId: string }).caseId).toBe(caseId);
    expect(
      w.db.select().from(t.moderationCases).where(eq(t.moderationCases.bottleId, bottleId)).all(),
    ).toHaveLength(1);

    await app.request(`/api/admin/reports/${caseId}/accept`, {
      method: 'POST',
      headers: auth(cy.token),
      body: JSON.stringify({ reason: 'upheld once', evidenceDigest: evidenceDigest(w, caseId) }),
    });
    // One case, one violation.
    expect(
      w.db.select().from(t.violations).where(eq(t.violations.caseId, caseId)).all(),
    ).toHaveLength(1);
    expect((await standingOfAda(ctx)).violationsInForce).toBe(1);
  });
});

describe('the words the notice must use', () => {
  it('keeps the four actions and the confirmation sentence fixed', () => {
    // These strings are the product decision, not copy: the API tests and the UI share them
    // from one place so a rewording cannot quietly change what was agreed.
    expect(APPEAL_ACTION_APPEAL).toBe('Appeal decision');
    expect(APPEAL_ACTION_CONTINUE).toBe('Continue without appealing');
    expect(APPEAL_ACTION_GO_BACK).toBe('Go back');
    expect(APPEAL_ACTION_SKIP).toBe('Skip appeal');
    expect(APPEAL_WAIVER_CONFIRMATION).toBe(
      'If you continue, you will permanently lose the option to appeal this decision.',
    );
  });
});
