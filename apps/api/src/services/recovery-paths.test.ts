import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { RISK_POLICY_VERSION, nightWindow, phaseAt } from '@mib/shared';
import * as t from '../db/schema.js';
import { createApp } from '../http/app.js';
import { decideCase, getCase } from './admin.js';
import { createOllamaReviewer, retryDelayMs, runAiReviewTick } from './ai-review.js';
import { setAccountTimeZone } from './auth.js';
import { openBottle } from './bottles.js';
import type { AuthUser } from './context.js';
import { commitArrivalIfDue } from './journey.js';
import { reportLetter, standingOf } from './moderation.js';
import { ReleaseRejectedError, releaseBottle } from './release.js';
import { processRiskDecisions } from './risk.js';
import { canonicalPair } from './friends.js';
import { T0, createTestWorld, loginAs, releaseInput, type TestWorld } from '../test/harness.js';

// Audit QA-024: recovery paths that had no coverage at any level and can be exercised in one
// process. (Two API processes are refused by the process lock, which has its own test.)

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
let n = 0;
const key = () => `recovery-${String(++n).padStart(8, '0')}`;

// A letter from `from`, arrived on `to`'s shore, opened there and reported by `to`.
function reportedLetter(w: TestWorld, from: string, to: string): string {
  const id = releaseBottle(w.ctx, w.user(from), releaseInput(w.user(to).id, key())).bottleId;
  w.clock.advance(60 * DAY);
  expect(commitArrivalIfDue(w.ctx, id, w.clock.now())).toBe(true);
  openBottle(w.ctx, w.user(to), id);
  return reportLetter(w.ctx, w.user(to), { bottleId: id, reason: 'harassment', hide: false })
    .caseId;
}

function rejection(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof ReleaseRejectedError) return err.rejection;
    throw err;
  }
  return undefined;
}

describe('release to a deleted or suspended recipient', () => {
  it('refuses a deleted recipient with the generic "not available", writing nothing', () => {
    const w = createTestWorld({ defaultShoreCapacity: 20 });
    w.db
      .update(t.users)
      .set({ status: 'deleted', deletedAt: w.realClock.now() })
      .where(eq(t.users.id, w.user('bo').id))
      .run();
    const bottlesBefore = w.db.select().from(t.bottles).all().length;
    expect(
      rejection(() => releaseBottle(w.ctx, w.user('ada'), releaseInput(w.user('bo').id, key()))),
    ).toBe('recipient_not_found');
    expect(w.db.select().from(t.bottles).all()).toHaveLength(bottlesBefore);
    expect(
      w.db
        .select()
        .from(t.capacityReservations)
        .all()
        .filter((r) => r.status === 'held'),
    ).toEqual([]);
  });

  it('refuses over HTTP with 422 and the same non-disclosing rejection', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 20 });
    const app = createApp(w.ctx);
    const ada = await loginAs(app, 'ada');
    w.db
      .update(t.users)
      .set({ status: 'deleted', deletedAt: w.realClock.now() })
      .where(eq(t.users.id, w.user('bo').id))
      .run();
    const res = await app.request('/api/bottles/release', {
      method: 'POST',
      headers: { authorization: `Bearer ${ada.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(releaseInput(w.user('bo').id, key())),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { details: { rejection: string } } };
    expect(body.error.details.rejection).toBe('recipient_not_found');
  });

  // A suspended account is unavailable as a recipient; the sender is refused generically
  // (product decision 14).
  it('refuses a release to a suspended recipient, generically, and allows it after (decision 14)', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 20 });
    w.db
      .update(t.users)
      .set({ role: 'admin' })
      .where(eq(t.users.id, w.user('cy').id))
      .run();
    const admin: AuthUser = { ...w.user('cy'), role: 'admin' };
    // Two upheld reports against Bo: suspended for seven days.
    for (let i = 0; i < 2; i++)
      decideCase(w.ctx, admin, reportedLetter(w, 'bo', 'ada'), 'accepted', 'upheld');
    expect(standingOf(w.db, w.user('bo').id, w.realClock.now()).standing).toBe('suspended');

    const app = createApp(w.ctx);
    const ada = await loginAs(app, 'ada');
    const send = (token: string) =>
      app.request('/api/bottles/release', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(releaseInput(w.user('bo').id, key())),
      });
    const refused = await send(ada.token);
    expect(refused.status).toBe(422);
    const body = JSON.stringify(await refused.json());
    expect(body).toMatch(/recipient_unavailable/);
    expect(body).not.toMatch(/suspend/i);
    // Restored automatically when the server-controlled suspension ends.
    w.realClock.advance(8 * DAY);
    const again = await loginAs(app, 'ada');
    expect((await send(again.token)).status).toBe(201);
  });
});

describe('AI review timeout, distinct from connection refused', () => {
  it('aborts a model that never answers after config.ai.timeoutMs and keeps the case queued', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 20 });
    const caseId = reportedLetter(w, 'ada', 'bo');
    let signal: AbortSignal | undefined;
    // A model that accepts the connection and then says nothing, until the caller gives up.
    const hanging = ((_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal!.reason as Error));
      });
    }) as typeof fetch;
    const timeoutMs = 25;
    const reviewer = createOllamaReviewer({ ...w.ctx.config.ai, timeoutMs }, hanging);

    const now = w.realClock.now();
    const started = Date.now();
    expect(await runAiReviewTick(w.ctx, reviewer, now)).toEqual({
      reviewed: 0,
      deferred: 1,
    });
    const elapsed = Date.now() - started;
    expect(signal?.aborted).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 5);
    expect(elapsed).toBeLessThan(5000);

    const c = getCase(w.ctx, caseId);
    expect(c.status).toBe('pending');
    expect(c.ai.status).toBe('queued');
    expect(c.ai.attempts).toBe(1);
    // Recorded as a timeout (an abort), not as the connection-refused message.
    expect(c.ai.lastError).toMatch(/abort/i);
    expect(c.ai.lastError).not.toContain('ECONNREFUSED');
    // Same back-off as an unreachable model: a timeout never decides a case.
    expect(Date.parse(c.ai.nextAttemptAt!)).toBe(now + retryDelayMs(1));
  });
});

describe('extreme account zones (date line): nights and storm decisions', () => {
  // UTC+14 and UTC-11, no daylight saving: 26 hours apart on the wall clock.
  const cases = [
    {
      zone: 'Pacific/Kiritimati',
      night: { startsAt: '2026-09-06T05:00:00.000Z', endsAt: '2026-09-06T17:00:00.000Z' },
    },
    {
      zone: 'Pacific/Pago_Pago',
      night: { startsAt: '2026-09-07T06:00:00.000Z', endsAt: '2026-09-07T18:00:00.000Z' },
    },
  ];

  for (const { zone, night } of cases) {
    it(`${zone}: 19:00-07:00 local nights, contiguous, and every decision inside one`, () => {
      expect(nightWindow('2026-09-06', zone)).toEqual({
        key: '2026-09-06',
        startsAt: Date.parse(night.startsAt),
        endsAt: Date.parse(night.endsAt),
      });
      const w = createTestWorld({ msPerChartUnit: 24 * HOUR, minJourneyMs: 20 * DAY });
      // A fixed account id, so its storms are the same on every run (they hash the id).
      const sender = `usr_dateline_${zone.split('/')[1]!.toLowerCase()}`;
      const bo = w.user('bo').id;
      w.db
        .insert(t.users)
        .values({
          id: sender,
          username: sender,
          displayName: 'D',
          shoreId: 'shore_lantern_cove',
          createdAt: T0,
        })
        .run();
      const [low, high] = canonicalPair(sender, bo);
      w.db
        .insert(t.friendships)
        .values({
          id: `frd_${sender}`,
          userLowId: low,
          userHighId: high,
          requestedById: sender,
          status: 'accepted',
          createdAt: T0,
          acceptedAt: T0,
        })
        .run();
      setAccountTimeZone(w.ctx, w.user(sender), zone);
      const ids = ['a', 'b', 'c'].map(
        (k) => releaseBottle(w.ctx, w.user(sender), releaseInput(bo, key() + k)).bottleId,
      );
      w.clock.set(T0 + 12 * DAY);
      processRiskDecisions(w.ctx, w.clock.now());
      // One roll per local night, at 19:00, across the date line, never two within 24 hours.
      // (Kiritimati is already in its night at T0, when the clock starts: that counts as
      // entering it, so the dusk 17 hours later gets no roll, and 19:00 rolls resume after.)
      const rolls = w.db.select().from(t.weatherRolls).orderBy(t.weatherRolls.rolledAt).all();
      expect(rolls.length).toBeGreaterThanOrEqual(10);
      for (let i = 0; i < rolls.length; i++) {
        const r = rolls[i]!;
        expect(r.zone).toBe(zone);
        expect(r.rolledAt).toBe(i === 0 && phaseAt(T0, zone) === 'night' ? T0 : r.nightStartsAt);
        expect(r.nightEndsAt - r.nightStartsAt).toBe(12 * HOUR);
        expect(phaseAt(r.nightStartsAt, zone)).toBe('night');
        expect(phaseAt(r.nightStartsAt - 1, zone)).toBe('day');
        expect(phaseAt(r.nightEndsAt, zone)).toBe('day');
        if (i > 1) expect(r.rolledAt - rolls[i - 1]!.rolledAt).toBe(DAY);
        if (i > 0) expect(r.rolledAt - rolls[i - 1]!.rolledAt).toBeGreaterThanOrEqual(DAY);
      }
      // Every storm decision sits inside its account storm, in the local night, one per bottle.
      const storms = rolls.filter((r) => r.outcome === 'storm' && r.decisionAt! <= w.clock.now());
      expect(storms.length).toBeGreaterThan(0);
      const decisions = w.db.select().from(t.riskDecisions).all();
      for (const d of decisions) {
        const roll = storms.find((r) => r.id === d.nightKey)!;
        expect(d.decisionAt).toBe(roll.decisionAt);
        expect(d.policyVersion).toBe(RISK_POLICY_VERSION);
        expect(phaseAt(d.decisionAt, zone)).toBe('night');
      }
      for (const r of storms)
        expect(decisions.filter((d) => d.nightKey === r.id).length).toBeLessThanOrEqual(ids.length);
    });
  }
});
