import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as t from '../db/schema.js';
import { placeHold } from './admin.js';
import { getSentBottle, listReceivedLetters, openBottle } from './bottles.js';
import { deleteAccount } from './deletion.js';
import { commitArrivalIfDue } from './journey.js';
import { reportLetter } from './moderation.js';
import { heldForRecipient, releaseBottle } from './release.js';
import { createTestWorld, releaseInput } from '../test/harness.js';

// Product decision 7: deleting an account removes what it owned and wrote, keeps other people's
// own records (anonymised), and keeps only what a hold or the audit genuinely needs.

const DAY = 24 * 60 * 60 * 1000;
let n = 0;
const key = () => `acct-del-${String(++n).padStart(8, '0')}`;

describe('account deletion and minimisation (product decision 7)', () => {
  it('keeps letters others wrote TO the account in their Sent history, as "Deleted user"', () => {
    const w = createTestWorld({ defaultShoreCapacity: 40 });
    const toAda = releaseBottle(
      w.ctx,
      w.user('bo'),
      releaseInput(w.user('ada').id, key()),
    ).bottleId;
    w.clock.advance(60 * DAY);
    commitArrivalIfDue(w.ctx, toAda, w.clock.now());
    openBottle(w.ctx, w.user('ada'), toAda);
    deleteAccount(w.ctx, w.user('ada').id);
    const sent = getSentBottle(w.ctx, w.user('bo'), toAda);
    expect(sent.recipient.displayName).toBe('Deleted user');
    // Bo's own words are Bo's: untouched.
    expect(sent.letter.text.length).toBeGreaterThan(0);
  });

  it('removes what it wrote from other people’s shores and Received lists, freeing their places', () => {
    const w = createTestWorld({ defaultShoreCapacity: 40 });
    const opened = releaseBottle(
      w.ctx,
      w.user('ada'),
      releaseInput(w.user('bo').id, key()),
    ).bottleId;
    const waiting = releaseBottle(
      w.ctx,
      w.user('ada'),
      releaseInput(w.user('bo').id, key()),
    ).bottleId;
    w.clock.advance(60 * DAY);
    commitArrivalIfDue(w.ctx, opened, w.clock.now());
    commitArrivalIfDue(w.ctx, waiting, w.clock.now());
    openBottle(w.ctx, w.user('bo'), opened);
    expect(heldForRecipient(w.db, w.user('bo').id)).toBe(1);
    deleteAccount(w.ctx, w.user('ada').id);
    expect(listReceivedLetters(w.ctx, w.user('bo'))).toEqual([]);
    expect(heldForRecipient(w.db, w.user('bo').id)).toBe(0);
    expect(() => openBottle(w.ctx, w.user('bo'), waiting)).toThrow();
    const texts = w.db.select({ text: t.letters.text }).from(t.letters).all();
    expect(texts.every((l) => l.text === '')).toBe(true);
  });

  it('keeps an authored letter only while a documented hold covers it', () => {
    const w = createTestWorld({ defaultShoreCapacity: 40 });
    w.db
      .update(t.users)
      .set({ role: 'admin' })
      .where(eq(t.users.id, w.user('cy').id))
      .run();
    const id = releaseBottle(w.ctx, w.user('ada'), releaseInput(w.user('bo').id, key())).bottleId;
    w.clock.advance(60 * DAY);
    commitArrivalIfDue(w.ctx, id, w.clock.now());
    openBottle(w.ctx, w.user('bo'), id);
    const caseId = reportLetter(w.ctx, w.user('bo'), {
      bottleId: id,
      reason: 'sexual',
      hide: true,
    }).caseId;
    placeHold(w.ctx, { ...w.user('cy'), role: 'admin' }, caseId, 'child_safety', 'referral 7');
    deleteAccount(w.ctx, w.user('ada').id);
    const bottle = w.db.select().from(t.bottles).where(eq(t.bottles.id, id)).get()!;
    const letter = w.db.select().from(t.letters).where(eq(t.letters.id, bottle.letterId)).get()!;
    expect(letter.text.length).toBeGreaterThan(0);
    const kase = w.db
      .select()
      .from(t.moderationCases)
      .where(eq(t.moderationCases.id, caseId))
      .get()!;
    expect(kase.evidenceText.length).toBeGreaterThan(0);
  });

  it('removes identifiers, credentials, preferences and policy records; keeps a bare tombstone', () => {
    const w = createTestWorld({ defaultShoreCapacity: 40 });
    const ada = w.user('ada');
    w.db
      .update(t.users)
      .set({ email: 'ada@example.test', timeZone: 'Europe/Berlin', shoreFullSince: 1 })
      .where(eq(t.users.id, ada.id))
      .run();
    w.db
      .insert(t.policyAcceptances)
      .values({
        id: 'pac_ada',
        userId: ada.id,
        document: 'terms',
        version: '1.0',
        action: 'accepted',
        source: 'registration',
        acceptedAt: 0,
      })
      .run();
    deleteAccount(w.ctx, ada.id);
    const row = w.db.select().from(t.users).where(eq(t.users.id, ada.id)).get()!;
    expect(row).toMatchObject({
      displayName: 'Deleted user',
      email: null,
      passwordHash: null,
      timeZone: null,
      timeZoneSince: null,
      shoreId: null,
      shoreFullSince: null,
      status: 'deleted',
    });
    expect(row.username).toMatch(/^deleted_[a-z0-9_-]{16}$/i);
    expect(row.username).not.toContain('ada');
    for (const table of [
      t.sessions,
      t.passwordResets,
      t.notifications,
      t.policyAcceptances,
    ] as const)
      expect(
        w.db
          .select()
          .from(table)
          .all()
          .filter((r) => (r as { userId?: string }).userId === ada.id),
      ).toEqual([]);
  });
});
