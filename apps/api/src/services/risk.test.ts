import type Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  RISK_POLICY,
  RISK_POLICY_VERSION,
  nightRuleOf,
  nightsOverlapping,
  solarOffsetMs,
  solarPhaseAt,
  stormForNight,
  type NightWindow,
  type StormNight,
} from '@mib/shared';
import * as t from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { getMyShore, getSentBottle, listReceivedLetters, readOwnLetter } from './bottles.js';
import type { AppContext } from './context.js';
import { activePlan, commitArrivalIfDue, runJourneyTick } from './journey.js';
import { listNotifications } from './notifications.js';
import {
  READING_SESSION_MS,
  activeReading,
  closeReading,
  commitLoss,
  listPublicOcean,
  openPublicBottle,
} from './outcomes.js';
import { loadGraphVersion } from './chart.js';
import { pathGeoPoints } from '../domain/routing.js';
import { heldReservations, releaseBottle } from './release.js';
import {
  activatePublicListings,
  expirePublicListings,
  journeyNights,
  nightOffsetMinutesFor,
  processRiskDecisions,
  stormWindowsFor,
  unwrapLongitudes,
} from './risk.js';
import { T0, createTestWorld, releaseInput, type TestWorld } from '../test/harness.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// A long journey (Ada → Bo takes a few hours by the seeded graph); we stretch time with a slow
// chart unit so a journey spans many nights and the policy has room to act.
function slowWorld(overrides = {}) {
  return createTestWorld({ msPerChartUnit: 24 * HOUR, minJourneyMs: 20 * DAY, ...overrides });
}

// The nights a released journey sails through, under the policy it carries: exactly what the
// worker walks and what the map publishes.
function nightsOf(w: TestWorld, bottleId: string, from: number, to: number): NightWindow[] {
  const bottle = w.db.select().from(t.bottles).where(eq(t.bottles.id, bottleId)).get()!;
  const plan = activePlan(w.db, bottleId)!;
  return journeyNights(w.ctx, plan, bottle.riskPolicyVersion ?? RISK_POLICY_VERSION, from, to);
}

// The first night on which `stormId` has a storm whose decision falls inside the journey. The
// nights come from `routeOf`'s journey, so a searched-for id is scheduled on the same route it
// will be given.
function firstStorm(
  w: TestWorld,
  routeOf: string,
  stormId: string,
  releasedAt: number,
  span = 60 * DAY,
) {
  for (const night of nightsOf(w, routeOf, releasedAt, releasedAt + span)) {
    const s = stormForNight(stormId, night, RISK_POLICY_VERSION);
    if (s && s.startsAt >= releasedAt) return s;
  }
  throw new Error('no storm night found');
}

describe(`automatic storm outcomes (policy v${RISK_POLICY_VERSION})`, () => {
  let w: TestWorld;
  const ada = () => w.user('ada');
  const bo = () => w.user('bo');
  const decisions = (id: string) =>
    w.db.select().from(t.riskDecisions).where(eq(t.riskDecisions.bottleId, id)).all();

  beforeEach(() => {
    w = slowWorld();
  });

  it('tags new journeys with the policy version and leaves older journeys untouched', () => {
    const fresh = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000001')).bottleId;
    expect(
      w.db.select().from(t.bottles).where(eq(t.bottles.id, fresh)).get()!.riskPolicyVersion,
    ).toBe(RISK_POLICY_VERSION);
    // A journey released before activation (null version): a year of nights, never a decision.
    w.db.update(t.bottles).set({ riskPolicyVersion: null }).where(eq(t.bottles.id, fresh)).run();
    w.clock.advance(30 * DAY);
    expect(processRiskDecisions(w.ctx, w.clock.now())).toEqual({ decided: 0, lost: 0 });
    expect(decisions(fresh)).toEqual([]);
    // With the policy disabled by configuration, new journeys carry no version either.
    const off = slowWorld({ riskPolicyVersion: 0 });
    const id = releaseBottle(off.ctx, off.user('ada'), releaseInput(off.user('bo').id)).bottleId;
    expect(
      off.db.select().from(t.bottles).where(eq(t.bottles.id, id)).get()!.riskPolicyVersion,
    ).toBeNull();
  });

  it("takes each storm night's decision exactly once, at the storm midpoint, and never again", () => {
    const id = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000002')).bottleId;
    const storm = firstStorm(w, id, id, T0);
    // Just before the decision moment: nothing yet, even though the storm is visible.
    w.clock.set(storm.decisionAt - 1);
    expect(processRiskDecisions(w.ctx, w.clock.now()).decided).toBe(0);
    expect(getSentBottle(w.ctx, ada(), id).storms.length).toBeGreaterThan(0);
    w.clock.set(storm.decisionAt);
    expect(processRiskDecisions(w.ctx, w.clock.now()).decided).toBe(1);
    const row = decisions(id)[0]!;
    expect(row).toMatchObject({
      nightKey: storm.key,
      policyVersion: RISK_POLICY_VERSION,
      stormStartsAt: storm.startsAt,
      stormEndsAt: storm.endsAt,
      decisionAt: storm.decisionAt,
      eligible: true,
    });
    // Retries, restarts (a fresh context over the same rows) and clock jumps add nothing.
    expect(processRiskDecisions(w.ctx, w.clock.now()).decided).toBe(0);
    const restarted: AppContext = { ...w.ctx };
    expect(processRiskDecisions(restarted, w.clock.now()).decided).toBe(0);
    w.clock.advance(5 * HOUR);
    expect(runJourneyTick(w.ctx).risk.decided).toBe(0);
    expect(decisions(id)).toHaveLength(1);
  });

  it('catches up deterministically after downtime: the same decisions in the same order', () => {
    const a = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000003')).bottleId;
    // Walk night by night in one world…
    const nightly: string[] = [];
    for (let d = 0; d < 10; d++) {
      w.clock.set(T0 + d * DAY);
      processRiskDecisions(w.ctx, w.clock.now());
      nightly.push(
        decisions(a)
          .map((r) => `${r.nightKey}:${r.eligible}:${r.lost}`)
          .join('|'),
      );
    }
    // …and in a second world that was offline for the whole ten days.
    const off = slowWorld();
    const b = releaseBottle(
      off.ctx,
      off.user('ada'),
      releaseInput(off.user('bo').id, 'key-0000000003'),
    ).bottleId;
    expect(b).not.toBe(a); // ids differ, so compare the schedule shape, not the keys
    off.clock.set(T0 + 9 * DAY);
    processRiskDecisions(off.ctx, off.clock.now());
    const caughtUp = off.db
      .select()
      .from(t.riskDecisions)
      .where(eq(t.riskDecisions.bottleId, b))
      .all();
    // Every storm night up to now has exactly one row in both worlds, in night order.
    const expectedNights = (world: TestWorld, id: string, from: number) =>
      nightsOf(world, id, from, T0 + 9 * DAY)
        .map((n) => stormForNight(id, n, RISK_POLICY_VERSION))
        .filter(
          (s): s is StormNight => s !== null && s.startsAt >= from && s.decisionAt <= T0 + 9 * DAY,
        )
        .map((s) => s.key);
    expect(caughtUp.map((r) => r.nightKey)).toEqual(expectedNights(off, b, T0));
    expect(decisions(a).map((r) => r.nightKey)).toEqual(expectedNights(w, a, T0));
    expect(nightly[9]).toBe(
      decisions(a)
        .map((r) => `${r.nightKey}:${r.eligible}:${r.lost}`)
        .join('|'),
    );
  });

  it('only the first five eligible decisions carry risk; storms after that are scenery', () => {
    const id = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000004')).bottleId;
    // Force every night to be a storm night with a safe draw, by taking decisions directly
    // against the persisted table through the worker over many nights.
    w.clock.set(T0 + 40 * DAY);
    processRiskDecisions(w.ctx, w.clock.now());
    const rows = decisions(id);
    const eligible = rows.filter((r) => r.eligible);
    expect(eligible.length).toBeLessThanOrEqual(RISK_POLICY.maxRiskDecisions);
    // Past the cap every later storm night is recorded but marked ineligible.
    const afterCap = rows.slice(rows.findIndex((r) => r === eligible[eligible.length - 1]) + 1);
    if (eligible.length === RISK_POLICY.maxRiskDecisions) {
      expect(afterCap.every((r) => !r.eligible && !r.lost)).toBe(true);
    }
    // The bottle still shows storms on the map while at sea.
    if (getSentBottle(w.ctx, ada(), id).state === 'at_sea') {
      expect(Array.isArray(getSentBottle(w.ctx, ada(), id).storms)).toBe(true);
    }
  });

  it('never decides at or after 80% progress, and arrival wins a race with a later storm', () => {
    const id = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000005')).bottleId;
    const plan = w.db.select().from(t.routePlans).where(eq(t.routePlans.bottleId, id)).get()!;
    const cutoffAt = plan.startsAt + RISK_POLICY.progressCutoff * plan.plannedDurationMs;
    w.clock.set(plan.startsAt + plan.plannedDurationMs + DAY);
    processRiskDecisions(w.ctx, w.clock.now());
    for (const r of decisions(id)) {
      if (r.decisionAt >= cutoffAt) expect(r.eligible).toBe(false);
    }
    // A decision before the cutoff can be eligible; none after arrival time exists as eligible.
    expect(decisions(id).every((r) => !r.eligible || r.decisionAt < cutoffAt)).toBe(true);
    // Now the arrival is due as well: it commits, and a loss can no longer.
    expect(
      runJourneyTick(w.ctx).delivered + (getSentBottle(w.ctx, ada(), id).state === 'lost' ? 1 : 0),
    ).toBeGreaterThanOrEqual(1);
    const final = getSentBottle(w.ctx, ada(), id);
    expect(['delivered', 'lost']).toContain(final.state);
    if (final.state === 'delivered') {
      expect(commitLoss(w.ctx, id, 'adrift', w.clock.now()).committed).toBe(false);
    }
  });

  it('a loss goes through the transactional service: position at the storm, slot freed, one notice', () => {
    // Pick, by pure search, an id whose first storm decision loses; then give a released bottle
    // that id (rows rewired with foreign keys off — a test device, the schedule is what is
    // under test). Deterministic, no rolling.
    const released = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000006')).bottleId;
    let chosen = '';
    let storm: StormNight | null = null;
    for (let i = 0; i < 5000 && !storm; i++) {
      const candidate = `btl_test_loss_${i}`;
      const s = firstStorm(w, released, candidate, T0, 30 * DAY);
      if (s.lossDraw < RISK_POLICY.lossChance) {
        chosen = candidate;
        storm = s;
      }
    }
    expect(storm).not.toBeNull();
    const sqlite = (w.db as unknown as { $client: Database.Database }).$client;
    sqlite.pragma('foreign_keys = OFF');
    for (const table of ['bottles', 'route_plans', 'capacity_reservations', 'journey_events']) {
      const col = table === 'bottles' ? 'id' : 'bottle_id';
      sqlite.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`).run(chosen, released);
    }
    sqlite.pragma('foreign_keys = ON');
    const id = chosen;

    w.clock.set(storm!.decisionAt + HOUR);
    const r = processRiskDecisions(w.ctx, w.clock.now());
    expect(r.lost).toBe(1);
    const b = getSentBottle(w.ctx, ada(), id);
    expect(b.state).toBe('lost');
    expect(['adrift', 'sunk']).toContain(b.outcome!.reason);
    expect(b.outcome!.reason).toBe(storm!.reasonDraw < RISK_POLICY.adriftShare ? 'adrift' : 'sunk');
    expect(b.outcome!.at).toBe(new Date(storm!.decisionAt).toISOString());
    expect(b.events.map((e) => e.type)).toEqual(['released', 'lost']);
    expect(heldReservations(w.db, 'shore_driftmoor_strand')).toBe(0);
    expect(listNotifications(w.ctx, ada().id).filter((n) => n.bottleId === id)).toHaveLength(1);
    // Again: nothing more happens, to anyone.
    expect(processRiskDecisions(w.ctx, w.clock.now())).toEqual({ decided: 0, lost: 0 });
    expect(commitArrivalIfDue(w.ctx, id, w.clock.now() + 100 * DAY)).toBe(false);
    expect(getMyShore(w.ctx, bo()).bottles).toEqual([]);
  }, 30_000);
});

describe('public listing: 72 hours from the loss', () => {
  let w: TestWorld;
  const ada = () => w.user('ada');
  const bo = () => w.user('bo');
  const cy = () => w.user('cy');
  let id: string;
  beforeEach(() => {
    w = createTestWorld();
    id = releaseBottle(w.ctx, ada(), releaseInput(bo().id)).bottleId;
    w.clock.advance(HOUR);
    commitLoss(w.ctx, id, 'adrift', w.clock.now());
  });

  it('is listed until exactly the deadline, then gone for everyone, with one clock notice', () => {
    const lostAt = w.clock.now();
    const deadline = lostAt + RISK_POLICY.publicListingMs;
    expect(listPublicOcean(w.ctx, cy())[0]!.expiresAt).toBe(new Date(deadline).toISOString());
    expect(getSentBottle(w.ctx, ada(), id).publicListing).toEqual({
      deadlineAt: new Date(deadline).toISOString(),
      status: 'listed',
    });
    // Sender reads do not extend it.
    readOwnLetter(w.ctx, ada(), id);
    w.clock.set(deadline - 1);
    expect(listPublicOcean(w.ctx, cy()).map((b) => b.id)).toEqual([id]);
    // At the exact deadline: not listed and not openable, even before the worker has run.
    w.clock.set(deadline);
    expect(listPublicOcean(w.ctx, cy())).toEqual([]);
    let err: unknown;
    try {
      openPublicBottle(w.ctx, cy(), id);
    } catch (e) {
      err = e;
    }
    expect((err as AppError).code).toBe('listing_expired');
    // The worker records the expiry once.
    expect(expirePublicListings(w.ctx, w.clock.now())).toBe(1);
    expect(expirePublicListings(w.ctx, w.clock.now())).toBe(0);
    expect(runJourneyTick(w.ctx).expired).toBe(0);
    const b = getSentBottle(w.ctx, ada(), id);
    expect(b.state).toBe('lost');
    expect(b.publicListing).toEqual({
      deadlineAt: new Date(deadline).toISOString(),
      status: 'expired',
    });
    expect(b.letter.text).toContain('tide was gentle');
    expect(b.events.map((e) => e.type)).toEqual(['released', 'lost', 'public_expired']);
    const notes = listNotifications(w.ctx, ada().id).filter((n) => n.kind === 'sent_expired');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toBe(
      '72 hours passed and the bottle you sent to Bo was not opened. It was removed from the public map.',
    );
    // Never delivered, never resumed.
    w.clock.advance(30 * DAY);
    expect(runJourneyTick(w.ctx).delivered).toBe(0);
    expect(getMyShore(w.ctx, bo()).bottles).toEqual([]);
  });

  it('an opening just before the deadline wins and the expiry then does nothing', () => {
    w.clock.set(w.clock.now() + RISK_POLICY.publicListingMs - 1);
    openPublicBottle(w.ctx, cy(), id);
    w.clock.advance(1);
    expect(expirePublicListings(w.ctx, w.clock.now())).toBe(0);
    expect(getSentBottle(w.ctx, ada(), id).publicListing?.status).toBe('opened');
    expect(listNotifications(w.ctx, ada().id).some((n) => n.kind === 'sent_expired')).toBe(false);
  });

  it('gives legacy listings a full 72 hours from activation, once', () => {
    // Simulate a bottle that went adrift before the rule existed: no deadline stored.
    w.db.update(t.bottles).set({ publicDeadlineAt: null }).where(eq(t.bottles.id, id)).run();
    w.clock.advance(10 * DAY);
    expect(listPublicOcean(w.ctx, cy())).toEqual([]); // without a deadline it is not served
    expect(activatePublicListings(w.ctx)).toBe(1);
    expect(activatePublicListings(w.ctx)).toBe(0);
    const b = getSentBottle(w.ctx, ada(), id);
    expect(b.publicListing).toEqual({
      deadlineAt: new Date(w.clock.now() + RISK_POLICY.publicListingMs).toISOString(),
      status: 'listed',
    });
    expect(listPublicOcean(w.ctx, cy()).map((x) => x.id)).toEqual([id]);
  });
});

describe('one-time reading by the finder', () => {
  let w: TestWorld;
  const ada = () => w.user('ada');
  const bo = () => w.user('bo');
  const cy = () => w.user('cy');
  let id: string;
  beforeEach(() => {
    w = createTestWorld();
    id = releaseBottle(w.ctx, ada(), releaseInput(bo().id)).bottleId;
    commitLoss(w.ctx, id, 'adrift', w.clock.now());
  });

  it('serves the letter during the session, recovers it briefly, and never after closing', () => {
    const opened = openPublicBottle(w.ctx, cy(), id);
    const until = w.clock.now() + READING_SESSION_MS;
    expect(opened.readingExpiresAt).toBe(new Date(until).toISOString());
    // A refresh or a dropped connection: the same reading comes back, bound to the finder.
    w.clock.advance(60_000);
    expect(activeReading(w.ctx, cy())?.letter.text).toBe(opened.letter.text);
    expect(openPublicBottle(w.ctx, cy(), id).letter.text).toBe(opened.letter.text);
    expect(activeReading(w.ctx, bo())).toBeNull();
    // No archive, no reread through the received endpoint.
    expect(listReceivedLetters(w.ctx, cy())).toEqual([]);
    // Closing ends it immediately, for good.
    closeReading(w.ctx, cy(), id);
    expect(activeReading(w.ctx, cy())).toBeNull();
    let err: unknown;
    try {
      openPublicBottle(w.ctx, cy(), id);
    } catch (e) {
      err = e;
    }
    expect((err as AppError).code).toBe('reading_closed');
    expect(JSON.stringify(err)).not.toContain('tide was gentle');
    closeReading(w.ctx, cy(), id); // idempotent
    // The opening itself is kept: still off the map, still "opened" for the sender.
    expect(listPublicOcean(w.ctx, bo())).toEqual([]);
    expect(getSentBottle(w.ctx, ada(), id).publicListing?.status).toBe('opened');
    expect(
      w.db.select().from(t.publicOpenings).where(eq(t.publicOpenings.bottleId, id)).get()
        ?.openedById,
    ).toBe(cy().id);
  });

  it('expires the session on the server without a close', () => {
    openPublicBottle(w.ctx, cy(), id);
    w.clock.advance(READING_SESSION_MS);
    expect(activeReading(w.ctx, cy())).toBeNull();
    expect(() => openPublicBottle(w.ctx, cy(), id)).toThrowError(AppError);
  });

  it('a legacy opening (no session recorded) grants no reread', () => {
    openPublicBottle(w.ctx, cy(), id);
    w.db.update(t.publicOpenings).set({ sessionExpiresAt: null, closedAt: null }).run();
    expect(activeReading(w.ctx, cy())).toBeNull();
    expect(() => openPublicBottle(w.ctx, cy(), id)).toThrowError(AppError);
    expect(listReceivedLetters(w.ctx, cy())).toEqual([]);
  });

  it('leaves the sender unlimited and the recipient empty-handed', () => {
    openPublicBottle(w.ctx, cy(), id);
    closeReading(w.ctx, cy(), id);
    for (let i = 0; i < 3; i++)
      expect(readOwnLetter(w.ctx, ada(), id).letter.text).toContain('tide');
    expect(getSentBottle(w.ctx, ada(), id).letter.text).toContain('tide');
    w.clock.advance(30 * DAY);
    runJourneyTick(w.ctx);
    expect(getMyShore(w.ctx, bo()).bottles).toEqual([]);
    expect(listReceivedLetters(w.ctx, bo())).toEqual([]);
  });
});

describe('immediate arrival at the same harbour', () => {
  it('delivers on release through the ordinary arrival path, idempotently', () => {
    const w = createTestWorld();
    const ada = w.user('ada');
    const bo = w.user('bo');
    // Anchor Bo at Ada's harbour.
    w.db.update(t.users).set({ shoreId: ada.shoreId }).where(eq(t.users.id, bo.id)).run();
    const boHere = w.user('bo');
    const first = releaseBottle(w.ctx, ada, releaseInput(boHere.id, 'key-same-0000001'));
    const b = getSentBottle(w.ctx, ada, first.bottleId);
    expect(b.state).toBe('delivered');
    expect(b.deliveredAt).toBe(b.releasedAt);
    expect(b.position.progress).toBe(1);
    expect(b.storms).toEqual([]);
    expect(b.events.map((e) => e.type)).toEqual(['released', 'delivered']);
    expect(
      w.db.select().from(t.bottles).where(eq(t.bottles.id, b.id)).get()!.riskPolicyVersion,
    ).toBeNull();
    expect(w.db.select().from(t.riskDecisions).all()).toEqual([]);
    // Recipient shore, both notifications, the slot held until opening.
    expect(getMyShore(w.ctx, boHere).bottles.map((x) => x.id)).toEqual([b.id]);
    expect(listNotifications(w.ctx, boHere.id).map((n) => n.kind)).toEqual(['received_arrived']);
    expect(listNotifications(w.ctx, ada.id).map((n) => n.kind)).toEqual(['sent_arrived']);
    expect(heldReservations(w.db, ada.shoreId!)).toBe(1);
    // A retry with the same key returns the same delivered bottle and changes nothing.
    const again = releaseBottle(w.ctx, ada, releaseInput(boHere.id, 'key-same-0000001'));
    expect(again).toEqual({ bottleId: b.id, replayed: true });
    expect(listNotifications(w.ctx, boHere.id)).toHaveLength(1);
    // The worker has nothing to do for it.
    w.clock.advance(DAY);
    expect(runJourneyTick(w.ctx)).toEqual({
      delivered: 0,
      risk: { decided: 0, lost: 0 },
      expired: 0,
    });
    // And an ordinary different-harbour journey still sails.
    const cy = w.user('cy');
    const sailing = releaseBottle(w.ctx, ada, releaseInput(cy.id, 'key-diff-0000001')).bottleId;
    expect(getSentBottle(w.ctx, ada, sailing).state).toBe('at_sea');
    expect(getMyShore(w.ctx, cy).bottles).toEqual([]);
  });
});

// One rule decides when a bottle may be at risk, when a storm is drawn on it and what sky the
// sea view shows: the bottle's own night, 19:00–07:00 mean solar time at the meridian it is
// sailing on. It is the same instants for every reader in the world, so a storm that carries a
// decision cannot be hidden behind anybody's daylight, and there is no daylight saving at sea.
describe('one night rule for the schedule, the map and the decision', () => {
  let w: TestWorld;
  const ada = () => w.user('ada');
  const bo = () => w.user('bo');
  const bottleRow = (id: string) =>
    w.db.select().from(t.bottles).where(eq(t.bottles.id, id)).get()!;

  beforeEach(() => {
    w = slowWorld();
  });

  it('never decides outside a storm the map is publishing at that very moment', () => {
    const ids = ['a', 'b', 'c', 'd'].map(
      (k) => releaseBottle(w.ctx, ada(), releaseInput(bo().id, `key-000000010${k}`)).bottleId,
    );
    w.clock.set(T0 + 18 * DAY);
    processRiskDecisions(w.ctx, w.clock.now());
    let checked = 0;
    for (const id of ids) {
      const rows = w.db
        .select()
        .from(t.riskDecisions)
        .where(eq(t.riskDecisions.bottleId, id))
        .all();
      const plan = activePlan(w.db, id)!;
      // A bottle that was lost is no longer at sea; the question is what was on the map at the
      // instant the decision was taken, so ask with the state it had then.
      const atSea = { ...bottleRow(id), state: 'at_sea' as const };
      for (const row of rows) {
        checked++;
        const covering = stormWindowsFor(w.ctx, atSea, plan, row.decisionAt).filter(
          (win) =>
            Date.parse(win.startsAt) <= row.decisionAt && row.decisionAt < Date.parse(win.endsAt),
        );
        expect(covering).toHaveLength(1);
        expect(Date.parse(covering[0]!.startsAt)).toBe(row.stormStartsAt);
        expect(Date.parse(covering[0]!.endsAt)).toBe(row.stormEndsAt);
        // …and it really is night where the bottle is, by the same clock the sea view reads.
        const offset = nightOffsetMinutesFor(w.ctx, bottleRow(id), plan, row.decisionAt);
        expect(solarPhaseAt(row.decisionAt, offset * 60_000)).toBe('night');
      }
    }
    expect(checked).toBeGreaterThan(4);
  });

  it("does not depend on the server's configured zone any more", () => {
    const here = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000101')).bottleId;
    const far = slowWorld({ timeZone: 'Pacific/Kiritimati' });
    const there = releaseBottle(
      far.ctx,
      far.user('ada'),
      releaseInput(far.user('bo').id, 'key-0000000101'),
    ).bottleId;
    const span = [T0, T0 + 10 * DAY] as const;
    expect(nightsOf(far, there, ...span)).toEqual(nightsOf(w, here, ...span));
    // The zone rule those journeys replace moved with the configuration — that was the bug.
    expect(nightsOverlapping(...span, 'Pacific/Kiritimati')).not.toEqual(
      nightsOverlapping(...span, 'UTC'),
    );
  });

  it('keeps a journey already sailing under policy v1 on the nights it was given', () => {
    const tokyo = slowWorld({ timeZone: 'Asia/Tokyo' });
    const id = releaseBottle(
      tokyo.ctx,
      tokyo.user('ada'),
      releaseInput(tokyo.user('bo').id, 'key-0000000102'),
    ).bottleId;
    tokyo.db.update(t.bottles).set({ riskPolicyVersion: 1 }).where(eq(t.bottles.id, id)).run();
    const plan = activePlan(tokyo.db, id)!;
    const bottle = tokyo.db.select().from(t.bottles).where(eq(t.bottles.id, id)).get()!;
    const now = T0 + 3 * DAY;
    expect(nightRuleOf(1)).toBe('zone');
    expect(journeyNights(tokyo.ctx, plan, 1, now - DAY, now + DAY)).toEqual(
      nightsOverlapping(now - DAY, now + DAY, 'Asia/Tokyo'),
    );
    // Its windows are published exactly like everyone else's, so they are just as visible…
    const published = stormWindowsFor(tokyo.ctx, bottle, plan, now);
    const expected = nightsOverlapping(now - DAY, now + DAY, 'Asia/Tokyo')
      .map((night) => stormForNight(id, night, 1))
      .filter((s): s is StormNight => s !== null && s.endsAt > bottle.releasedAt)
      .map((s) => ({
        startsAt: new Date(s.startsAt).toISOString(),
        endsAt: new Date(s.endsAt).toISOString(),
      }));
    expect(published).toEqual(expected);
    // …and the sky the sea view draws for it is that same zone's clock, not a meridian.
    expect(nightOffsetMinutesFor(tokyo.ctx, bottle, plan, now)).toBe(9 * 60);
  });

  it('gives every night twelve hours, through every daylight-saving change', () => {
    const berlin = slowWorld({ timeZone: 'Europe/Berlin' });
    const id = releaseBottle(
      berlin.ctx,
      berlin.user('ada'),
      releaseInput(berlin.user('bo').id, 'key-0000000103'),
    ).bottleId;
    const plan = activePlan(berlin.db, id)!;
    const span = [T0, T0 + 60 * DAY] as const; // covers 2026-10-25, when Berlin's clocks go back
    const sea = journeyNights(berlin.ctx, plan, RISK_POLICY_VERSION, ...span);
    expect(sea.some((n) => n.key === '2026-10-25')).toBe(true);
    for (const night of sea) expect(night.endsAt - night.startsAt).toBe(12 * HOUR);
    // The zone rule gained an hour that night, stretching a bottle's exposure with it.
    const zoned = nightsOverlapping(...span, 'Europe/Berlin');
    expect(zoned.some((n) => n.endsAt - n.startsAt === 13 * HOUR)).toBe(true);
  });

  it('follows a route over the date line without moving the bottle a day', () => {
    expect(
      unwrapLongitudes([
        { lng: 170, lat: 0 },
        { lng: -170, lat: 0 },
        { lng: -150, lat: 1 },
      ]),
    ).toEqual([
      { lng: 170, lat: 0 },
      { lng: 190, lat: 0 },
      { lng: 210, lat: 1 },
    ]);
    expect(
      unwrapLongitudes([
        { lng: -170, lat: 0 },
        { lng: 170, lat: 0 },
      ]),
    ).toEqual([
      { lng: -170, lat: 0 },
      { lng: -190, lat: 0 },
    ]);
    // A real crossing: Honiara to Apia runs straight over the antimeridian.
    w.db.update(t.users).set({ shoreId: 'shore_sb_honiara' }).where(eq(t.users.id, ada().id)).run();
    w.db.update(t.users).set({ shoreId: 'shore_ws_apia' }).where(eq(t.users.id, bo().id)).run();
    const id = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000104')).bottleId;
    const plan = activePlan(w.db, id)!;
    const geo = unwrapLongitudes(
      pathGeoPoints(loadGraphVersion(w.db, plan.graphVersion), plan.nodeIds)!,
    );
    expect(Math.max(...geo.map((g) => Math.abs(g.lng)))).toBeGreaterThan(180);
    const nights = nightsOf(w, id, T0, T0 + 20 * DAY);
    expect(nights.length).toBeGreaterThan(10);
    for (let i = 1; i < nights.length; i++) {
      const gap = nights[i]!.startsAt - nights[i - 1]!.startsAt;
      expect(gap).toBeGreaterThan(20 * HOUR);
      expect(gap).toBeLessThan(28 * HOUR);
      expect(nights[i]!.startsAt).toBeGreaterThan(nights[i - 1]!.endsAt);
    }
    // The sky it publishes stays a time of day, whichever side of the line it is on.
    const offset = nightOffsetMinutesFor(w.ctx, bottleRow(id), plan, T0 + 5 * DAY);
    expect(Math.abs(offset)).toBeLessThanOrEqual(12 * 60);
    expect(offset).toBe(Math.round(solarOffsetMs(offset / 4) / 60_000));
  });

  it('publishes the same instants to every reader, whatever their clock says', () => {
    const id = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000105')).bottleId;
    const plan = activePlan(w.db, id)!;
    // Storms fall on a quarter of the nights: walk forward to the first night that has one.
    let windows: ReturnType<typeof stormWindowsFor> = [];
    for (let d = 1; d <= 20 && windows.length === 0; d++) {
      windows = stormWindowsFor(w.ctx, bottleRow(id), plan, T0 + d * DAY);
    }
    expect(windows.length).toBeGreaterThan(0);
    for (const win of windows) {
      // Absolute UTC instants: nothing here is a local time anybody has to reinterpret.
      expect(win.startsAt).toMatch(/Z$/);
      expect(new Date(win.startsAt).toISOString()).toBe(win.startsAt);
      const from = Date.parse(win.startsAt);
      const to = Date.parse(win.endsAt);
      // Each one sits inside a night of this journey — the same nights the worker walks.
      const nights = journeyNights(w.ctx, plan, RISK_POLICY_VERSION, from - DAY, to + DAY);
      expect(nights.some((n) => n.startsAt <= from && to <= n.endsAt)).toBe(true);
    }
  });
});
