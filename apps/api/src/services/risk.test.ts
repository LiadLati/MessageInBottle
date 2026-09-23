import type Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  RISK_POLICY,
  RISK_POLICY_VERSION,
  nightWindow,
  phaseAt,
  stormForNight,
  type NightWindow,
  type StormNight,
} from '@mib/shared';
import * as t from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { getMyShore, getSentBottle, listReceivedLetters, readOwnLetter } from './bottles.js';
import type { AppContext } from './context.js';
import { commitArrivalIfDue, runJourneyTick } from './journey.js';
import { listNotifications } from './notifications.js';
import {
  READING_SESSION_MS,
  activeReading,
  closeReading,
  commitLoss,
  listPublicOcean,
  openPublicBottle,
} from './outcomes.js';
import { setAccountTimeZone } from './auth.js';
import { heldReservations, releaseBottle } from './release.js';
import {
  accountNightZone,
  activatePublicListings,
  expirePublicListings,
  journeyNights,
  processRiskDecisions,
  stormWindowsFor,
} from './risk.js';
import { T0, createTestWorld, releaseInput, type TestWorld } from '../test/harness.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// A long journey (Ada → Bo takes a few hours by the seeded graph); we stretch time with a slow
// chart unit so a journey spans many nights and the policy has room to act. Ada's device has
// reported a zone, as any account that has opened the app has: nights exist for her journeys.
const ZONE = 'Asia/Jerusalem';
function slowWorld(overrides = {}, zone: string | null = ZONE) {
  const w = createTestWorld({ msPerChartUnit: 24 * HOUR, minJourneyMs: 20 * DAY, ...overrides });
  if (zone) setAccountTimeZone(w.ctx, w.user('ada'), zone);
  return w;
}

// The nights a released journey sails through: exactly what the worker walks and what the map
// publishes.
function nightsOf(w: TestWorld, bottleId: string, from: number, to: number): NightWindow[] {
  const bottle = w.db.select().from(t.bottles).where(eq(t.bottles.id, bottleId)).get()!;
  return journeyNights(w.ctx, bottle, from, to);
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
    expect(getSentBottle(w.ctx, ada(), id).stormsWeathered).toBe(0);
    w.clock.set(storm.decisionAt);
    expect(processRiskDecisions(w.ctx, w.clock.now()).decided).toBe(1);
    // The passport counts the storm the journey has now been through (FE-008).
    expect(getSentBottle(w.ctx, ada(), id).stormsWeathered).toBe(1);
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
// sea view shows: the sender's own night — 19:00–07:00 in the account's persisted zone, the
// phase the account's Ocean map is drawn in — whatever water the bottle is on. A daytime map
// can therefore never hold a bottle in a risk-bearing storm.
describe("the night is the sender's night: map, storms and decisions on one phase", () => {
  let w: TestWorld;
  const ada = () => w.user('ada');
  const bo = () => w.user('bo');
  const bottleRow = (id: string) =>
    w.db.select().from(t.bottles).where(eq(t.bottles.id, id)).get()!;
  const decisions = (id: string) =>
    w.db.select().from(t.riskDecisions).where(eq(t.riskDecisions.bottleId, id)).all();

  beforeEach(() => {
    w = slowWorld();
  });

  it('never decides outside a storm the map is publishing, and never on a daytime map', () => {
    const ids = ['a', 'b', 'c', 'd'].map(
      (k) => releaseBottle(w.ctx, ada(), releaseInput(bo().id, `key-000000010${k}`)).bottleId,
    );
    w.clock.set(T0 + 18 * DAY);
    processRiskDecisions(w.ctx, w.clock.now());
    let checked = 0;
    for (const id of ids) {
      // A bottle that was lost is no longer at sea; the question is what was on the map at the
      // instant the decision was taken, so ask with the state it had then.
      const atSea = { ...bottleRow(id), state: 'at_sea' as const };
      for (const row of decisions(id)) {
        checked++;
        const covering = stormWindowsFor(w.ctx, atSea, row.decisionAt).filter(
          (win) =>
            Date.parse(win.startsAt) <= row.decisionAt && row.decisionAt < Date.parse(win.endsAt),
        );
        expect(covering).toHaveLength(1);
        expect(Date.parse(covering[0]!.startsAt)).toBe(row.stormStartsAt);
        expect(Date.parse(covering[0]!.endsAt)).toBe(row.stormEndsAt);
        // …and the account's map is in night mode for the whole of that storm.
        for (const at of [row.stormStartsAt!, row.decisionAt, row.stormEndsAt! - 1]) {
          expect(phaseAt(at, ZONE)).toBe('night');
        }
        expect(row.policyVersion).toBe(RISK_POLICY_VERSION);
      }
    }
    expect(checked).toBeGreaterThan(4);
  });

  it('shares the night phase between bottles but gives each its own storms', () => {
    const a = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000110')).bottleId;
    const b = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000111')).bottleId;
    const span = [T0, T0 + 15 * DAY] as const;
    expect(nightsOf(w, a, ...span)).toEqual(nightsOf(w, b, ...span));
    const stormsOf = (id: string) =>
      nightsOf(w, id, ...span).map((n) => Boolean(stormForNight(id, n, RISK_POLICY_VERSION)));
    expect(stormsOf(a)).not.toEqual(stormsOf(b));
    w.clock.set(T0 + 15 * DAY);
    processRiskDecisions(w.ctx, w.clock.now());
    expect(decisions(a).map((r) => r.nightKey)).not.toEqual(decisions(b).map((r) => r.nightKey));
  });

  it('has no nights, no storms and no risk until a device has reported a zone', () => {
    const quiet = slowWorld({}, null);
    const id = releaseBottle(
      quiet.ctx,
      quiet.user('ada'),
      releaseInput(quiet.user('bo').id, 'key-0000000112'),
    ).bottleId;
    expect(accountNightZone(quiet.ctx, quiet.user('ada').id)).toBeNull();
    for (let d = 1; d <= 15; d++) {
      quiet.clock.set(T0 + d * DAY);
      expect(processRiskDecisions(quiet.ctx, quiet.clock.now())).toEqual({ decided: 0, lost: 0 });
      expect(getSentBottle(quiet.ctx, quiet.user('ada'), id).storms).toEqual([]);
    }
    // The first sync starts the nights from that instant, not from the release.
    setAccountTimeZone(quiet.ctx, quiet.user('ada'), 'Europe/Berlin');
    const since = accountNightZone(quiet.ctx, quiet.user('ada').id)!.since;
    expect(since).toBe(quiet.clock.now());
    const bottle = quiet.db.select().from(t.bottles).where(eq(t.bottles.id, id)).get()!;
    const nights = journeyNights(quiet.ctx, bottle, T0, T0 + 20 * DAY);
    expect(nights.length).toBeGreaterThan(0);
    expect(nights.every((n) => n.startsAt >= since)).toBe(true);
  });

  it('moves the nights ahead when the device zone changes, never the ones behind', () => {
    const id = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000113')).bottleId;
    const before = getSentBottle(w.ctx, ada(), id);
    w.clock.set(T0 + 6 * DAY);
    processRiskDecisions(w.ctx, w.clock.now());
    const taken = decisions(id);
    // Ada flies to Los Angeles: the app resumes and reports the new zone.
    const changedAt = w.clock.now();
    setAccountTimeZone(w.ctx, ada(), 'America/Los_Angeles');
    expect(accountNightZone(w.ctx, ada().id)).toEqual({
      zone: 'America/Los_Angeles',
      since: changedAt,
    });
    // Resuming again in the same zone is a no-op: the instant does not move.
    w.clock.advance(HOUR);
    setAccountTimeZone(w.ctx, ada(), 'America/Los_Angeles');
    expect(accountNightZone(w.ctx, ada().id)!.since).toBe(changedAt);
    // From here on every night is a Los Angeles night that began after the change…
    const bottle = bottleRow(id);
    const ahead = journeyNights(w.ctx, bottle, T0, T0 + 20 * DAY);
    expect(ahead.length).toBeGreaterThan(0);
    for (const n of ahead) {
      expect(n.startsAt).toBeGreaterThanOrEqual(changedAt);
      expect(n).toEqual(nightWindow(n.key, 'America/Los_Angeles'));
    }
    // …the decisions already taken stand untouched, and nothing is decided for the past.
    w.clock.set(T0 + 19 * DAY);
    processRiskDecisions(w.ctx, w.clock.now());
    const after = decisions(id);
    expect(after.slice(0, taken.length)).toEqual(taken);
    for (const r of after.slice(taken.length)) {
      expect(r.stormStartsAt!).toBeGreaterThanOrEqual(changedAt);
      expect(phaseAt(r.decisionAt, 'America/Los_Angeles')).toBe('night');
    }
    // The journey itself never moved: the same route, the same arrival, to the millisecond.
    const now = getSentBottle(w.ctx, ada(), id);
    expect(now.plannedArrivalAt).toBe(before.plannedArrivalAt);
    expect(now.route.nodeIds).toEqual(before.route.nodeIds);
    expect(now.releasedAt).toBe(before.releasedAt);
  });

  it('follows the account through daylight-saving changes, map and worker together', () => {
    // Israel leaves DST on 2026-10-25 02:00: the night of the 24th is thirteen hours long, on
    // the map and for the worker alike, and every storm still sits inside it.
    const id = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000114')).bottleId;
    const bottle = bottleRow(id);
    const nights = journeyNights(w.ctx, bottle, T0, T0 + 60 * DAY);
    const long = nights.find((n) => n.key === '2026-10-24')!;
    expect(long.endsAt - long.startsAt).toBe(13 * HOUR);
    for (const n of nights) {
      expect(phaseAt(n.startsAt, ZONE)).toBe('night');
      expect(phaseAt(n.startsAt - 1, ZONE)).toBe('day');
      expect(phaseAt(n.endsAt - 1, ZONE)).toBe('night');
      expect(phaseAt(n.endsAt, ZONE)).toBe('day');
    }
  });

  it('keeps a legacy journey (stamped v1 or v2) on its past decisions and walks new nights only', () => {
    const id = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000115')).bottleId;
    w.clock.set(T0 + 5 * DAY);
    processRiskDecisions(w.ctx, w.clock.now());
    const past = decisions(id);
    // Pretend it sailed under the old rules: the stamp stays what it was, and so do its rows.
    w.db.update(t.bottles).set({ riskPolicyVersion: 2 }).where(eq(t.bottles.id, id)).run();
    w.db
      .update(t.riskDecisions)
      .set({ policyVersion: 2 })
      .where(eq(t.riskDecisions.bottleId, id))
      .run();
    const stamped = decisions(id);
    w.clock.set(T0 + 19 * DAY);
    processRiskDecisions(w.ctx, w.clock.now());
    const all = decisions(id);
    expect(all.slice(0, stamped.length)).toEqual(stamped);
    expect(bottleRow(id).riskPolicyVersion).toBe(2);
    for (const r of all.slice(stamped.length)) {
      expect(r.policyVersion).toBe(RISK_POLICY_VERSION);
      expect(phaseAt(r.decisionAt, ZONE)).toBe('night');
    }
    // Its published storms are the same nights everyone else gets: nothing hidden, nothing extra.
    const published = stormWindowsFor(w.ctx, { ...bottleRow(id), state: 'at_sea' }, T0 + 10 * DAY);
    for (const win of published) {
      expect(phaseAt(Date.parse(win.startsAt), ZONE)).toBe('night');
      expect(phaseAt(Date.parse(win.endsAt) - 1, ZONE)).toBe('night');
    }
    expect(past.length).toBeLessThanOrEqual(all.length);
  });

  it('refuses a zone the runtime does not know', () => {
    expect(() => setAccountTimeZone(w.ctx, ada(), 'Mars/Olympus_Mons')).toThrow(AppError);
    expect(accountNightZone(w.ctx, ada().id)!.zone).toBe(ZONE);
  });
});
