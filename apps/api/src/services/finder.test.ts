import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as t from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { listReceivedLetters } from './bottles.js';
import { blockFoundWriter, listFriends } from './friends.js';
import { reportLetter } from './moderation.js';
import { closeReading, devLoseBottle, openPublicBottle } from './outcomes.js';
import { releaseBottle } from './release.js';
import { createTestWorld, releaseInput } from '../test/harness.js';

// Product decision 12 (amended 2026-09-26): a finder gets one reading, once. The letter is served
// in the opening response and never again — no resumable window, no second opening after a
// refresh. It never enters their Received list, archive or history, and finding it creates no
// friendship or access to the sender. Reporting and blocking are available while the reading is
// open; finishing it ends the reading.

function found() {
  const w = createTestWorld({ defaultShoreCapacity: 40 });
  const id = releaseBottle(
    w.ctx,
    w.user('ada'),
    releaseInput(w.user('bo').id, 'finder-00000001'),
  ).bottleId;
  devLoseBottle(w.ctx, w.user('ada'), id, 'adrift');
  return { w, id, cy: w.user('cy') };
}

describe('finding a bottle adrift (product decision 12)', () => {
  it('serves the letter once and never again, with nothing permanent', () => {
    const { w, id, cy } = found();
    const friendsBefore = listFriends(w.ctx, cy.id).friends.map((f) => f.id);
    const opened = openPublicBottle(w.ctx, cy, id);
    expect(opened.letter.text.length).toBeGreaterThan(0);
    // Reporting is available while the reading is open.
    expect(() =>
      reportLetter(w.ctx, cy, { bottleId: id, reason: 'spam', hide: false }),
    ).not.toThrow();
    // Never an archive entry, never a friendship.
    expect(listReceivedLetters(w.ctx, cy)).toEqual([]);
    expect(listFriends(w.ctx, cy.id).friends.map((f) => f.id)).toEqual(friendsBefore);
    // One second later — a refresh, a new tab: nothing is served, whatever the clock says.
    w.clock.advance(1000);
    w.realClock.advance(1000);
    expect(() => openPublicBottle(w.ctx, cy, id)).toThrow(AppError);
    expect(w.db.select().from(t.publicOpenings).all()).toHaveLength(1);
  });

  it('lets the finder block the writer while reading, and not after finishing', () => {
    const { w, id, cy } = found();
    openPublicBottle(w.ctx, cy, id);
    closeReading(w.ctx, cy, id);
    expect(
      w.db.select().from(t.publicOpenings).where(eq(t.publicOpenings.bottleId, id)).get()
        ?.closedAt,
    ).not.toBeNull();
    expect(() => blockFoundWriter(w.ctx, cy.id, id)).toThrow(AppError);

    const other = found();
    openPublicBottle(other.w.ctx, other.cy, other.id);
    expect(() => blockFoundWriter(other.w.ctx, other.cy.id, other.id)).not.toThrow();
  });
});
