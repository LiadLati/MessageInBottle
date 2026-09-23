import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as t from '../db/schema.js';
import { loadConfig, ConfigError } from '../config.js';
import { createApp } from './app.js';
import { LOGIN_PER_ACCOUNT_ADDRESS } from './routes/auth.js';
import { decideCaseCritical } from '../services/admin.js';
import { commitArrivalIfDue } from '../services/journey.js';
import { reportLetter, submitAppeal, presentDecisionNotice } from '../services/moderation.js';
import { openBottle } from '../services/bottles.js';
import { releaseBottle } from '../services/release.js';
import { DEV_SEED_PASSWORD } from '../db/seed-data.js';
import {
  createTestWorld,
  evidenceDigest,
  loginAs,
  releaseInput,
  type TestWorld,
} from '../test/harness.js';

const DAY = 24 * 60 * 60 * 1000;
let n = 0;
const json = (token?: string, extra: Record<string, string> = {}) => ({
  'content-type': 'application/json',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
  ...extra,
});
const admin = (w: TestWorld, username: string) =>
  w.db
    .update(t.users)
    .set({ role: 'admin' })
    .where(eq(t.users.id, w.user(username).id))
    .run();

// A letter from `from` to `to`, delivered, opened and reported by `to`.
function reportedCase(w: TestWorld, from: string, to: string): string {
  const id = releaseBottle(
    w.ctx,
    w.user(from),
    releaseInput(w.user(to).id, `integrity-${String(++n).padStart(8, '0')}`),
  ).bottleId;
  w.clock.advance(60 * DAY);
  commitArrivalIfDue(w.ctx, id, w.clock.now());
  openBottle(w.ctx, w.user(to), id);
  return reportLetter(w.ctx, w.user(to), { bottleId: id, reason: 'harassment', hide: false })
    .caseId;
}

const decide = (
  app: ReturnType<typeof createApp>,
  token: string,
  caseId: string,
  outcome: 'accept' | 'reject',
  body: Record<string, unknown>,
) =>
  app.request(`/api/admin/reports/${caseId}/${outcome}`, {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify(body),
  });

describe('separation of duties (SEC-010)', () => {
  it('refuses a decision by the administrator who reported the letter', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const app = createApp(w.ctx);
    admin(w, 'bo');
    const caseId = reportedCase(w, 'ada', 'bo');
    const bo = await loginAs(app, 'bo');
    const res = await decide(app, bo.token, caseId, 'accept', {
      reason: 'upheld',
      evidenceDigest: evidenceDigest(w, caseId),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('recused');
    const detail = (await (
      await app.request(`/api/admin/reports/${caseId}`, { headers: json(bo.token) })
    ).json()) as { case: { recused: boolean } };
    expect(detail.case.recused).toBe(true);
  });

  it('refuses a decision by the administrator whose own letter it is', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const app = createApp(w.ctx);
    admin(w, 'ada');
    const caseId = reportedCase(w, 'ada', 'bo');
    const ada = await loginAs(app, 'ada');
    const res = await decide(app, ada.token, caseId, 'reject', {
      evidenceDigest: evidenceDigest(w, caseId),
    });
    expect(res.status).toBe(403);
  });

  it('lets an uninvolved administrator decide', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const app = createApp(w.ctx);
    admin(w, 'cy');
    const caseId = reportedCase(w, 'ada', 'bo');
    const cy = await loginAs(app, 'cy');
    const res = await decide(app, cy.token, caseId, 'accept', {
      reason: 'upheld',
      evidenceDigest: evidenceDigest(w, caseId),
    });
    expect(res.status).toBe(200);
  });

  it('refuses an appeal decision and a critical classification by a party', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const app = createApp(w.ctx);
    admin(w, 'cy');
    admin(w, 'bo');
    const caseId = reportedCase(w, 'ada', 'bo');
    const cy = await loginAs(app, 'cy');
    await decide(app, cy.token, caseId, 'accept', {
      reason: 'upheld',
      evidenceDigest: evidenceDigest(w, caseId),
    });
    const violation = w.db
      .select()
      .from(t.violations)
      .where(eq(t.violations.caseId, caseId))
      .get()!;
    presentDecisionNotice(w.ctx, w.user('ada'), violation.id);
    submitAppeal(w.ctx, w.user('ada'), {
      violationId: violation.id,
      text: 'I disagree with this.',
    });
    const appeal = w.db
      .select()
      .from(t.appeals)
      .where(eq(t.appeals.violationId, violation.id))
      .get()!;
    const bo = await loginAs(app, 'bo');
    const res = await app.request(`/api/admin/appeals/${appeal.id}/reject`, {
      method: 'POST',
      headers: json(bo.token),
      body: JSON.stringify({ reason: 'stands' }),
    });
    expect(res.status).toBe(403);
    expect(() =>
      decideCaseCritical(w.ctx, { ...w.user('bo'), role: 'admin' }, caseId, 'critical'),
    ).toThrow(/another administrator/);
  });
});

describe('deciding what was actually seen (SEC-010, FE-009)', () => {
  it('refuses a stale or missing evidence digest', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const app = createApp(w.ctx);
    admin(w, 'cy');
    const caseId = reportedCase(w, 'ada', 'bo');
    const cy = await loginAs(app, 'cy');
    const stale = await decide(app, cy.token, caseId, 'accept', {
      reason: 'upheld',
      evidenceDigest: 'f'.repeat(64),
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe('stale_case');
    const missing = await decide(app, cy.token, caseId, 'accept', { reason: 'upheld' });
    expect(missing.status).toBe(400);
  });

  it('requires a reason to uphold, not to reject', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const app = createApp(w.ctx);
    admin(w, 'cy');
    const a = reportedCase(w, 'ada', 'bo');
    const b = reportedCase(w, 'ada', 'bo');
    const cy = await loginAs(app, 'cy');
    const blank = await decide(app, cy.token, a, 'accept', {
      reason: '  ',
      evidenceDigest: evidenceDigest(w, a),
    });
    expect(blank.status).toBe(400);
    expect(((await blank.json()) as { error: { code: string } }).error.code).toBe(
      'reason_required',
    );
    expect(
      (await decide(app, cy.token, b, 'reject', { evidenceDigest: evidenceDigest(w, b) })).status,
    ).toBe(200);
  });

  it('shows what upholding would do: a warning, then a suspension, then a ban', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const app = createApp(w.ctx);
    admin(w, 'cy');
    const expected = ['warning', 'suspension', 'ban'];
    for (const step of expected) {
      // Sessions follow the real clock, which this loop moves past their lifetime.
      const cy = await loginAs(app, 'cy');
      const caseId = reportedCase(w, 'ada', 'bo');
      const detail = (await (
        await app.request(`/api/admin/reports/${caseId}`, { headers: json(cy.token) })
      ).json()) as { case?: { consequence: { ifUpheld: string }; recused: boolean } };
      expect(detail.case, JSON.stringify(detail)).toBeDefined();
      expect(detail.case!.consequence.ifUpheld).toBe(step);
      expect(detail.case!.recused).toBe(false);
      await decide(app, cy.token, caseId, 'accept', {
        reason: 'upheld',
        evidenceDigest: evidenceDigest(w, caseId),
      });
      // Ada must keep sending while suspended to reach the third step in this test.
      w.realClock.advance(8 * DAY);
    }
  });
});

describe('a restricted administrator loses moderation authority (SEC-009)', () => {
  it('refuses every admin route to a banned administrator', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const app = createApp(w.ctx);
    admin(w, 'dee');
    admin(w, 'cy');
    // Cy writes to Ada, Ada reports, Dee confirms a critical child-safety violation: Cy is banned.
    const caseId = reportedCase(w, 'cy', 'ada');
    decideCaseCritical(w.ctx, { ...w.user('dee'), role: 'admin' }, caseId, 'confirmed');
    const cy = await loginAs(app, 'cy');
    for (const path of ['/api/admin/reports', '/api/admin/appeals', `/api/admin/reports/${caseId}`])
      expect((await app.request(path, { headers: json(cy.token) })).status, path).toBe(403);
    // The ban is still readable by its subject, and still appealable.
    expect(
      (await app.request('/api/moderation/standing', { headers: json(cy.token) })).status,
    ).toBe(200);
  });
});

describe('the audit trail can be read (SEC-011)', () => {
  it('lists the actions about one account, oldest first, for administrators only', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const app = createApp(w.ctx);
    admin(w, 'cy');
    const caseId = reportedCase(w, 'ada', 'bo');
    const cy = await loginAs(app, 'cy');
    await decide(app, cy.token, caseId, 'accept', {
      reason: 'upheld',
      evidenceDigest: evidenceDigest(w, caseId),
    });
    const res = await app.request(`/api/admin/audit?subject=${w.user('ada').id}`, {
      headers: json(cy.token),
    });
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as {
      entries: Array<{ action: string; actorUserId: string | null; reason: string | null }>;
    };
    expect(entries.map((e) => e.action)).toContain('case_decided');
    const decided = entries.find((e) => e.action === 'case_decided')!;
    expect(decided.actorUserId).toBe(w.user('cy').id);
    expect(decided.reason).toBe('upheld');

    expect((await app.request('/api/admin/audit', { headers: json(cy.token) })).status).toBe(400);
    const member = await loginAs(app, 'bo');
    expect(
      (
        await app.request(`/api/admin/audit?subject=${w.user('ada').id}`, {
          headers: json(member.token),
        })
      ).status,
    ).toBe(403);
  });
});

describe('automatic AI decisions stay off while the documents promise a person (SEC-020)', () => {
  it('refuses MIB_AI_AUTO_DECIDE=true', () => {
    expect(() => loadConfig({ MIB_AI_AUTO_DECIDE: 'true' })).toThrow(ConfigError);
    expect(() => loadConfig({ MIB_AI_AUTO_DECIDE: 'true' })).toThrow(/decided by a person/);
    expect(loadConfig({ MIB_AI_AUTO_DECIDE: 'false' }).ai.autoDecide).toBe(false);
  });
});

describe('sign-in budgets (SEC-008, ARCH-009)', () => {
  const login = (app: ReturnType<typeof createApp>, password: string, from: string) =>
    app.request('/api/auth/login', {
      method: 'POST',
      headers: json(undefined, { 'x-forwarded-for': from }),
      body: JSON.stringify({ username: 'ada', password }),
    });

  it('one address guessing locks only itself out of the account', async () => {
    const w = createTestWorld({ trustProxy: true });
    const app = createApp(w.ctx);
    for (let i = 0; i < LOGIN_PER_ACCOUNT_ADDRESS.limit; i++)
      expect((await login(app, 'wrong password', '203.0.113.66')).status).toBe(401);
    expect((await login(app, DEV_SEED_PASSWORD, '203.0.113.66')).status).toBe(429);
    // The owner, elsewhere, still signs in.
    expect((await login(app, DEV_SEED_PASSWORD, '198.51.100.20')).status).toBe(200);
  });

  it('the public deletion form spends the same account budget as sign-in', async () => {
    const w = createTestWorld({ trustProxy: true });
    const app = createApp(w.ctx);
    const from = '203.0.113.77';
    for (let i = 0; i < LOGIN_PER_ACCOUNT_ADDRESS.limit; i++) {
      const form = new FormData();
      form.set('username', 'ada');
      form.set('password', 'wrong password');
      form.set('confirm', 'on');
      await app.request('/legal/delete-account', {
        method: 'POST',
        headers: { 'x-forwarded-for': from },
        body: form,
      });
    }
    // Ten guesses through the form: sign-in from the same address is now refused for Ada.
    expect((await login(app, DEV_SEED_PASSWORD, from)).status).toBe(429);
    expect(w.user('ada').username).toBe('ada');
  });
});
