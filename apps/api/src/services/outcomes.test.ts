import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { PublicBottleSchema } from '@mib/shared';
import * as t from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import {
  getMyShore,
  getSentBottle,
  listReceivedLetters,
  listSentBottles,
  readOpenedLetter,
  readOwnLetter,
} from './bottles.js';
import { blockUser } from './friends.js';
import { commitArrivalIfDue, runJourneyTick } from './journey.js';
import { listNotifications } from './notifications.js';
import {
  acknowledgeOutcome,
  commitLoss,
  devLoseBottle,
  listPublicOcean,
  markOutcomeSeen,
  openPublicBottle,
} from './outcomes.js';
import { heldReservations, releaseBottle } from './release.js';
import { createTestWorld, releaseInput, type TestWorld } from '../test/harness.js';

describe('journey outcomes: loss is server-owned, persisted once, and cannot race arrival', () => {
  let w: TestWorld;
  let bottleId: string;
  const ada = () => w.user('ada');
  const bo = () => w.user('bo');
  const cy = () => w.user('cy');
  const events = (id: string) =>
    w.db
      .select()
      .from(t.journeyEvents)
      .where(eq(t.journeyEvents.bottleId, id))
      .all()
      .map((e) => e.type);

  beforeEach(() => {
    w = createTestWorld();
    bottleId = releaseBottle(w.ctx, ada(), releaseInput(bo().id)).bottleId;
  });

  it('commits a loss at the persisted position, frees the slot, records history and tells only the sender', () => {
    const before = getSentBottle(w.ctx, ada(), bottleId);
    w.clock.advance(before.route.plannedDurationMs / 2);
    const at = w.clock.now();
    const res = commitLoss(w.ctx, bottleId, 'adrift', at);
    expect(res).toEqual({ committed: true, reason: 'committed' });

    const after = getSentBottle(w.ctx, ada(), bottleId);
    expect(after.state).toBe('lost');
    expect(after.outcome?.reason).toBe('adrift');
    expect(after.outcome?.at).toBe(new Date(at).toISOString());
    expect(after.outcome?.progress).toBeCloseTo(0.5, 5);
    expect(after.position.progress).toBeCloseTo(0.5, 5);
    expect(after.position.geo).toEqual(after.outcome?.position.geo);
    // The route snapshot is preserved and the elapsed time freezes at the outcome.
    expect(after.route.nodeIds).toEqual(before.route.nodeIds);
    expect(after.elapsedIsLive).toBe(false);
    expect(after.elapsedMs).toBe(before.route.plannedDurationMs / 2);
    expect(events(bottleId)).toEqual(['released', 'lost']);
    expect(heldReservations(w.db, 'shore_driftmoor_strand')).toBe(0);

    const senderNotes = listNotifications(w.ctx, ada().id);
    expect(senderNotes).toHaveLength(1);
    expect(senderNotes[0]!.type).toBe('journey_event');
    expect(senderNotes[0]!.message).toMatch(/adrift/);
    expect(listNotifications(w.ctx, bo().id)).toEqual([]);
    expect(getMyShore(w.ctx, bo()).bottles).toEqual([]);
  });

  it('never moves the marker again: a retry, a later read and a clock jump all return the same outcome', () => {
    w.clock.advance(60 * 60 * 1000);
    const at = w.clock.now();
    commitLoss(w.ctx, bottleId, 'sunk', at);
    const first = getSentBottle(w.ctx, ada(), bottleId);
    expect(commitLoss(w.ctx, bottleId, 'sunk', at + 1000)).toEqual({
      committed: false,
      reason: 'already_resolved',
    });
    expect(commitLoss(w.ctx, bottleId, 'adrift', at + 5000).committed).toBe(false);
    w.clock.advance(30 * 24 * 60 * 60 * 1000);
    expect(runJourneyTick(w.ctx).delivered).toBe(0);
    const later = getSentBottle(w.ctx, ada(), bottleId);
    expect(later.outcome).toEqual(first.outcome);
    // `asOf` is the read time; the point, geo and progress are the persisted outcome.
    expect({ ...later.position, asOf: '' }).toEqual({ ...first.position, asOf: '' });
    expect(later.state).toBe('lost');
    expect(later.outcome?.reason).toBe('sunk');
    expect(events(bottleId)).toEqual(['released', 'lost']);
    expect(listNotifications(w.ctx, ada().id)).toHaveLength(1);
    // The recipient still sees nothing, and no arrival notification ever appears.
    expect(getMyShore(w.ctx, bo()).bottles).toEqual([]);
    expect(listNotifications(w.ctx, bo().id)).toEqual([]);
  });

  it('refuses a loss once arrival is due, and arrival cannot commit after a loss', () => {
    const plan = w.db.select().from(t.routePlans).where(eq(t.routePlans.bottleId, bottleId)).get()!;
    // Loss after arrival is due: the shore wins.
    const due = plan.startsAt + plan.plannedDurationMs;
    expect(commitLoss(w.ctx, bottleId, 'adrift', due)).toEqual({
      committed: false,
      reason: 'arrival_due',
    });
    w.clock.set(due);
    expect(commitArrivalIfDue(w.ctx, bottleId, due)).toBe(true);
    expect(commitLoss(w.ctx, bottleId, 'adrift', due + 1)).toEqual({
      committed: false,
      reason: 'not_at_sea',
    });
    expect(getSentBottle(w.ctx, ada(), bottleId).state).toBe('delivered');

    // Loss first: a later arrival tick finds no at-sea bottle.
    const second = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000002')).bottleId;
    const plan2 = w.db.select().from(t.routePlans).where(eq(t.routePlans.bottleId, second)).get()!;
    expect(commitLoss(w.ctx, second, 'sunk', plan2.startsAt + 1000).committed).toBe(true);
    w.clock.set(plan2.startsAt + plan2.plannedDurationMs + 1);
    expect(commitArrivalIfDue(w.ctx, second, w.clock.now())).toBe(false);
    expect(runJourneyTick(w.ctx).delivered).toBe(0);
    expect(getSentBottle(w.ctx, ada(), second).state).toBe('lost');
    expect(events(second)).toEqual(['released', 'lost']);
  });

  it("the development control only works for the caller's own bottle", () => {
    expect(() => devLoseBottle(w.ctx, bo(), bottleId, 'sunk')).toThrowError(AppError);
    expect(() => devLoseBottle(w.ctx, cy(), bottleId, 'sunk')).toThrowError(AppError);
    expect(devLoseBottle(w.ctx, ada(), bottleId, 'sunk').committed).toBe(true);
  });

  describe('public ocean projection', () => {
    it('shows adrift bottles to any signed-in user with only the permitted fields', () => {
      w.clock.advance(1000);
      commitLoss(w.ctx, bottleId, 'adrift', w.clock.now());
      const sunk = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000003')).bottleId;
      commitLoss(w.ctx, sunk, 'sunk', w.clock.now());

      for (const viewer of [ada(), bo(), cy()]) {
        const list = listPublicOcean(w.ctx, viewer);
        expect(list.map((b) => b.id)).toEqual([bottleId]); // sunk bottles are never public
        const b = list[0]!;
        expect(PublicBottleSchema.parse(b)).toEqual(b);
        expect(Object.keys(b).sort()).toEqual(['id', 'lostAt', 'mine', 'position', 'reason']);
        expect(b.mine).toBe(viewer.id === ada().id);
        const json = JSON.stringify(b);
        for (const secret of ['Ada', 'Bo', 'driftmoor', 'lantern', 'nodeIds', 'tide was gentle']) {
          expect(json).not.toContain(secret);
        }
      }
    });

    it('hides a bottle between blocked accounts, in both directions', () => {
      commitLoss(w.ctx, bottleId, 'adrift', w.clock.now());
      blockUser(w.ctx, cy().id, 'ada');
      expect(listPublicOcean(w.ctx, cy())).toEqual([]);
      expect(listPublicOcean(w.ctx, ada())).toHaveLength(1);
      const other = releaseBottle(w.ctx, bo(), releaseInput(ada().id, 'key-0000000004')).bottleId;
      commitLoss(w.ctx, other, 'adrift', w.clock.now());
      blockUser(w.ctx, bo().id, 'cy');
      expect(listPublicOcean(w.ctx, cy())).toEqual([]);
      expect(listPublicOcean(w.ctx, bo()).map((b) => b.mine)).toEqual([false, true]);
    });
  });

  describe('opening a bottle found adrift', () => {
    beforeEach(() => {
      commitLoss(w.ctx, bottleId, 'adrift', w.clock.now());
    });

    it('is one atomic action: the finder gets the letter and it leaves the public map for everyone', () => {
      expect(listPublicOcean(w.ctx, cy()).map((b) => b.id)).toEqual([bottleId]);
      w.clock.advance(60_000);
      const at = w.clock.now();
      const opened = openPublicBottle(w.ctx, cy(), bottleId);
      expect(opened.letter.text).toContain('tide was gentle');
      expect(opened.bottle.source).toBe('public');
      expect(opened.bottle.openedAt).toBe(new Date(at).toISOString());
      // Gone from the map for every viewer, including its sender.
      for (const viewer of [ada(), bo(), cy()]) expect(listPublicOcean(w.ctx, viewer)).toEqual([]);
      // The finder keeps it in their own archive and can read it again.
      expect(listReceivedLetters(w.ctx, cy()).map((l) => l.id)).toEqual([bottleId]);
      expect(readOpenedLetter(w.ctx, cy(), bottleId).letter.text).toBe(opened.letter.text);
      // The journey outcome is untouched: the sender keeps letter, passport and Lost entry.
      const senders = getSentBottle(w.ctx, ada(), bottleId);
      expect(senders.state).toBe('lost');
      expect(senders.outcome?.reason).toBe('adrift');
      expect(senders.letter.text).toContain('tide was gentle');
      expect(events(bottleId)).toEqual(['released', 'lost', 'opened']);
      // The sender is told once, and never who read it.
      const notes = listNotifications(w.ctx, ada().id).filter((n) =>
        /found your drifting/.test(n.message),
      );
      expect(notes).toHaveLength(1);
      expect(notes[0]!.message).not.toContain('Cy');
    });

    it('reveals no sender, origin shore or destination to the finder', () => {
      const opened = openPublicBottle(w.ctx, cy(), bottleId);
      expect(opened.bottle.sender).toBeNull();
      expect(opened.bottle.originShore).toBeNull();
      expect(opened.bottle.deliveredAt).toBeNull();
      const json = JSON.stringify({ opened, archive: listReceivedLetters(w.ctx, cy()) });
      for (const secret of ['Ada', 'Bo', 'driftmoor', 'lantern', 'nodeIds']) {
        expect(json).not.toContain(secret);
      }
    });

    it('is idempotent for the finder and a plain 409 for everyone else', () => {
      const first = openPublicBottle(w.ctx, cy(), bottleId);
      w.clock.advance(5000);
      const again = openPublicBottle(w.ctx, cy(), bottleId);
      expect(again.bottle.openedAt).toBe(first.bottle.openedAt);
      expect(again.letter.text).toBe(first.letter.text);
      expect(again.aging).toEqual(first.aging);
      expect(events(bottleId)).toEqual(['released', 'lost', 'opened']);
      expect(
        listNotifications(w.ctx, ada().id).filter((n) => /found your drifting/.test(n.message)),
      ).toHaveLength(1);

      // A second person arrives: told it is gone, shown nothing, and given no archive entry.
      let err: unknown;
      try {
        openPublicBottle(w.ctx, bo(), bottleId);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(409);
      expect((err as AppError).code).toBe('already_opened');
      expect(JSON.stringify(err)).not.toContain('tide was gentle');
      expect(listReceivedLetters(w.ctx, bo())).toEqual([]);
      expect(() => readOpenedLetter(w.ctx, bo(), bottleId)).toThrowError(AppError);
    });

    it('refuses the sender, blocked accounts and anything that is not an open adrift bottle', () => {
      // The sender never claims their own bottle.
      expect(() => openPublicBottle(w.ctx, ada(), bottleId)).toThrowError(AppError);
      expect(listPublicOcean(w.ctx, cy()).map((b) => b.id)).toEqual([bottleId]);
      // A block in either direction hides it completely.
      blockUser(w.ctx, cy().id, 'ada');
      expect(() => openPublicBottle(w.ctx, cy(), bottleId)).toThrowError(AppError);
      // A sunk bottle is never public and can never be opened this way.
      const sunk = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000009')).bottleId;
      commitLoss(w.ctx, sunk, 'sunk', w.clock.now());
      expect(() => openPublicBottle(w.ctx, bo(), sunk)).toThrowError(AppError);
      // …nor is a bottle still at sea.
      const sailing = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000010')).bottleId;
      expect(() => openPublicBottle(w.ctx, bo(), sailing)).toThrowError(AppError);
    });

    it('never delivers the bottle to its intended recipient afterwards', () => {
      openPublicBottle(w.ctx, cy(), bottleId);
      w.clock.advance(60 * 24 * 60 * 60 * 1000);
      expect(runJourneyTick(w.ctx).delivered).toBe(0);
      expect(commitArrivalIfDue(w.ctx, bottleId, w.clock.now())).toBe(false);
      expect(getMyShore(w.ctx, bo()).bottles).toEqual([]);
      expect(listReceivedLetters(w.ctx, bo())).toEqual([]);
      expect(listNotifications(w.ctx, bo().id)).toEqual([]);
      expect(getSentBottle(w.ctx, ada(), bottleId).state).toBe('lost');
    });

    it('lets the sender read their own letter any number of times without claiming it', () => {
      for (let i = 0; i < 3; i++) {
        const own = readOwnLetter(w.ctx, ada(), bottleId);
        expect(own.letter.text).toContain('tide was gentle');
        // Still adrift, still public, still no opening, no extra history.
        expect(listPublicOcean(w.ctx, bo()).map((b) => b.id)).toEqual([bottleId]);
        expect(getSentBottle(w.ctx, ada(), bottleId).outcome?.reason).toBe('adrift');
        expect(events(bottleId)).toEqual(['released', 'lost']);
        w.clock.advance(1000);
      }
      // Nobody else can use that endpoint.
      expect(() => readOwnLetter(w.ctx, cy(), bottleId)).toThrowError(AppError);
      // And after a finder opens it, the sender still has letter and passport.
      openPublicBottle(w.ctx, cy(), bottleId);
      expect(readOwnLetter(w.ctx, ada(), bottleId).letter.text).toContain('tide was gentle');
      const passport = getSentBottle(w.ctx, ada(), bottleId);
      expect(passport.outcome?.reason).toBe('adrift');
      expect(passport.route.nodeIds.length).toBeGreaterThan(2);
    });
  });

  describe('private marker visibility lifecycle', () => {
    it('is unseen until the marker is reported inside the viewport, and only a seen marker can be acknowledged', () => {
      commitLoss(w.ctx, bottleId, 'sunk', w.clock.now());
      const fresh = getSentBottle(w.ctx, ada(), bottleId);
      expect(fresh.visibility).toEqual({ seenAt: null, acknowledgedAt: null });
      // Fetching, and even leaving the map, does not count: nothing was seen.
      expect(acknowledgeOutcome(w.ctx, ada(), bottleId)).toEqual({
        seenAt: null,
        acknowledgedAt: null,
      });
      w.clock.advance(5000);
      const seen = markOutcomeSeen(w.ctx, ada(), bottleId);
      expect(seen.seenAt).toBe(new Date(w.clock.now()).toISOString());
      expect(seen.acknowledgedAt).toBeNull();
      // The first sighting is the one that counts.
      w.clock.advance(5000);
      expect(markOutcomeSeen(w.ctx, ada(), bottleId).seenAt).toBe(seen.seenAt);
      const ack = acknowledgeOutcome(w.ctx, ada(), bottleId);
      expect(ack.acknowledgedAt).toBe(new Date(w.clock.now()).toISOString());
      w.clock.advance(5000);
      expect(acknowledgeOutcome(w.ctx, ada(), bottleId)).toEqual(ack);
      // Persisted per account: the list carries it after any number of reloads, and the letter
      // and history are untouched.
      const listed = listSentBottles(w.ctx, ada()).find((b) => b.id === bottleId)!;
      expect(listed.visibility).toEqual(ack);
      expect(getSentBottle(w.ctx, ada(), bottleId).letter.text.length).toBeGreaterThan(0);
      expect(events(bottleId)).toEqual(['released', 'lost']);
    });

    it('rejects visibility writes from anyone but the sender, and for bottles without an outcome', () => {
      expect(() => markOutcomeSeen(w.ctx, ada(), bottleId)).toThrowError(AppError); // still at sea
      commitLoss(w.ctx, bottleId, 'sunk', w.clock.now());
      expect(() => markOutcomeSeen(w.ctx, bo(), bottleId)).toThrowError(AppError);
      expect(() => acknowledgeOutcome(w.ctx, cy(), bottleId)).toThrowError(AppError);
    });
  });
});
