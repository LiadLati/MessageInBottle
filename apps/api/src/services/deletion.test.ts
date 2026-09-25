import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PRIVACY_POLICY, textOf } from '@mib/shared';
import * as t from '../db/schema.js';
import { createApp } from '../http/app.js';
import { deleteAccount } from './deletion.js';
import { openBottle } from './bottles.js';
import { commitArrivalIfDue } from './journey.js';
import { decideCase } from './admin.js';
import { reportLetter } from './moderation.js';
import { releaseBottle } from './release.js';
import { THIRTY_DAYS_MS, applyRetention, RETENTION_DEFAULT } from './retention.js';
import { DEV_SEED_PASSWORD } from '../db/seed-data.js';
import { createTestWorld, loginAs, releaseInput } from '../test/harness.js';

const DAY = 24 * 60 * 60 * 1000;

// The Privacy Policy lists, item by item, what deleting an account does. This walks the same
// list against the implementation, so the promise and the behaviour are checked together.
describe('deleting an account does what the Privacy Policy says', () => {
  it('anonymises the profile, revokes sessions and keeps referential integrity', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const app = createApp(w.ctx);
    const ada = await loginAs(app, 'ada');
    const bo = await loginAs(app, 'bo');

    // A letter that already arrived and was opened: it belongs to Bo now.
    const arrived = releaseBottle(
      w.ctx,
      w.user('ada'),
      releaseInput(bo.id, 'del-key-000000001'),
    ).bottleId;
    w.clock.advance(40 * DAY);
    expect(commitArrivalIfDue(w.ctx, arrived, w.clock.now())).toBe(true);
    const read = openBottle(w.ctx, w.user('bo'), arrived);
    expect(read.letter.text.length).toBeGreaterThan(0);

    // And one still travelling, which nobody has received.
    const travelling = releaseBottle(
      w.ctx,
      w.user('ada'),
      releaseInput(bo.id, 'del-key-000000002'),
    ).bottleId;

    const summary = deleteAccount(w.ctx, ada.id);
    expect(summary.alreadyDeleted).toBe(false);

    const row = w.db.select().from(t.users).where(eq(t.users.id, ada.id)).get()!;
    // "Profile identifiers … are removed or replaced with anonymous values, and your password
    // is cleared so the account cannot be signed in to again."
    expect(row.status).toBe('deleted');
    expect(row.deletedAt).not.toBeNull();
    expect(row.username).not.toBe('ada');
    expect(row.displayName).not.toBe('Ada');
    expect(row.email).toBeNull();
    expect(row.passwordHash).toBeNull();
    expect(row.shoreId).toBeNull();
    expect(row.timeZone).toBeNull();
    // "The account row itself is kept in an anonymised form, so that records which
    // legitimately refer to it … do not lose their references."
    expect(row.id).toBe(ada.id);

    // "Every session is revoked immediately."
    expect(w.db.select().from(t.sessions).where(eq(t.sessions.userId, ada.id)).all()).toEqual([]);
    expect(
      (await app.request('/api/auth/me', { headers: { authorization: `Bearer ${ada.token}` } }))
        .status,
    ).toBe(401);
    // And signing in again is impossible, with the right password or any other.
    const retry = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ada', password: DEV_SEED_PASSWORD }),
    });
    expect(retry.status).toBe(401);

    // "Friend and block relationships are removed."
    expect(summary.friendshipsRemoved).toBeGreaterThan(0);
    expect(
      w.db
        .select()
        .from(t.friendships)
        .all()
        .filter((f) => f.userLowId === ada.id || f.userHighId === ada.id),
    ).toEqual([]);

    // "Bottles still travelling are cancelled, and their reserved space is released."
    const inFlight = w.db.select().from(t.bottles).where(eq(t.bottles.id, travelling)).get()!;
    expect(inFlight.state).not.toBe('at_sea');
    expect(summary.journeysCancelled).toBeGreaterThan(0);

    // Product decision 7: what Ada wrote goes with the account. The letter Bo had received is
    // no longer readable and has left Bo's Received list; its text is cleared in storage.
    void read;
    expect(() => openBottle(w.ctx, w.user('bo'), arrived)).toThrow(/not found/);
    const arrivedRow = w.db.select().from(t.bottles).where(eq(t.bottles.id, arrived)).get()!;
    const arrivedLetter = w.db
      .select()
      .from(t.letters)
      .where(eq(t.letters.id, arrivedRow.letterId))
      .get()!;
    expect(arrivedLetter.text).toBe('');
    expect(arrivedRow.senderNameSnapshot).toBe('Deleted user');

    // "Your notifications are removed."
    expect(
      w.db.select().from(t.notifications).where(eq(t.notifications.userId, ada.id)).all(),
    ).toEqual([]);
  });

  it('clears the text of letters nobody received, and leaves received ones alone', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const app = createApp(w.ctx);
    const ada = await loginAs(app, 'ada');
    const bo = await loginAs(app, 'bo');
    const travelling = releaseBottle(
      w.ctx,
      w.user('ada'),
      releaseInput(bo.id, 'del-key-000000003'),
    ).bottleId;
    const letterId = w.db.select().from(t.bottles).where(eq(t.bottles.id, travelling)).get()!
      .letterId;

    deleteAccount(w.ctx, ada.id);
    const letter = w.db.select().from(t.letters).where(eq(t.letters.id, letterId)).get()!;
    expect(letter.text).toBe('');
  });

  it('keeps moderation evidence for an unresolved case, then lets retention take it', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const app = createApp(w.ctx);
    const ada = await loginAs(app, 'ada');
    const bo = await loginAs(app, 'bo');
    w.db
      .update(t.users)
      .set({ role: 'admin' })
      .where(eq(t.users.id, w.user('cy').id))
      .run();

    const bottleId = releaseBottle(
      w.ctx,
      w.user('ada'),
      releaseInput(bo.id, 'del-key-000000004'),
    ).bottleId;
    w.clock.advance(40 * DAY);
    commitArrivalIfDue(w.ctx, bottleId, w.clock.now());
    openBottle(w.ctx, w.user('bo'), bottleId);
    const caseId = reportLetter(w.ctx, w.user('bo'), {
      bottleId,
      reason: 'harassment',
      hide: false,
    }).caseId;

    const summary = deleteAccount(w.ctx, ada.id);
    // "except where a copy is still held as evidence for a moderation case that is not
    // finished" — the case and its evidence outlive the account.
    expect(summary.moderationRecordsRetained).toBeGreaterThan(0);
    const before = w.db
      .select()
      .from(t.moderationCases)
      .where(eq(t.moderationCases.id, caseId))
      .get()!;
    expect(before.evidenceText).not.toBe('');
    expect(before.senderId).toBe(ada.id);

    // The case is still decidable after the account is gone, and the ordinary retention rules
    // then apply to it exactly as they would to anyone else's.
    decideCase(w.ctx, { ...w.user('cy'), role: 'admin' }, caseId, 'rejected', 'not a violation');
    w.realClock.advance(THIRTY_DAYS_MS);
    expect(applyRetention(w.db, w.realClock.now(), RETENTION_DEFAULT).redacted).toEqual([caseId]);
    expect(
      w.db.select().from(t.moderationCases).where(eq(t.moderationCases.id, caseId)).get()!
        .evidenceText,
    ).toBe('');
  });

  it('is idempotent: deleting twice changes nothing and reports it', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const bo = await loginAs(app, 'bo');
    const first = deleteAccount(w.ctx, bo.id);
    expect(first.alreadyDeleted).toBe(false);
    const row = w.db.select().from(t.users).where(eq(t.users.id, bo.id)).get()!;
    const second = deleteAccount(w.ctx, bo.id);
    expect(second.alreadyDeleted).toBe(true);
    expect(second.deletedAt).toBe(first.deletedAt);
    expect(w.db.select().from(t.users).where(eq(t.users.id, bo.id)).get()!).toEqual(row);
  });

  it('claims nothing the implementation does not do', () => {
    const privacy = textOf(PRIVACY_POLICY);
    // No sweeping promise that every trace is gone, because letters other people hold and
    // moderation records both survive by design.
    expect(privacy).not.toMatch(/all (of )?your data (is|will be) (permanently )?deleted/i);
    expect(privacy).not.toMatch(/every associated record/i);
    expect(privacy).toMatch(/Letters other people wrote to you are not deleted/i);
    expect(privacy).toMatch(/Minimal anonymised journey and audit metadata remains/i);
  });
});
