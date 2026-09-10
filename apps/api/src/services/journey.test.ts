import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import * as t from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import {
  getMyShore,
  getSentBottle,
  listSentBottles,
  openBottle,
  readOpenedLetter,
} from './bottles.js';
import { blockUser } from './friends.js';
import { runJourneyTick } from './journey.js';
import { listNotifications } from './notifications.js';
import { heldReservations, releaseBottle } from './release.js';
import { SAMPLE_TEXT, createTestWorld, releaseInput, type TestWorld } from '../test/harness.js';

describe('journey: visibility, deterministic arrival, opening', () => {
  let w: TestWorld;
  let bottleId: string;
  const ada = () => w.user('ada');
  const bo = () => w.user('bo');

  beforeEach(() => {
    w = createTestWorld();
    bottleId = releaseBottle(w.ctx, ada(), releaseInput(bo().id)).bottleId;
  });

  it('sender sees route, simulated position and live elapsed time', () => {
    const b = getSentBottle(w.ctx, ada(), bottleId);
    expect(b.route.points.length).toBeGreaterThan(2);
    expect(b.position.progress).toBe(0);
    expect(b.position.point).toEqual(b.route.points[0]);
    w.clock.advance(b.route.plannedDurationMs / 2);
    const mid = getSentBottle(w.ctx, ada(), bottleId);
    expect(mid.position.progress).toBeCloseTo(0.5, 5);
    expect(mid.elapsedMs).toBe(b.route.plannedDurationMs / 2);
    expect(mid.elapsedIsLive).toBe(true);
    expect(listSentBottles(w.ctx, ada()).map((x) => x.id)).toEqual([bottleId]);
  });

  it('recipient cannot see the bottle before arrival through any endpoint (spec §18 #7)', () => {
    expect(getMyShore(w.ctx, bo()).bottles).toEqual([]);
    expect(() => getSentBottle(w.ctx, bo(), bottleId)).toThrowError(AppError);
    expect(() => openBottle(w.ctx, bo(), bottleId)).toThrowError(AppError);
    expect(() => readOpenedLetter(w.ctx, bo(), bottleId)).toThrowError(AppError);
    expect(listNotifications(w.ctx, bo().id)).toEqual([]);
    expect(listSentBottles(w.ctx, bo())).toEqual([]);
  });

  it('a third party cannot read the passport even with the id', () => {
    expect(() => getSentBottle(w.ctx, w.user('cy'), bottleId)).toThrowError(AppError);
  });

  it('does not deliver before the planned arrival, delivers exactly once when due', () => {
    const plan = w.db.select().from(t.routePlans).where(eq(t.routePlans.bottleId, bottleId)).get()!;
    w.clock.advance(plan.plannedDurationMs - 1);
    expect(runJourneyTick(w.ctx).delivered).toBe(0);
    expect(getMyShore(w.ctx, bo()).bottles).toEqual([]);

    w.clock.advance(1);
    expect(runJourneyTick(w.ctx).delivered).toBe(1);
    expect(runJourneyTick(w.ctx).delivered).toBe(0); // idempotent replay of the worker

    const shore = getMyShore(w.ctx, bo());
    expect(shore.bottles).toHaveLength(1);
    expect(shore.bottles[0]!.state).toBe('delivered');
    expect(shore.bottles[0]!.journeyDurationMs).toBe(plan.plannedDurationMs);
    const events = w.db
      .select()
      .from(t.journeyEvents)
      .where(eq(t.journeyEvents.bottleId, bottleId))
      .all();
    expect(events.map((e) => e.type)).toEqual(['released', 'delivered']);
    const notes = listNotifications(w.ctx, bo().id);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.type).toBe('bottle_arrived');
    // The slot stays held while delivered-but-unopened (spec §8.3).
    expect(heldReservations(w.db, 'shore_driftmoor_strand')).toBe(1);
  });

  it('arrival is a function of server time, not of how often the worker runs', () => {
    const plan = w.db.select().from(t.routePlans).where(eq(t.routePlans.bottleId, bottleId)).get()!;
    for (let i = 0; i < 50; i++) runJourneyTick(w.ctx);
    expect(getMyShore(w.ctx, bo()).bottles).toEqual([]);
    w.clock.advance(plan.plannedDurationMs * 3); // long downtime, single catch-up tick
    runJourneyTick(w.ctx);
    const b = getSentBottle(w.ctx, ada(), bottleId);
    expect(b.state).toBe('delivered');
    expect(b.deliveredAt).toBe(b.plannedArrivalAt);
  });

  it('opening completes the journey, releases capacity exactly once and keeps the text immutable', () => {
    const plan = w.db.select().from(t.routePlans).where(eq(t.routePlans.bottleId, bottleId)).get()!;
    w.clock.advance(plan.plannedDurationMs);
    runJourneyTick(w.ctx);
    w.clock.advance(60_000);

    const opened = openBottle(w.ctx, bo(), bottleId);
    expect(opened.bottle.state).toBe('opened');
    expect(opened.letter.text).toBe(SAMPLE_TEXT);
    expect(opened.letter.font).toBe('handwriting');
    expect(opened.aging.yellowing).toBeGreaterThan(0);
    expect(heldReservations(w.db, 'shore_driftmoor_strand')).toBe(0);

    // Second open is a plain read: same aging profile, no new events, no double slot release.
    const again = openBottle(w.ctx, bo(), bottleId);
    expect(again.aging).toEqual(opened.aging);
    expect(readOpenedLetter(w.ctx, bo(), bottleId).letter.text).toBe(SAMPLE_TEXT);
    const events = w.db
      .select()
      .from(t.journeyEvents)
      .where(eq(t.journeyEvents.bottleId, bottleId))
      .all();
    expect(events.map((e) => e.type)).toEqual(['released', 'delivered', 'opened']);
    const reservation = w.db
      .select()
      .from(t.capacityReservations)
      .where(eq(t.capacityReservations.bottleId, bottleId))
      .get()!;
    expect(reservation.status).toBe('released');
    expect(reservation.releasedAt).toBe(w.clock.now());

    // Sender's elapsed time is frozen at completion; state is terminal.
    w.clock.advance(24 * 60 * 60 * 1000);
    const passport = getSentBottle(w.ctx, ada(), bottleId);
    expect(passport.state).toBe('opened');
    expect(passport.elapsedIsLive).toBe(false);
    expect(passport.elapsedMs).toBe(plan.plannedDurationMs + 60_000);
    expect(runJourneyTick(w.ctx).delivered).toBe(0);
  });

  it('a freed slot lets a new release through', () => {
    w.db
      .update(t.shores)
      .set({ capacity: 1 })
      .where(eq(t.shores.id, 'shore_driftmoor_strand'))
      .run();
    expect(() => releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'blocked-key-0001'))).toThrow();
    const plan = w.db.select().from(t.routePlans).where(eq(t.routePlans.bottleId, bottleId)).get()!;
    w.clock.advance(plan.plannedDurationMs);
    runJourneyTick(w.ctx);
    openBottle(w.ctx, bo(), bottleId);
    expect(releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'after-open-key01')).replayed).toBe(
      false,
    );
  });

  it('a block during transit cancels delivery generically and frees the slot once (spec §18 #21)', () => {
    blockUser(w.ctx, bo().id, 'ada');
    const plan = w.db.select().from(t.routePlans).where(eq(t.routePlans.bottleId, bottleId)).get()!;
    w.clock.advance(plan.plannedDurationMs);
    runJourneyTick(w.ctx);
    runJourneyTick(w.ctx);
    const passport = getSentBottle(w.ctx, ada(), bottleId);
    expect(passport.state).toBe('cancelled');
    expect(getMyShore(w.ctx, bo()).bottles).toEqual([]);
    expect(listNotifications(w.ctx, bo().id)).toEqual([]);
    const senderNotes = listNotifications(w.ctx, ada().id);
    expect(senderNotes).toHaveLength(1);
    expect(senderNotes[0]!.message).not.toMatch(/block/i);
    expect(heldReservations(w.db, 'shore_driftmoor_strand')).toBe(0);
  });
});
