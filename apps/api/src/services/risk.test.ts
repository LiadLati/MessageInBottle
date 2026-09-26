import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RISK_POLICY,
  RISK_POLICY_VERSION,
  bottleRiskDraws,
  nextRollSlot,
  nightWindow,
  nightsOverlapping,
  phaseAt,
  rollAccountStorm,
  type AccountRoll,
} from '@mib/shared';
import * as t from '../db/schema.js';
import type * as Ids from '../lib/ids.js';
import { AppError } from '../lib/errors.js';
import { getMyShore, getSentBottle, listReceivedLetters, readOwnLetter } from './bottles.js';
import type { AppContext } from './context.js';
import { plannedArrivalAt } from '../domain/routing.js';
import { commitArrivalIfDue, runJourneyTick } from './journey.js';
import { listNotifications } from './notifications.js';
import {
  closeReading,
  commitLoss,
  listPublicOcean,
  openPublicBottle,
} from './outcomes.js';
import { setAccountTimeZone } from './auth.js';
import { heldReservations, releaseBottle } from './release.js';
import {
  activatePublicListings,
  expirePublicListings,
  processRiskDecisions,
  stormWindowsFor,
} from './risk.js';
import { authoritativeZone, zoneHistory } from './weather.js';
import { T0, createTestWorld, releaseInput, type TestWorld } from '../test/harness.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Storm rolls are a pure function of the account id and the night, and each bottle's loss draw
// of the bottle id, so random ids would give every run a different schedule (audit QA-011).
// Seeded accounts are therefore given fixed ids (seeding creates ada, bo, cy and dee in that
// order, four per world), and a test that needs a particular draw names the bottle it releases,
// chosen by searching against the same pure functions the server uses.
const bottleIds = vi.hoisted(() => ({ pinned: [] as string[], next: 0, users: 0 }));
vi.mock('../lib/ids.js', async (importOriginal) => {
  const real = await importOriginal<typeof Ids>();
  const seeded = ['ada', 'bo', 'cy', 'dee'];
  return {
    ...real,
    newId: (prefix: string) =>
      prefix === 'btl'
        ? (bottleIds.pinned.shift() ?? `btl_risk_seq_${bottleIds.next++}`)
        : prefix === 'usr'
          ? `usr_risk_${seeded[bottleIds.users++ % seeded.length]}`
          : real.newId(prefix),
  };
});
beforeEach(() => {
  bottleIds.pinned = [];
  bottleIds.next = 0;
  bottleIds.users = 0;
});
// The next bottle released gets exactly this id.
const pinNextBottleId = (id: string) => bottleIds.pinned.push(id);

// A long journey (Ada → Bo takes a few hours by the seeded graph); we stretch time with a slow
// chart unit so a journey spans many nights and the policy has room to act. Ada's device has
// reported a zone, as any account that has opened the app has.
const ZONE = 'Asia/Jerusalem';
function slowWorld(overrides = {}, zone: string | null = ZONE) {
  const w = createTestWorld({ msPerChartUnit: 24 * HOUR, minJourneyMs: 20 * DAY, ...overrides });
  if (zone) setAccountTimeZone(w.ctx, w.user('ada'), zone);
  return w;
}

// Ada's storms between two instants, exactly as the server will roll them from her recorded
// map clock (policy v4 activates in each world at its first use, T0).
function adaStorms(w: TestWorld, from: number, to: number): AccountRoll[] {
  const history = zoneHistory(w.db, w.user('ada').id);
  const out: AccountRoll[] = [];
  const clockStart = Math.max(T0, history[0]!.effectiveAt);
  let notBefore = clockStart;
  for (;;) {
    const slot = nextRollSlot(history, notBefore, to, clockStart);
    if (!slot) break;
    const roll = rollAccountStorm(w.user('ada').id, slot);
    if (roll.storm && roll.storm.decisionAt >= from) out.push(roll);
    notBefore = slot.rolledAt + RISK_POLICY.rollSpacingMs;
  }
  return out;
}

// A bottle id that survives (false) or loses (true) at each of the given storms, in order.
function bottleIdFor(storms: AccountRoll[], fates: boolean[], salt: string): string {
  for (let i = 0; i < 200000; i++) {
    const id = `btl_${salt}_${i}`;
    if (
      fates.every(
        (lose, k) =>
          bottleRiskDraws(id, storms[k]!.rolledAt).lossDraw < RISK_POLICY.lossChance === lose,
      )
    )
      return id;
  }
  throw new Error('no bottle id found');
}

describe(`automatic storm outcomes (policy v${RISK_POLICY_VERSION})`, () => {
  let w: TestWorld;
  const ada = () => w.user('ada');
  const bo = () => w.user('bo');
  const decisions = (id: string) =>
    w.db
      .select()
      .from(t.riskDecisions)
      .where(eq(t.riskDecisions.bottleId, id))
      .orderBy(t.riskDecisions.decisionAt)
      .all();

  beforeEach(() => {
    w = slowWorld();
  });

  it('tags new journeys with the policy version and leaves older journeys untouched', () => {
    const fresh = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000001')).bottleId;
    expect(
      w.db.select().from(t.bottles).where(eq(t.bottles.id, fresh)).get()!.riskPolicyVersion,
    ).toBe(RISK_POLICY_VERSION);
    // A journey released before activation (null version): a month of nights, never a decision.
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

  it("takes each storm's decision exactly once, at the storm midpoint, and never again", () => {
    const storm = adaStorms(w, T0, T0 + 30 * DAY)[0]!;
    pinNextBottleId(bottleIdFor([storm], [false], 'once'));
    const id = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000002')).bottleId;
    // Just before the decision moment: nothing yet, even though the storm is visible.
    w.clock.set(storm.storm!.decisionAt - 1);
    expect(processRiskDecisions(w.ctx, w.clock.now()).decided).toBe(0);
    expect(getSentBottle(w.ctx, ada(), id).storms.length).toBeGreaterThan(0);
    expect(getSentBottle(w.ctx, ada(), id).stormsWeathered).toBe(0);
    w.clock.set(storm.storm!.decisionAt);
    expect(processRiskDecisions(w.ctx, w.clock.now()).decided).toBe(1);
    // The passport counts the storm the journey has now been through (FE-008).
    expect(getSentBottle(w.ctx, ada(), id).stormsWeathered).toBe(1);
    const roll = w.db
      .select()
      .from(t.weatherRolls)
      .where(eq(t.weatherRolls.rolledAt, storm.rolledAt))
      .get()!;
    expect(decisions(id)[0]).toMatchObject({
      nightKey: roll.id,
      policyVersion: RISK_POLICY_VERSION,
      stormStartsAt: storm.storm!.startsAt,
      stormEndsAt: storm.storm!.endsAt,
      decisionAt: storm.storm!.decisionAt,
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
    // A bottle that survives three storms and loses at the fourth, so the catch-up has to stop
    // exactly where the nightly walk did, and nothing is decided after the loss.
    const storms = adaStorms(w, T0, T0 + 14 * DAY);
    expect(storms.length).toBeGreaterThanOrEqual(4);
    const ID = bottleIdFor(storms, [false, false, false, true], 'catchup');
    const end = storms[3]!.storm!.decisionAt + DAY;
    const row = (r: typeof t.riskDecisions.$inferSelect) =>
      `${r.decisionAt}:${r.eligible}:${r.lost}`;
    pinNextBottleId(ID);
    releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000003'));
    // Walk hour by hour in one world…
    for (let at = T0; at <= end; at += HOUR) {
      w.clock.set(at);
      processRiskDecisions(w.ctx, w.clock.now());
    }
    const nightly = decisions(ID).map(row);
    // …and in a second world, the same account and bottle, offline the whole time.
    const off = slowWorld();
    pinNextBottleId(ID);
    releaseBottle(off.ctx, off.user('ada'), releaseInput(off.user('bo').id, 'key-0000000003'));
    off.clock.set(end);
    processRiskDecisions(off.ctx, off.clock.now());
    const caughtUp = off.db
      .select()
      .from(t.riskDecisions)
      .where(eq(t.riskDecisions.bottleId, ID))
      .orderBy(t.riskDecisions.decisionAt)
      .all();
    expect(caughtUp.map(row)).toEqual(nightly);
    expect(caughtUp.map((r) => r.decisionAt)).toEqual(
      storms.slice(0, 4).map((s) => s.storm!.decisionAt),
    );
    expect(caughtUp.every((r) => r.eligible)).toBe(true);
    expect(caughtUp.map((r) => r.lost)).toEqual([false, false, false, true]);
    expect(getSentBottle(off.ctx, off.user('ada'), ID).state).toBe('lost');
  });

  it('only the first five eligible decisions carry risk; storms after that are scenery', () => {
    // A long journey with more than six storms before the 80% cutoff and no losing draw among
    // the first five: only the cap can make the sixth one ineligible.
    w = slowWorld({ minJourneyMs: 60 * DAY });
    const storms = adaStorms(w, T0, T0 + 45 * DAY);
    expect(storms.length).toBeGreaterThan(6);
    const ID = bottleIdFor(storms.slice(0, 5), [false, false, false, false, false], 'cap');
    pinNextBottleId(ID);
    releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000004'));
    const plan = w.db.select().from(t.routePlans).where(eq(t.routePlans.bottleId, ID)).get()!;
    const cutoffAt = plan.startsAt + RISK_POLICY.progressCutoff * plan.plannedDurationMs;
    w.clock.set(cutoffAt - 1);
    processRiskDecisions(w.ctx, w.clock.now());
    const rows = decisions(ID);
    expect(rows.length).toBeGreaterThan(6);
    expect(rows.every((r) => r.decisionAt < cutoffAt && !r.lost)).toBe(true);
    // The spec's number, not the constant's: five, and five only.
    expect(rows.map((r) => r.eligible)).toEqual([
      true,
      true,
      true,
      true,
      true,
      ...rows.slice(5).map(() => false),
    ]);
    // Past the cap the storms are still on the map while the bottle is at sea.
    const sixth = rows[5]!;
    const bottle = w.db.select().from(t.bottles).where(eq(t.bottles.id, ID)).get()!;
    expect(bottle.state).toBe('at_sea');
    expect(stormWindowsFor(w.ctx, bottle, sixth.decisionAt)).toContainEqual({
      startsAt: new Date(sixth.stormStartsAt!).toISOString(),
      endsAt: new Date(sixth.stormEndsAt!).toISOString(),
    });
  });

  it('never decides at or after 80% progress, and arrival wins a race with a later storm', () => {
    w = slowWorld({ minJourneyMs: 80 * DAY });
    const probe = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000050')).bottleId;
    const probePlan = w.db
      .select()
      .from(t.routePlans)
      .where(eq(t.routePlans.bottleId, probe))
      .get()!;
    w.db.update(t.bottles).set({ riskPolicyVersion: null }).where(eq(t.bottles.id, probe)).run();
    const cutoffAt = probePlan.startsAt + RISK_POLICY.progressCutoff * probePlan.plannedDurationMs;
    const arrivalAt = plannedArrivalAt(probePlan);
    const storms = adaStorms(w, T0, arrivalAt);
    const before = storms.filter((s) => s.storm!.decisionAt < cutoffAt).slice(0, 5);
    const after = storms.filter(
      (s) => s.storm!.decisionAt >= cutoffAt && s.storm!.decisionAt < arrivalAt,
    );
    expect(after.length).toBeGreaterThanOrEqual(1);
    // A bottle that never loses before the cutoff, and would lose at every later storm if the
    // cutoff did not hold.
    const ID = bottleIdFor(
      [...before, ...after],
      [...before.map(() => false), ...after.map(() => true)],
      'cutoff',
    );
    pinNextBottleId(ID);
    releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000005'));
    w.clock.set(arrivalAt + DAY);
    processRiskDecisions(w.ctx, w.clock.now());
    const rows = decisions(ID);
    // Before the cutoff, the first five are eligible (and survive); any more are over the cap.
    const early = rows.filter((r) => r.decisionAt < cutoffAt);
    expect(early.map((r) => r.eligible)).toEqual(early.map((_, i) => i < 5));
    expect(early.every((r) => !r.lost)).toBe(true);
    const late = rows.filter((r) => r.decisionAt >= cutoffAt);
    expect(late).toHaveLength(after.length);
    expect(late.every((r) => !r.eligible && !r.lost)).toBe(true);
    // Now the arrival is due as well: it commits, and a loss can no longer.
    expect(getSentBottle(w.ctx, ada(), ID).state).toBe('at_sea');
    runJourneyTick(w.ctx);
    expect(getSentBottle(w.ctx, ada(), ID).state).toBe('delivered');
    expect(commitLoss(w.ctx, ID, 'adrift', w.clock.now()).committed).toBe(false);
  });

  it('a loss goes through the transactional service: position at the storm, slot freed, one notice', () => {
    const storm = adaStorms(w, T0, T0 + 30 * DAY)[0]!;
    const id = bottleIdFor([storm], [true], 'loss');
    pinNextBottleId(id);
    releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000006'));
    const draws = bottleRiskDraws(id, storm.rolledAt);

    w.clock.set(storm.storm!.decisionAt + HOUR);
    const r = processRiskDecisions(w.ctx, w.clock.now());
    expect(r.lost).toBe(1);
    const b = getSentBottle(w.ctx, ada(), id);
    expect(b.state).toBe('lost');
    expect(b.outcome!.reason).toBe(draws.reasonDraw < RISK_POLICY.adriftShare ? 'adrift' : 'sunk');
    expect(b.outcome!.at).toBe(new Date(storm.storm!.decisionAt).toISOString());
    expect(b.events.map((e) => e.type)).toEqual(['released', 'lost']);
    expect(heldReservations(w.db, 'shore_driftmoor_strand')).toBe(0);
    expect(listNotifications(w.ctx, ada().id).filter((n) => n.bottleId === id)).toHaveLength(1);
    // Again: nothing more happens, to anyone.
    expect(processRiskDecisions(w.ctx, w.clock.now())).toEqual({ decided: 0, lost: 0 });
    expect(commitArrivalIfDue(w.ctx, id, w.clock.now() + 100 * DAY)).toBe(false);
    expect(getMyShore(w.ctx, bo()).bottles).toEqual([]);
  });
});

describe('a losing decision and its loss are one commit (ARCH-007)', () => {
  it('records nothing when the loss cannot be written, and decides again next tick', () => {
    const w = slowWorld();
    const storm = adaStorms(w, T0, T0 + 30 * DAY)[0]!;
    const id = bottleIdFor([storm], [true], 'arch007');
    pinNextBottleId(id);
    releaseBottle(w.ctx, w.user('ada'), releaseInput(w.user('bo').id, 'key-0000000007'));
    // The loss write fails (a stand-in for a crash or a constraint error mid-commit).
    const client = (w.db as unknown as { $client: { exec: (sql: string) => void } }).$client;
    client.exec(`CREATE TRIGGER fail_loss BEFORE UPDATE OF state ON bottles
      WHEN NEW.state = 'lost' BEGIN SELECT RAISE(ABORT, 'loss write failed'); END`);
    w.clock.set(storm.storm!.decisionAt + HOUR);
    expect(() => processRiskDecisions(w.ctx, w.clock.now())).toThrow(/loss write failed/);
    // No decision row claims a loss that never happened, and the storm is still undecided, so
    // nothing blocks a retry.
    expect(
      w.db.select().from(t.riskDecisions).where(eq(t.riskDecisions.bottleId, id)).all(),
    ).toEqual([]);
    expect(
      w.db.select().from(t.weatherRolls).where(eq(t.weatherRolls.rolledAt, storm.rolledAt)).get()!
        .decidedAt,
    ).toBeNull();
    expect(getSentBottle(w.ctx, w.user('ada'), id).state).toBe('at_sea');
    client.exec('DROP TRIGGER fail_loss');
    expect(processRiskDecisions(w.ctx, w.clock.now()).lost).toBe(1);
    expect(getSentBottle(w.ctx, w.user('ada'), id).state).toBe('lost');
  });
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

  it('serves the letter once, in the opening response, and never again', () => {
    const reopen = () => {
      try {
        openPublicBottle(w.ctx, cy(), id);
      } catch (e) {
        return e as AppError;
      }
      throw new Error('a second opening was served');
    };
    const opened = openPublicBottle(w.ctx, cy(), id);
    expect(opened.letter.text).toContain('tide was gentle');
    expect(Object.keys(opened)).not.toContain('readingExpiresAt');
    // A second open a moment later — a refresh, a new tab, SeaYou reopened: nothing is served.
    w.clock.advance(1_000);
    const err = reopen();
    expect(err.code).toBe('reading_closed');
    expect(JSON.stringify(err)).not.toContain('tide was gentle');
    // No archive, no reread through the received endpoint.
    expect(listReceivedLetters(w.ctx, cy())).toEqual([]);
    // Finishing records the end of the reading; it is idempotent and serves nothing either.
    closeReading(w.ctx, cy(), id);
    closeReading(w.ctx, cy(), id);
    expect(reopen().code).toBe('reading_closed');
    // The opening itself is kept: still off the map, still "opened" for the sender.
    expect(listPublicOcean(w.ctx, bo())).toEqual([]);
    expect(getSentBottle(w.ctx, ada(), id).publicListing?.status).toBe('opened');
    expect(
      w.db.select().from(t.publicOpenings).where(eq(t.publicOpenings.bottleId, id)).get()
        ?.openedById,
    ).toBe(cy().id);
  });

  it('records no resumable window, and an older opening that had one grants no reread', () => {
    openPublicBottle(w.ctx, cy(), id);
    const row = () =>
      w.db.select().from(t.publicOpenings).where(eq(t.publicOpenings.bottleId, id)).get()!;
    expect(row().sessionExpiresAt).toBeNull();
    // A row written under the old rule, still inside its old 15-minute window.
    w.db
      .update(t.publicOpenings)
      .set({ sessionExpiresAt: w.clock.now() + 15 * 60 * 1000, closedAt: null })
      .run();
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
      cancelled: 0,
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

// One clock decides the map's day and night and whether a storm may exist: the account's
// authoritative zone (policy v4). A daytime map can therefore never hold a bottle in a
// risk-bearing storm, and a zone change moves only what lies ahead.
describe('the account map clock: map, storms and decisions on one phase', () => {
  let w: TestWorld;
  const ada = () => w.user('ada');
  const bo = () => w.user('bo');
  const bottleRow = (id: string) =>
    w.db.select().from(t.bottles).where(eq(t.bottles.id, id)).get()!;
  const decisions = (id: string) =>
    w.db
      .select()
      .from(t.riskDecisions)
      .where(eq(t.riskDecisions.bottleId, id))
      .orderBy(t.riskDecisions.decisionAt)
      .all();

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
        for (const at of [row.stormStartsAt!, row.decisionAt, row.stormEndsAt! - 1]) {
          expect(phaseAt(at, ZONE)).toBe('night');
        }
        expect(row.policyVersion).toBe(RISK_POLICY_VERSION);
      }
    }
    expect(checked).toBeGreaterThan(4);
  });

  it("shares one storm between all of an account's bottles, each with its own decision", () => {
    const a = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000110')).bottleId;
    const b = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000111')).bottleId;
    w.clock.set(T0 + 15 * DAY);
    processRiskDecisions(w.ctx, w.clock.now());
    // The same storms, at the same moments, for both: they are the account's weather…
    const at = (id: string) => decisions(id).map((r) => [r.nightKey, r.decisionAt]);
    expect(at(a).length).toBeGreaterThan(0);
    const common = Math.min(at(a).length, at(b).length);
    expect(at(a).slice(0, common)).toEqual(at(b).slice(0, common));
    // …and each decision came from the bottle's own draws.
    for (const id of [a, b])
      for (const r of decisions(id)) {
        const roll = w.db
          .select()
          .from(t.weatherRolls)
          .where(eq(t.weatherRolls.id, r.nightKey))
          .get()!;
        expect(r.lost).toBe(
          r.eligible && bottleRiskDraws(id, roll.rolledAt).lossDraw < RISK_POLICY.lossChance,
        );
      }
  });

  it('runs on the harbour clock until a device reports a zone, then on the device clock', () => {
    const quiet = slowWorld({}, null);
    const id = releaseBottle(
      quiet.ctx,
      quiet.user('ada'),
      releaseInput(quiet.user('bo').id, 'key-0000000112'),
    ).bottleId;
    // Lantern Cove, 52.3°W: the nautical zone three hours behind UTC.
    expect(authoritativeZone(quiet.ctx, quiet.user('ada').id)).toEqual({
      zone: 'Etc/GMT+3',
      source: 'harbour',
    });
    quiet.clock.set(T0 + 5 * DAY);
    processRiskDecisions(quiet.ctx, quiet.clock.now());
    for (const r of quiet.db.select().from(t.weatherRolls).all()) {
      expect(r.zone).toBe('Etc/GMT+3');
      expect(phaseAt(r.rolledAt, 'Etc/GMT+3')).toBe('night');
    }
    expect(getSentBottle(quiet.ctx, quiet.user('ada'), id).state).not.toBeUndefined();
    setAccountTimeZone(quiet.ctx, quiet.user('ada'), 'Europe/Berlin');
    expect(authoritativeZone(quiet.ctx, quiet.user('ada').id)).toEqual({
      zone: 'Europe/Berlin',
      source: 'device',
    });
  });

  it('moves the map clock ahead when the device zone changes, never behind', () => {
    const id = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000113')).bottleId;
    const before = getSentBottle(w.ctx, ada(), id);
    w.clock.set(T0 + 6 * DAY);
    processRiskDecisions(w.ctx, w.clock.now());
    const taken = decisions(id);
    const rollsBefore = w.db.select().from(t.weatherRolls).all();
    // Ada flies to Los Angeles: the app resumes and reports the new zone.
    const changedAt = w.clock.now();
    setAccountTimeZone(w.ctx, ada(), 'America/Los_Angeles');
    // Resuming again in the same zone is a no-op: no new history.
    w.clock.advance(HOUR);
    setAccountTimeZone(w.ctx, ada(), 'America/Los_Angeles');
    const history = zoneHistory(w.db, ada().id);
    expect(history.at(-1)).toEqual({ zone: 'America/Los_Angeles', effectiveAt: changedAt });
    expect(history.filter((h) => h.zone === 'America/Los_Angeles')).toHaveLength(1);
    // Decisions and rolls already made stand untouched; new rolls are Los Angeles nights.
    w.clock.set(T0 + 19 * DAY);
    processRiskDecisions(w.ctx, w.clock.now());
    expect(decisions(id).slice(0, taken.length)).toEqual(taken);
    const rollsAfter = w.db.select().from(t.weatherRolls).orderBy(t.weatherRolls.rolledAt).all();
    expect(rollsAfter.slice(0, rollsBefore.length)).toEqual(
      rollsBefore.map((r) => ({
        ...r,
        decidedAt: rollsAfter.find((x) => x.id === r.id)!.decidedAt,
      })),
    );
    for (const r of rollsAfter.slice(rollsBefore.length)) {
      expect(r.rolledAt).toBeGreaterThanOrEqual(changedAt);
      expect(r.zone).toBe('America/Los_Angeles');
      expect(phaseAt(r.rolledAt, 'America/Los_Angeles')).toBe('night');
    }
    // The journey itself never moved: the same route, the same arrival, to the millisecond.
    const now = getSentBottle(w.ctx, ada(), id);
    expect(now.plannedArrivalAt).toBe(before.plannedArrivalAt);
    expect(now.route.nodeIds).toEqual(before.route.nodeIds);
    expect(now.releasedAt).toBe(before.releasedAt);
  });

  it('follows the account through daylight-saving changes, never rolling twice in 24 hours', () => {
    // Israel leaves DST on 2026-10-25 02:00: the night of the 24th is thirteen hours long.
    const long = nightWindow('2026-10-24', ZONE);
    expect(long.endsAt - long.startsAt).toBe(13 * HOUR);
    releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000114'));
    w.clock.set(T0 + 60 * DAY);
    processRiskDecisions(w.ctx, w.clock.now());
    const rolls = w.db.select().from(t.weatherRolls).orderBy(t.weatherRolls.rolledAt).all();
    expect(rolls.length).toBeGreaterThan(15);
    for (const [i, r] of rolls.entries()) {
      expect(phaseAt(r.rolledAt, ZONE)).toBe('night');
      if (r.outcome === 'storm') {
        expect(phaseAt(r.stormStartsAt!, ZONE)).toBe('night');
        expect(phaseAt(r.stormEndsAt! - 1, ZONE)).toBe('night');
      }
      if (i > 0) expect(r.rolledAt - rolls[i - 1]!.rolledAt).toBeGreaterThanOrEqual(DAY);
    }
    // Every night of the span that had room got its roll.
    const nights = nightsOverlapping(T0, T0 + 60 * DAY, ZONE).filter(
      (n) => n.startsAt >= T0 && n.endsAt <= w.clock.now(),
    );
    expect(rolls.length).toBeGreaterThanOrEqual(nights.length - 1);
  });

  it('keeps an earlier-policy journey on its past decisions and decides only new storms', () => {
    const id = releaseBottle(w.ctx, ada(), releaseInput(bo().id, 'key-0000000115')).bottleId;
    // It sailed under v2 before v4 existed: its stamp and its recorded decision stay as they are.
    w.db.update(t.bottles).set({ riskPolicyVersion: 2 }).where(eq(t.bottles.id, id)).run();
    const old = {
      id: 'rsk_v2_old',
      bottleId: id,
      nightKey: '2026-09-05',
      policyVersion: 2,
      stormStartsAt: T0 - 20 * HOUR,
      stormEndsAt: T0 - 19 * HOUR,
      decisionAt: T0 - 19.5 * HOUR,
      eligible: true,
      lost: false,
      reason: null,
      createdAt: T0 - 19 * HOUR,
    };
    w.db.insert(t.riskDecisions).values(old).run();
    w.clock.set(T0 + 19 * DAY);
    processRiskDecisions(w.ctx, w.clock.now());
    const all = decisions(id);
    expect(all[0]).toEqual(old);
    expect(bottleRow(id).riskPolicyVersion).toBe(2);
    for (const r of all.slice(1)) {
      expect(r.policyVersion).toBe(RISK_POLICY_VERSION);
      expect(r.decisionAt).toBeGreaterThanOrEqual(T0);
      expect(phaseAt(r.decisionAt, ZONE)).toBe('night');
    }
  });

  it('refuses a zone the runtime does not know', () => {
    expect(() => setAccountTimeZone(w.ctx, ada(), 'Mars/Olympus_Mons')).toThrow(AppError);
    expect(authoritativeZone(w.ctx, ada().id).zone).toBe(ZONE);
  });
});
