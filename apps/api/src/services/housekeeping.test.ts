import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as t from '../db/schema.js';
import { createApp } from '../http/app.js';
import { releaseBottle } from './release.js';
import { IDEMPOTENCY_KEEP_MS, RESET_RECORD_GRACE_MS, pruneExpiredRecords } from './housekeeping.js';
import { createTestWorld, loginAs, releaseInput } from '../test/harness.js';

describe('housekeeping (ARCH-024)', () => {
  it('removes expired sessions, spent reset records and old idempotency records only', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const app = createApp(w.ctx);
    const live = await loginAs(app, 'ada');
    const now = w.realClock.now();
    const ada = w.user('ada').id;
    w.db
      .insert(t.sessions)
      .values({ tokenHash: 'expired', userId: ada, createdAt: 0, expiresAt: now - 1 })
      .run();
    w.db
      .insert(t.passwordResets)
      .values([
        {
          id: 'prs_old',
          userId: ada,
          tokenHash: 'a',
          createdAt: 0,
          expiresAt: now - RESET_RECORD_GRACE_MS - 1,
        },
        { id: 'prs_live', userId: ada, tokenHash: 'b', createdAt: now, expiresAt: now + 60_000 },
      ])
      .run();
    releaseBottle(w.ctx, w.user('ada'), releaseInput(w.user('bo').id, 'housekeeping-00001'));
    w.db
      .update(t.idempotencyKeys)
      .set({ createdAt: now - IDEMPOTENCY_KEEP_MS - 1 })
      .run();

    expect(pruneExpiredRecords(w.db, now)).toMatchObject({
      sessions: 1,
      passwordResets: 1,
      idempotencyKeys: 1,
    });
    expect(
      w.db
        .select()
        .from(t.passwordResets)
        .all()
        .map((r) => r.id),
    ).toEqual(['prs_live']);
    // The live session still works.
    expect(
      (await app.request('/api/auth/me', { headers: { authorization: `Bearer ${live.token}` } }))
        .status,
    ).toBe(200);
    expect(w.db.select().from(t.sessions).where(eq(t.sessions.userId, ada)).all()).toHaveLength(1);
  });
});
