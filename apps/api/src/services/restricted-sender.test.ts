import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RISK_POLICY, bottleRiskDraws, nextRollSlot, rollAccountStorm } from '@mib/shared';
import * as t from '../db/schema.js';
import { DEV_SEED_PASSWORD } from '../db/seed-data.js';
import { plannedArrivalAt } from '../domain/routing.js';
import type * as Ids from '../lib/ids.js';
import { hashPassword } from '../lib/password.js';
import { setAccountTimeZone } from './auth.js';
import { decideAppeal, decideCase, decideCaseCritical } from './admin.js';
import { openBottle, readOpenedLetter } from './bottles.js';
import type { AuthUser } from './context.js';
import { canonicalPair } from './friends.js';
import { activePlan, commitArrivalIfDue, runJourneyTick } from './journey.js';
import { SUSPENSION_MS, accountStanding, reportLetter, submitAppeal } from './moderation.js';
import { activeReading, devLoseBottle, listPublicOcean, openPublicBottle } from './outcomes.js';
import { heldForRecipient, releaseBottle } from './release.js';
import { applyStandingEffects } from './restriction.js';
import { T0, createTestWorld, releaseInput, type TestWorld } from '../test/harness.js';

// Audit ARCH-R-002: when an account becomes suspended or banned, what it still has on its way to
// others ends — every bottle still travelling, and every adrift bottle still listed unopened in
// the public ocean. Letters already delivered or opened are untouched; nothing is restored when
// the restriction ends. Manual clocks, in-memory databases, pinned ids where a draw matters.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const bottleIds = vi.hoisted(() => ({ pinned: [] as string[] }));
vi.mock('../lib/ids.js', async (importOriginal) => {
  const real = await importOriginal<typeof Ids>();
  return {
    ...real,
    newId: (prefix: string) =>
      prefix === 'btl' && bottleIds.pinned.length ? bottleIds.pinned.shift()! : real.newId(prefix),
  };
});
beforeEach(() => {
  bottleIds.pinned = [];
});

let n = 0;
const key = () => `restrict-${String(++n).padStart(8, '0')}`;

// Journeys on the default chart take hours to a few days; everything here stays inside that.
function world(overrides: Parameters<typeof createTestWorld>[0] = {}) {
  const w = createTestWorld({ defaultShoreCapacity: 40, ...overrides });
  // Dee decides cases; she is party to none of them.
  w.db
    .update(t.users)
    .set({ role: 'admin' })
    .where(eq(t.users.id, w.user('dee').id))
    .run();
  return w;
}
const admin = (w: TestWorld): AuthUser => ({ ...w.user('dee'), role: 'admin' });
// Both clocks move together, as they do in production.
const advance = (w: TestWorld, ms: number) => {
  w.clock.advance(ms);
  w.realClock.advance(ms);
};
const send = (w: TestWorld, from: string, to: string) =>
  releaseBottle(w.ctx, w.user(from), releaseInput(w.user(to).id, key())).bottleId;
const deliver = (w: TestWorld, id: string) => {
  advance(w, 60 * DAY);
  expect(commitArrivalIfDue(w.ctx, id, w.clock.now())).toBe(true);
};
// A letter from Ada that Bo opened and reported: one case to decide.
function reportedCase(w: TestWorld): string {
  const id = send(w, 'ada', 'bo');
  deliver(w, id);
  openBottle(w.ctx, w.user('bo'), id);
  return reportLetter(w.ctx, w.user('bo'), { bottleId: id, reason: 'harassment', hide: false })
    .caseId;
}

const bottle = (w: TestWorld, id: string) =>
  w.db.select().from(t.bottles).where(eq(t.bottles.id, id)).get()!;
const events = (w: TestWorld, id: string) =>
  w.db
    .select({ type: t.journeyEvents.type, payload: t.journeyEvents.payload })
    .from(t.journeyEvents)
    .where(eq(t.journeyEvents.bottleId, id))
    .all();
const noticesAbout = (w: TestWorld, id: string) =>
  w.db
    .select({ userId: t.notifications.userId, kind: t.notifications.kind })
    .from(t.notifications)
    .where(eq(t.notifications.bottleId, id))
    .all();
const reservation = (w: TestWorld, id: string) =>
  w.db
    .select({ status: t.capacityReservations.status })
    .from(t.capacityReservations)
    .where(eq(t.capacityReservations.bottleId, id))
    .get()?.status;

// Everything Ada has out in the world when the restriction lands.
function outgoing(w: TestWorld) {
  const deliveredUnopened = send(w, 'ada', 'cy');
  deliver(w, deliveredUnopened);
  const opened = send(w, 'ada', 'cy');
  deliver(w, opened);
  openBottle(w.ctx, w.user('cy'), opened);
  // Adrift in the public ocean: one nobody has opened, one a finder is reading right now.
  const adriftListed = send(w, 'ada', 'bo');
  devLoseBottle(w.ctx, w.user('ada'), adriftListed, 'adrift');
  const adriftFound = send(w, 'ada', 'bo');
  devLoseBottle(w.ctx, w.user('ada'), adriftFound, 'adrift');
  openPublicBottle(w.ctx, w.user('cy'), adriftFound);
  const toBo = send(w, 'ada', 'bo');
  const toCy = send(w, 'ada', 'cy');
  return { deliveredUnopened, opened, adriftListed, adriftFound, toBo, toCy };
}

function expectEnded(w: TestWorld, o: ReturnType<typeof outgoing>) {
  for (const id of [o.toBo, o.toCy]) {
    expect(bottle(w, id).state).toBe('cancelled');
    expect(reservation(w, id)).toBe('released');
    expect(events(w, id)).toContainEqual({
      type: 'cancelled',
      payload: { reason: 'delivery_unavailable' },
    });
    // The sender hears "delivery unavailable" once; the recipient hears nothing at all.
    expect(noticesAbout(w, id)).toEqual([{ userId: w.user('ada').id, kind: 'sent_cancelled' }]);
  }
  expect(heldForRecipient(w.db, w.user('bo').id)).toBe(0);
  // The unopened adrift listing is gone from the public ocean and can no longer be opened.
  expect(bottle(w, o.adriftListed).publicExpiredAt).not.toBeNull();
  const ocean = listPublicOcean(w.ctx, w.user('bo')).map((b) => b.id);
  expect(ocean).not.toContain(o.adriftListed);
  expect(() => openPublicBottle(w.ctx, w.user('bo'), o.adriftListed)).toThrow();
  // Already delivered or opened: untouched, still readable by the person who has it.
  expect(bottle(w, o.deliveredUnopened).state).toBe('delivered');
  expect(bottle(w, o.opened).state).toBe('opened');
  expect(readOpenedLetter(w.ctx, w.user('cy'), o.opened).letter.text.length).toBeGreaterThan(0);
  expect(bottle(w, o.adriftFound).publicExpiredAt).toBeNull();
  expect(activeReading(w.ctx, w.user('cy'))?.bottle.id).toBe(o.adriftFound);
}

describe('a restricted sender’s letters stop travelling (ARCH-R-002)', () => {
  it('a warning alone changes nothing', () => {
    const w = world();
    const c1 = reportedCase(w);
    const o = outgoing(w);
    decideCase(w.ctx, admin(w), c1, 'accepted', 'harassment');
    expect(accountStanding(w.ctx, w.user('ada').id).standing).toBe('warned');
    expect(bottle(w, o.toBo).state).toBe('at_sea');
    expect(bottle(w, o.adriftListed).publicExpiredAt).toBeNull();
  });

  it('a suspension ends every journey still travelling and withdraws unopened adrift letters', () => {
    const w = world();
    const [c1, c2] = [reportedCase(w), reportedCase(w)];
    decideCase(w.ctx, admin(w), c1, 'accepted', 'harassment');
    const o = outgoing(w);
    decideCase(w.ctx, admin(w), c2, 'accepted', 'harassment');
    expect(accountStanding(w.ctx, w.user('ada').id).standing).toBe('suspended');
    expectEnded(w, o);
    // The worker never revives them: no arrival, no storm, no notice.
    advance(w, 60 * DAY);
    runJourneyTick(w.ctx);
    expect(bottle(w, o.toBo).state).toBe('cancelled');
    expect(noticesAbout(w, o.toBo)).toHaveLength(1);
    expect(
      w.db.select().from(t.riskDecisions).where(eq(t.riskDecisions.bottleId, o.toBo)).all(),
    ).toEqual([]);
  });

  it('a permanent ban from the third violation does the same', () => {
    const w = world();
    const [c1, c2, c3] = [reportedCase(w), reportedCase(w), reportedCase(w)];
    decideCase(w.ctx, admin(w), c1, 'accepted', 'harassment');
    decideCase(w.ctx, admin(w), c2, 'accepted', 'harassment');
    // Serve the suspension, then send again.
    advance(w, SUSPENSION_MS + HOUR);
    const o = outgoing(w);
    decideCase(w.ctx, admin(w), c3, 'accepted', 'harassment');
    expect(accountStanding(w.ctx, w.user('ada').id).standing).toBe('banned');
    expectEnded(w, o);
  });

  it('a critical child-safety ban does the same, at once', () => {
    const w = world();
    const c1 = reportedCase(w);
    const o = outgoing(w);
    decideCaseCritical(w.ctx, admin(w), c1, 'Confirmed critical child-safety violation.');
    expect(accountStanding(w.ctx, w.user('ada').id).standing).toBe('banned');
    expectEnded(w, o);
  });

  it('is idempotent: a repeated decision, a recalculated standing and worker retries change nothing twice', () => {
    const w = world();
    const c1 = reportedCase(w);
    const o = outgoing(w);
    decideCaseCritical(w.ctx, admin(w), c1, 'Confirmed critical child-safety violation.');
    const snapshot = () => ({
      bottles: w.db.select().from(t.bottles).orderBy(t.bottles.id).all(),
      events: w.db.select().from(t.journeyEvents).orderBy(t.journeyEvents.id).all(),
      notices: w.db.select().from(t.notifications).orderBy(t.notifications.id).all(),
      reservations: w.db
        .select()
        .from(t.capacityReservations)
        .orderBy(t.capacityReservations.id)
        .all(),
    });
    const before = snapshot();
    expect(decideCase(w.ctx, admin(w), c1, 'accepted', 'again')).toBe(false);
    for (let i = 0; i < 3; i++) {
      w.db.transaction((tx) =>
        applyStandingEffects(w.ctx, tx, w.user('ada').id, w.realClock.now()),
      );
      runJourneyTick(w.ctx);
    }
    expect(snapshot()).toEqual(before);
    expectEnded(w, o);
  });

  it('when the suspension expires nothing is restored; new letters travel normally', () => {
    const w = world();
    const [c1, c2] = [reportedCase(w), reportedCase(w)];
    decideCase(w.ctx, admin(w), c1, 'accepted', 'harassment');
    const o = outgoing(w);
    decideCase(w.ctx, admin(w), c2, 'accepted', 'harassment');
    advance(w, SUSPENSION_MS + HOUR);
    expect(accountStanding(w.ctx, w.user('ada').id).standing).not.toBe('suspended');
    runJourneyTick(w.ctx);
    expect(bottle(w, o.toBo).state).toBe('cancelled');
    expect(bottle(w, o.toCy).state).toBe('cancelled');
    const fresh = send(w, 'ada', 'bo');
    deliver(w, fresh);
    expect(bottle(w, fresh).state).toBe('delivered');
  });

  it('an accepted appeal restores no ended journey; new letters travel normally', () => {
    const w = world();
    const [c1, c2] = [reportedCase(w), reportedCase(w)];
    decideCase(w.ctx, admin(w), c1, 'accepted', 'harassment');
    const o = outgoing(w);
    decideCase(w.ctx, admin(w), c2, 'accepted', 'harassment');
    const violation = w.db
      .select()
      .from(t.violations)
      .where(and(eq(t.violations.userId, w.user('ada').id), eq(t.violations.caseId, c2)))
      .get()!;
    const appealId = submitAppeal(w.ctx, w.user('ada'), {
      violationId: violation.id,
      text: 'Context was missing.',
    }).appeal!.id;
    expect(decideAppeal(w.ctx, admin(w), appealId, 'accepted', 'Agreed.')).toBe(true);
    expect(accountStanding(w.ctx, w.user('ada').id).standing).toBe('warned');
    runJourneyTick(w.ctx);
    expect(bottle(w, o.toBo).state).toBe('cancelled');
    expect(bottle(w, o.adriftListed).publicExpiredAt).not.toBeNull();
    const fresh = send(w, 'ada', 'cy');
    deliver(w, fresh);
    expect(bottle(w, fresh).state).toBe('delivered');
  });

  it('delivers, rather than cancels, a letter whose arrival was already due, however late the worker is', () => {
    const run = (workerOnTime: boolean) => {
      const w = world();
      const [c1, c2] = [reportedCase(w), reportedCase(w)];
      decideCase(w.ctx, admin(w), c1, 'accepted', 'harassment');
      const due = send(w, 'ada', 'bo');
      const arrival = plannedArrivalAt(activePlan(w.db, due)!);
      // The decision lands an hour after the letter reached its shore.
      w.clock.set(arrival + HOUR);
      w.realClock.set(arrival + HOUR);
      const later = send(w, 'ada', 'cy');
      if (workerOnTime) runJourneyTick(w.ctx);
      decideCase(w.ctx, admin(w), c2, 'accepted', 'harassment');
      return {
        due: { ...bottle(w, due), id: undefined, version: undefined },
        later: bottle(w, later).state,
        dueNotices: noticesAbout(w, due)
          .map((x) => x.kind)
          .sort(),
      };
    };
    const onTime = run(true);
    const late = run(false);
    expect(late.due.state).toBe('delivered');
    expect(late.due.deliveredAt).toBe(onTime.due.deliveredAt);
    expect(late.dueNotices).toEqual(onTime.dueNotices);
    expect(late.later).toBe('cancelled');
    expect(onTime.later).toBe('cancelled');
  });
});

// ---------- a storm that struck before the restriction still struck ----------

const ZONE = 'Asia/Jerusalem'; // T0 (12:00Z) is 15:00 there: daytime; dusk at 19:00.

function firstRoll(userId: string) {
  const slot = nextRollSlot([{ zone: ZONE, effectiveAt: T0 }], T0, T0 + 2 * DAY, T0)!;
  return rollAccountStorm(userId, slot);
}
function stormAccount(): string {
  for (let i = 0; i < 20000; i++) {
    const id = `usr_restrict_storm_${i}`;
    if (firstRoll(id).storm) return id;
  }
  throw new Error('no storm account');
}
function bottleThat(rolledAt: number, lose: boolean): string {
  for (let i = 0; i < 20000; i++) {
    const id = `btl_restrict_${lose ? 'lose' : 'keep'}_${i}`;
    if (bottleRiskDraws(id, rolledAt).lossDraw < RISK_POLICY.lossChance === lose) return id;
  }
  throw new Error('no bottle');
}
function member(w: TestWorld, id: string, shoreId: string, friendOf: string[]) {
  w.db
    .insert(t.users)
    .values({
      id,
      username: id,
      displayName: id,
      shoreId,
      createdAt: T0,
      passwordHash: hashPassword(DEV_SEED_PASSWORD),
      passwordUpdatedAt: T0,
      email: `${id}@example.test`,
    })
    .run();
  for (const other of friendOf) {
    const [low, high] = canonicalPair(id, other);
    w.db
      .insert(t.friendships)
      .values({
        id: `frd_${id}_${other}`,
        userLowId: low,
        userHighId: high,
        requestedById: id,
        status: 'accepted',
        createdAt: T0,
        acceptedAt: T0,
      })
      .run();
  }
}

describe('a storm midpoint already passed is decided before the restriction ends the journey', () => {
  it('gives the same outcome whether or not the worker reached the midpoint first', () => {
    const sailorId = stormAccount();
    const roll = firstRoll(sailorId);
    const lose = bottleThat(roll.rolledAt, true);
    const keep = bottleThat(roll.rolledAt, false);
    const run = (workerOnTime: boolean) => {
      bottleIds.pinned = [lose, keep];
      // Weeks-long journeys: both bottles are at sea through the first night.
      const w = world({ msPerChartUnit: 24 * HOUR, minJourneyMs: 20 * DAY });
      member(w, sailorId, 'shore_lantern_cove', [w.user('bo').id]);
      member(w, 'usr_restrict_neighbour', 'shore_lantern_cove', [sailorId]);
      setAccountTimeZone(w.ctx, w.user(sailorId), ZONE);
      send(w, sailorId, 'bo');
      send(w, sailorId, 'bo');
      // A letter to a neighbour on the same harbour arrives at once; it is opened and reported.
      const reportedId = send(w, sailorId, 'usr_restrict_neighbour');
      openBottle(w.ctx, w.user('usr_restrict_neighbour'), reportedId);
      const caseId = reportLetter(w.ctx, w.user('usr_restrict_neighbour'), {
        bottleId: reportedId,
        reason: 'harassment',
        hide: false,
      }).caseId;
      const at = roll.storm!.decisionAt + 60_000;
      w.clock.set(at);
      w.realClock.set(at);
      if (workerOnTime) runJourneyTick(w.ctx);
      decideCaseCritical(w.ctx, admin(w), caseId, 'Confirmed critical child-safety violation.');
      const decisions = (id: string) =>
        w.db
          .select({ eligible: t.riskDecisions.eligible, lost: t.riskDecisions.lost })
          .from(t.riskDecisions)
          .where(eq(t.riskDecisions.bottleId, id))
          .all();
      const view = (id: string) => {
        const b = bottle(w, id);
        return {
          state: b.state,
          lossReason: b.lossReason,
          outcomeAt: b.outcomeAt,
          listed: b.lossReason === 'adrift' && b.publicExpiredAt === null,
          decisions: decisions(id),
        };
      };
      return { lose: view(lose), keep: view(keep) };
    };
    const onTime = run(true);
    const late = run(false);
    // The storm struck before the ban in both worlds.
    expect(onTime.lose.state).toBe('lost');
    expect(late).toEqual(onTime);
    // What survived the storm is ended by the ban; nothing adrift stays listed.
    expect(late.keep.state).toBe('cancelled');
    expect(late.lose.listed).toBe(false);
  });
});
