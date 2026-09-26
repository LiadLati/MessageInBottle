import { describe, expect, it } from 'vitest';
import * as t from '../db/schema.js';
import { listReceivedLetters } from './bottles.js';
import { listFriends } from './friends.js';
import { reportLetter } from './moderation.js';
import { READING_SESSION_MS, activeReading, devLoseBottle, openPublicBottle } from './outcomes.js';
import { releaseBottle } from './release.js';
import { createTestWorld, releaseInput } from '../test/harness.js';

// Product decision 12 (final): a finder gets one reading session, resumable for 15 minutes; the
// letter never enters their Received list, archive or history, and finding it creates no
// friendship or access to the sender. Reporting stays available during the session.

describe('finding a bottle adrift (product decision 12)', () => {
  it('gives one resumable 15-minute reading and nothing permanent', () => {
    const w = createTestWorld({ defaultShoreCapacity: 40 });
    const id = releaseBottle(
      w.ctx,
      w.user('ada'),
      releaseInput(w.user('bo').id, 'finder-00000001'),
    ).bottleId;
    devLoseBottle(w.ctx, w.user('ada'), id, 'adrift');
    const cy = w.user('cy');
    const friendsBefore = listFriends(w.ctx, cy.id).friends.map((f) => f.id);

    expect(READING_SESSION_MS).toBe(15 * 60 * 1000);
    openPublicBottle(w.ctx, cy, id);
    // Interrupted and resumed within the window.
    w.clock.advance(READING_SESSION_MS - 1000);
    w.realClock.advance(READING_SESSION_MS - 1000);
    expect(activeReading(w.ctx, cy)?.bottle.id).toBe(id);
    // Reporting is available during the session.
    expect(() =>
      reportLetter(w.ctx, cy, { bottleId: id, reason: 'spam', hide: false }),
    ).not.toThrow();
    // Never an archive entry, never a friendship.
    expect(listReceivedLetters(w.ctx, cy)).toEqual([]);
    expect(listFriends(w.ctx, cy.id).friends.map((f) => f.id)).toEqual(friendsBefore);
    // After the window, nothing to resume and no second opening.
    w.clock.advance(2000);
    w.realClock.advance(2000);
    expect(activeReading(w.ctx, cy)).toBeNull();
    expect(() => openPublicBottle(w.ctx, cy, id)).toThrow();
    expect(w.db.select().from(t.publicOpenings).all()).toHaveLength(1);
  });
});
