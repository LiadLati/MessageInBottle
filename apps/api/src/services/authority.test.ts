import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as t from '../db/schema.js';
import { createApp } from '../http/app.js';
import { decideCase, decideCaseCritical, placeHold } from './admin.js';
import { openBottle } from './bottles.js';
import { blockUser } from './friends.js';
import { commitArrivalIfDue } from './journey.js';
import { reportLetter, standingOf } from './moderation.js';
import { devLoseBottle } from './outcomes.js';
import { listPublicOcean, openPublicBottle } from './outcomes.js';
import { releaseBottle } from './release.js';
import { AppError } from '../lib/errors.js';
import { createTestWorld, loginAs, releaseInput } from '../test/harness.js';

const DAY = 24 * 60 * 60 * 1000;

describe('blocking reaches the public ocean as well as direct contact', () => {
  it('hides an adrift bottle from a blocked pair, in both directions, and refuses the open', () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const bottleId = releaseBottle(
      w.ctx,
      w.user('ada'),
      releaseInput(w.user('bo').id, 'block-key-0000001'),
    ).bottleId;
    devLoseBottle(w.ctx, w.user('ada'), bottleId, 'adrift');

    // Before the block, Cy can see it adrift.
    expect(listPublicOcean(w.ctx, w.user('cy')).map((b) => b.id)).toContain(bottleId);

    // Cy blocks Ada. The bottle is Ada's, so it leaves Cy's public ocean…
    blockUser(w.ctx, w.user('cy').id, 'ada');
    expect(listPublicOcean(w.ctx, w.user('cy')).map((b) => b.id)).not.toContain(bottleId);
    // …and knowing the id is no help either: opening it is refused as if it were not there.
    expect(() => openPublicBottle(w.ctx, w.user('cy'), bottleId)).toThrow(AppError);

    // The sender still sees their own.
    expect(listPublicOcean(w.ctx, w.user('ada')).map((b) => b.id)).toContain(bottleId);
  });

  it('stops a letter being sent between blocked accounts', () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    blockUser(w.ctx, w.user('bo').id, 'ada');
    expect(() =>
      releaseBottle(w.ctx, w.user('ada'), releaseInput(w.user('bo').id, 'block-key-0000002')),
    ).toThrow(AppError);
  });
});

describe('the review model recommends and never decides', () => {
  it('has no path to a critical child-safety classification', () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    w.db
      .update(t.users)
      .set({ role: 'admin' })
      .where(eq(t.users.id, w.user('cy').id))
      .run();
    const bottleId = releaseBottle(
      w.ctx,
      w.user('ada'),
      releaseInput(w.user('bo').id, 'ai-key-0000000001'),
    ).bottleId;
    w.clock.advance(40 * DAY);
    commitArrivalIfDue(w.ctx, bottleId, w.clock.now());
    openBottle(w.ctx, w.user('bo'), bottleId);
    const caseId = reportLetter(w.ctx, w.user('bo'), {
      bottleId,
      reason: 'harassment',
      hide: false,
    }).caseId;

    // `decideCase` and `decideCaseCritical` both take a required administrator: the worker has
    // no value it could pass. An administrator's ordinary decision walks the ladder.
    decideCase(w.ctx, { ...w.user('cy'), role: 'admin' }, caseId, 'accepted', 'harassment');
    const v = w.db.select().from(t.violations).where(eq(t.violations.caseId, caseId)).get()!;
    expect(v.decidedBy).toBe('admin');
    expect(v.decidedByUserId).toBe(w.user('cy').id);
    expect(v.severity).toBe('standard');
    expect(standingOf(w.db, w.user('ada').id, w.realClock.now()).standing).toBe('warned');

    // Only an administrator can escalate it, and the audit records who.
    decideCaseCritical(w.ctx, { ...w.user('cy'), role: 'admin' }, caseId, 'confirmed');
    const audit = w.db
      .select()
      .from(t.moderationAudit)
      .where(eq(t.moderationAudit.caseId, caseId))
      .all()
      .find((a) => a.action === 'critical_child_safety')!;
    expect(audit.actorRole).toBe('admin');
    expect(audit.actorUserId).toBe(w.user('cy').id);
  });

  it('has no automatic-decision setting at all', () => {
    const w = createTestWorld();
    expect('autoDecide' in w.ctx.config.ai).toBe(false);
  });

  it('records a hold against the administrator who placed it, never the system', () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    w.db
      .update(t.users)
      .set({ role: 'admin' })
      .where(eq(t.users.id, w.user('cy').id))
      .run();
    const bottleId = releaseBottle(
      w.ctx,
      w.user('ada'),
      releaseInput(w.user('bo').id, 'ai-key-0000000002'),
    ).bottleId;
    w.clock.advance(40 * DAY);
    commitArrivalIfDue(w.ctx, bottleId, w.clock.now());
    openBottle(w.ctx, w.user('bo'), bottleId);
    const caseId = reportLetter(w.ctx, w.user('bo'), {
      bottleId,
      reason: 'harassment',
      hide: false,
    }).caseId;
    placeHold(w.ctx, { ...w.user('cy'), role: 'admin' }, caseId, 'legal', 'ref 42');
    const audit = w.db
      .select()
      .from(t.moderationAudit)
      .where(eq(t.moderationAudit.caseId, caseId))
      .all()
      .find((a) => a.action === 'hold_placed')!;
    expect(audit.actorRole).toBe('admin');
    expect(audit.actorUserId).toBe(w.user('cy').id);
  });
});

describe('the public surface needs no account', () => {
  it('serves every public route signed out', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    for (const path of [
      '/support',
      '/legal',
      '/legal/terms',
      '/legal/community-rules',
      '/legal/privacy',
      '/legal/child-safety',
      '/legal/delete-account',
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toMatch(/text\/html/);
      const body = await res.text();
      // Readable on a phone, and no client-side JavaScript to get in the way.
      expect(body, path).toContain('name="viewport"');
      expect(body, path).not.toMatch(/<script/i);
      // The support address renders plainly, never escaped into something uncopyable.
      if (body.includes('@')) expect(body, path).not.toContain('\\@');
    }
  });

  it('needs an account for everything else', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    for (const path of ['/api/chart', '/api/moderation/standing', '/api/admin/reports'])
      expect((await app.request(path)).status, path).toBe(401);
    await loginAs(app, 'ada');
  });
});
