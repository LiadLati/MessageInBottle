import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as t from '../db/schema.js';
import { createApp } from '../http/app.js';
import { decideCase } from './admin.js';
import {
  releaseStaleAiClaims,
  runAiReviewTick,
  staleClaimAfterMs,
  type AiReviewer,
} from './ai-review.js';
import { blockUser } from './friends.js';
import { deleteAccount } from './deletion.js';
import { commitArrivalIfDue } from './journey.js';
import { reportLetter } from './moderation.js';
import { openBottle } from './bottles.js';
import { commitLoss, listPublicOcean, openPublicBottle } from './outcomes.js';
import { releaseBottle } from './release.js';
import { THIRTY_DAYS_MS, finalityOf, planRetention, RETENTION_DEFAULT } from './retention.js';
import { backfillDeletedAccounts } from '../tools/deletion-backfill.js';
import { createTestWorld, loginAs, releaseInput, type TestWorld } from '../test/harness.js';

const DAY = 24 * 60 * 60 * 1000;
let n = 0;
const send = (w: TestWorld, from: string, to: string) =>
  releaseBottle(
    w.ctx,
    w.user(from),
    releaseInput(w.user(to).id, `sweep-key-${String(++n).padStart(8, '0')}`),
  ).bottleId;
const bottle = (w: TestWorld, id: string) =>
  w.db.select().from(t.bottles).where(eq(t.bottles.id, id)).get()!;
const letterText = (w: TestWorld, id: string) =>
  w.db
    .select()
    .from(t.letters)
    .where(eq(t.letters.id, bottle(w, id).letterId))
    .get()!.text;
const reservation = (w: TestWorld, id: string) =>
  w.db.select().from(t.capacityReservations).where(eq(t.capacityReservations.bottleId, id)).get()!;
const lose = (w: TestWorld, id: string, reason: 'adrift' | 'sunk') => {
  w.clock.advance(60 * 60 * 1000);
  expect(commitLoss(w.ctx, id, reason, w.clock.now()).committed).toBe(true);
};

describe('deleting a sender withdraws their lost letters (ARCH-002 / SEC-002)', () => {
  it('removes an adrift letter from the public ocean and clears its text', () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const id = send(w, 'ada', 'bo');
    lose(w, id, 'adrift');
    expect(listPublicOcean(w.ctx, w.user('cy')).map((b) => b.id)).toContain(id);

    deleteAccount(w.ctx, w.user('ada').id);

    expect(listPublicOcean(w.ctx, w.user('cy')).map((b) => b.id)).not.toContain(id);
    expect(() => openPublicBottle(w.ctx, w.user('cy'), id)).toThrow();
    expect(letterText(w, id)).toBe('');
    expect(bottle(w, id).publicExpiredAt).not.toBeNull();
  });

  it("ends a finder's reading that is in progress", () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const id = send(w, 'ada', 'bo');
    lose(w, id, 'adrift');
    openPublicBottle(w.ctx, w.user('cy'), id);
    const opening = () =>
      w.db.select().from(t.publicOpenings).where(eq(t.publicOpenings.bottleId, id)).get()!;
    expect(opening().closedAt).toBeNull();

    deleteAccount(w.ctx, w.user('ada').id);
    expect(opening().closedAt).not.toBeNull();
    expect(() => openPublicBottle(w.ctx, w.user('cy'), id)).toThrow();
  });

  it('clears the text of a sunk letter', () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const id = send(w, 'ada', 'bo');
    lose(w, id, 'sunk');
    deleteAccount(w.ctx, w.user('ada').id);
    expect(letterText(w, id)).toBe('');
  });
});

describe('deleting a recipient ends journeys to them (ARCH-014 / QA-005)', () => {
  it('cancels a letter still at sea, frees its place and tells only the sender', () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const bo = w.user('bo').id;
    const id = send(w, 'ada', 'bo');
    expect(reservation(w, id).status).toBe('held');

    const summary = deleteAccount(w.ctx, bo);
    expect(summary.inboundJourneysEnded).toBe(1);
    expect(bottle(w, id).state).toBe('cancelled');
    expect(reservation(w, id).status).toBe('released');
    // Even if the worker runs past the planned arrival, nothing is delivered.
    w.clock.advance(60 * DAY);
    expect(commitArrivalIfDue(w.ctx, id, w.clock.now())).toBe(false);
    expect(w.db.select().from(t.notifications).where(eq(t.notifications.userId, bo)).all()).toEqual(
      [],
    );
    const senderNotes = w.db
      .select()
      .from(t.notifications)
      .where(and(eq(t.notifications.userId, w.user('ada').id), eq(t.notifications.bottleId, id)))
      .all();
    expect(senderNotes.map((x) => x.message)).toContain(
      'Delivery unavailable. The journey has ended.',
    );
    // The sender's own letter is theirs: it is not cleared.
    expect(letterText(w, id)).not.toBe('');
  });

  it('frees the place held by a letter that arrived but was never opened', () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const id = send(w, 'ada', 'bo');
    w.clock.advance(60 * DAY);
    expect(commitArrivalIfDue(w.ctx, id, w.clock.now())).toBe(true);
    expect(reservation(w, id).status).toBe('held');
    deleteAccount(w.ctx, w.user('bo').id);
    expect(reservation(w, id).status).toBe('released');
  });

  it('refuses arrival to a recipient who is gone, even without the sweep', () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const id = send(w, 'ada', 'bo');
    w.db
      .update(t.users)
      .set({ status: 'deleted' })
      .where(eq(t.users.id, w.user('bo').id))
      .run();
    w.clock.advance(60 * DAY);
    expect(commitArrivalIfDue(w.ctx, id, w.clock.now())).toBe(true);
    expect(bottle(w, id).state).toBe('cancelled');
    expect(reservation(w, id).status).toBe('released');
  });

  it('refuses arrival when the SENDER blocked the recipient during the journey', () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const id = send(w, 'ada', 'bo');
    blockUser(w.ctx, w.user('ada').id, 'bo');
    w.clock.advance(60 * DAY);
    commitArrivalIfDue(w.ctx, id, w.clock.now());
    expect(bottle(w, id).state).toBe('cancelled');
  });
});

describe("a deleted sender's moderation evidence becomes final (SEC-012)", () => {
  it('closes the unused appeal at deletion, audits it, and lets retention redact after seven days', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const app = createApp(w.ctx);
    await loginAs(app, 'bo');
    w.db
      .update(t.users)
      .set({ role: 'admin' })
      .where(eq(t.users.id, w.user('cy').id))
      .run();
    const id = send(w, 'ada', 'bo');
    w.clock.advance(60 * DAY);
    commitArrivalIfDue(w.ctx, id, w.clock.now());
    openBottle(w.ctx, w.user('bo'), id);
    const caseId = reportLetter(w.ctx, w.user('bo'), {
      bottleId: id,
      reason: 'harassment',
      hide: false,
    }).caseId;
    decideCase(w.ctx, { ...w.user('cy'), role: 'admin' }, caseId, 'accepted', 'upheld');
    const kase = () =>
      w.db.select().from(t.moderationCases).where(eq(t.moderationCases.id, caseId)).get()!;
    // The 30 days run from the decision whatever the sender does (product decision 5).
    const redactableAt = finalityOf(w.db, kase()).redactableAt;
    expect(redactableAt).toBe(w.realClock.now() + THIRTY_DAYS_MS);

    const ada = w.user('ada').id;
    deleteAccount(w.ctx, ada);

    // Deleting the account closes its unused appeal on the record; it neither shortens nor
    // extends the window.
    expect(finalityOf(w.db, kase()).redactableAt).toBe(redactableAt);
    const audit = w.db
      .select()
      .from(t.moderationAudit)
      .where(
        and(
          eq(t.moderationAudit.subjectUserId, ada),
          eq(t.moderationAudit.action, 'appeal_waived'),
        ),
      )
      .all();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorRole).toBe('system');
    expect(audit[0]!.reason).toBe('account deleted');

    const later = redactableAt! + 1;
    expect(planRetention(w.db, later, RETENTION_DEFAULT).redactable).toContain(caseId);
  });
});

describe('an interrupted AI review no longer holds evidence forever (ARCH-003)', () => {
  it('returns stale running claims to the queue', () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const id = send(w, 'ada', 'bo');
    w.clock.advance(60 * DAY);
    commitArrivalIfDue(w.ctx, id, w.clock.now());
    openBottle(w.ctx, w.user('bo'), id);
    const caseId = reportLetter(w.ctx, w.user('bo'), {
      bottleId: id,
      reason: 'harassment',
      hide: false,
    }).caseId;
    const now = w.realClock.now();
    w.db
      .update(t.moderationCases)
      .set({ aiStatus: 'running', aiStartedAt: now - 10 * 60 * 1000 })
      .where(eq(t.moderationCases.id, caseId))
      .run();
    // A recent claim is left alone; an old one, or any claim at startup, is released.
    expect(releaseStaleAiClaims(w.db, now, 60 * 60 * 1000)).toBe(0);
    expect(releaseStaleAiClaims(w.db, now, 5 * 60 * 1000)).toBe(1);
    const c = w.db.select().from(t.moderationCases).where(eq(t.moderationCases.id, caseId)).get()!;
    expect(c.aiStatus).toBe('queued');
    expect(c.aiLastError).toMatch(/interrupted/);
  });
});

// Audit QA-R-005: the release is tested where it runs, in the review worker's own tick, not
// only as a function. With AI review off the tick reviews nothing, and still releases.
describe('the review tick returns interrupted claims to the queue (ARCH-003 wiring)', () => {
  for (const enabled of [true, false])
    it(`does so with AI review ${enabled ? 'on' : 'off'}`, async () => {
      const w = createTestWorld({ defaultShoreCapacity: 80 });
      w.ctx.config.ai.enabled = enabled;
      const id = send(w, 'ada', 'bo');
      w.clock.advance(60 * DAY);
      commitArrivalIfDue(w.ctx, id, w.clock.now());
      openBottle(w.ctx, w.user('bo'), id);
      const caseId = reportLetter(w.ctx, w.user('bo'), {
        bottleId: id,
        reason: 'harassment',
        hide: false,
      }).caseId;
      const now = w.realClock.now();
      const stale = staleClaimAfterMs(w.ctx.config.ai.timeoutMs) + 1;
      w.db
        .update(t.moderationCases)
        .set({ aiStatus: 'running', aiStartedAt: now - stale, aiNextAttemptAt: now + DAY })
        .where(eq(t.moderationCases.id, caseId))
        .run();
      // A model that is never reached: whatever the tick does, it must not leave the claim.
      const unreachable: AiReviewer = { review: () => Promise.reject(new Error('model down')) };
      await runAiReviewTick(w.ctx, unreachable, now);
      const c = w.db
        .select()
        .from(t.moderationCases)
        .where(eq(t.moderationCases.id, caseId))
        .get()!;
      expect(c.aiStatus).toBe('queued');
    });
});

describe('backfill for accounts deleted before these rules (dry run by default)', () => {
  function oldStyleDeletion() {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const id = send(w, 'ada', 'bo');
    lose(w, id, 'adrift');
    // Deleted the way the code used to do it: status only, adrift letter left listed.
    w.db
      .update(t.users)
      .set({ status: 'deleted', deletedAt: w.realClock.now() })
      .where(eq(t.users.id, w.user('ada').id))
      .run();
    return { w, id };
  }

  it('reports without changing anything', () => {
    const { w, id } = oldStyleDeletion();
    const before = bottle(w, id);
    const report = backfillDeletedAccounts(w.db, w.clock.now(), false);
    expect(report.applied).toBe(false);
    expect(report.totals.adriftWithdrawn).toBe(1);
    expect(report.totals.lostLettersCleared).toBe(1);
    expect(bottle(w, id)).toEqual(before);
    expect(letterText(w, id)).not.toBe('');
  });

  it('applies idempotently', () => {
    const { w, id } = oldStyleDeletion();
    expect(backfillDeletedAccounts(w.db, w.clock.now(), true).totals.adriftWithdrawn).toBe(1);
    expect(letterText(w, id)).toBe('');
    expect(listPublicOcean(w.ctx, w.user('cy')).map((b) => b.id)).not.toContain(id);
    const again = backfillDeletedAccounts(w.db, w.clock.now(), true);
    expect(again.totals).toEqual({
      adriftWithdrawn: 0,
      lostLettersCleared: 0,
      inboundJourneysEnded: 0,
      harbourPlacesReleased: 0,
      appealsClosed: 0,
      sessionsRevoked: 0,
      journeysCancelled: 0,
      lettersClearedForSender: 0,
      friendshipsRemoved: 0,
      blocksRemoved: 0,
      notificationsRemoved: 0,
    });
  });

  // Audit ARCH-R-006 (and the backfill-counter gap in QA-R-006): an account deleted under the
  // oldest rules — status only — gets every current deletion rule, not just the later sweep.
  it('applies every current deletion rule to a status-only deletion, then nothing twice', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const app = createApp(w.ctx);
    await loginAs(app, 'ada');
    const atSea = send(w, 'ada', 'bo');
    const delivered = send(w, 'ada', 'cy');
    w.clock.advance(60 * DAY);
    commitArrivalIfDue(w.ctx, delivered, w.clock.now());
    const stillAtSea = send(w, 'ada', 'bo');
    void atSea;
    blockUser(w.ctx, w.user('ada').id, 'dee');
    const ada = w.user('ada');
    w.db
      .update(t.users)
      .set({ status: 'deleted', deletedAt: w.realClock.now() })
      .where(eq(t.users.id, ada.id))
      .run();
    const deletedAt = w.realClock.now();

    const report = backfillDeletedAccounts(w.db, w.clock.now(), true);
    expect(report.accounts).toBe(1);
    expect(report.totals.sessionsRevoked).toBeGreaterThan(0);
    expect(report.totals.journeysCancelled).toBeGreaterThan(0);
    expect(report.totals.lettersClearedForSender).toBeGreaterThan(0);
    expect(report.totals.friendshipsRemoved).toBeGreaterThan(0);
    expect(report.totals.blocksRemoved).toBe(1);
    expect(report.totals.notificationsRemoved).toBeGreaterThan(0);

    const row = w.db.select().from(t.users).where(eq(t.users.id, ada.id)).get()!;
    expect(row.username).toMatch(/^deleted_/);
    expect([row.email, row.passwordHash, row.shoreId]).toEqual([null, null, null]);
    expect(row.deletedAt).toBe(deletedAt);
    expect(bottle(w, stillAtSea).state).toBe('cancelled');
    expect(letterText(w, delivered)).toBe('');
    expect(w.db.select().from(t.sessions).where(eq(t.sessions.userId, ada.id)).all()).toEqual([]);

    const again = backfillDeletedAccounts(w.db, w.clock.now(), true);
    expect(Object.values(again.totals).every((n) => n === 0)).toBe(true);
    const same = w.db.select().from(t.users).where(eq(t.users.id, ada.id)).get()!;
    expect(same.username).toBe(row.username);
  });
});

describe('authenticated responses are not cached (SEC-016)', () => {
  it('sends no-store on API responses', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const { token } = await loginAs(app, 'ada');
    for (const path of ['/api/auth/me', '/api/shore', '/api/bottles/sent']) {
      const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
      expect(res.headers.get('cache-control'), path).toBe('no-store');
    }
  });
});
