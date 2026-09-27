import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RISK_POLICY,
  RISK_POLICY_VERSION,
  bottleRiskDraws,
  firstDaytime,
  nextRollSlot,
  phaseAt,
  rollAccountStorm,
  type AccountRoll,
  type AccountWeatherDto,
  type ZoneChange,
} from '@mib/shared';
import { runMigrations } from '../db/client.js';
import * as t from '../db/schema.js';
import { DEV_SEED_PASSWORD } from '../db/seed-data.js';
import { plannedArrivalAt, progressAt } from '../domain/routing.js';
import { createApp } from '../http/app.js';
import type * as Ids from '../lib/ids.js';
import { hashPassword } from '../lib/password.js';
import { decideCase } from './admin.js';
import { openBottle } from './bottles.js';
import { accountStanding, reportLetter } from './moderation.js';
import { canonicalPair } from './friends.js';
import { setAccountTimeZone } from './auth.js';
import { activePlan, runJourneyTick } from './journey.js';
import { releaseBottle } from './release.js';
import { decideDueStorms, processRiskDecisions, stormWindowsFor } from './risk.js';
import { accountWeather, ensureRolls } from './weather.js';
import {
  T0,
  acceptCurrent,
  createTestWorld,
  evidenceDigest,
  loginAs,
  releaseInput,
  type TestWorld,
} from '../test/harness.js';

// Risk policy v4: one authoritative map clock per account; storms follow the map. Every test
// here runs on manual clocks and temporary in-memory databases. Outcomes that depend on a
// deterministic draw (storm or calm, a bottle's loss) are chosen by searching ids against the
// same pure functions the server uses — never by chance, never by the machine's time zone.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ZONE = 'Asia/Jerusalem'; // T0 (12:00Z, 6 Sep 2026) is 15:00 there: daytime.
const DUSK = Date.parse('2026-09-06T16:00:00.000Z'); // 19:00 in Jerusalem

// Bottle ids decide each bottle's own draws, so a test that needs a loss names its bottle.
const bottleIds = vi.hoisted(() => ({ pinned: [] as string[], next: 0 }));
vi.mock('../lib/ids.js', async (importOriginal) => {
  const real = await importOriginal<typeof Ids>();
  return {
    ...real,
    newId: (prefix: string) =>
      prefix === 'btl'
        ? (bottleIds.pinned.shift() ?? `btl_acct_seq_${bottleIds.next++}`)
        : real.newId(prefix),
  };
});
beforeEach(() => {
  bottleIds.pinned = [];
  bottleIds.next = 0;
});

// ---------- deterministic set-up ----------

function predictRolls(userId: string, changes: ZoneChange[], from: number, to: number) {
  const out: AccountRoll[] = [];
  let notBefore = from;
  for (;;) {
    const slot = nextRollSlot(changes, notBefore, to, from);
    if (!slot) return out;
    out.push(rollAccountStorm(userId, slot));
    notBefore = slot.rolledAt + RISK_POLICY.rollSpacingMs;
  }
}

// An account id whose first night in ZONE (from T0) rolls the wanted result.
function accountId(
  want: 'storm' | 'calm',
  salt = '',
  accept: (roll: AccountRoll) => boolean = () => true,
): string {
  for (let i = 0; i < 20000; i++) {
    const id = `usr_${want}${salt}_${i}`;
    const [first] = predictRolls(id, [{ zone: ZONE, effectiveAt: T0 }], T0, T0 + 2 * DAY);
    if (first && Boolean(first.storm) === (want === 'storm') && accept(first)) return id;
  }
  throw new Error('no account found');
}
const firstRoll = (id: string) =>
  predictRolls(id, [{ zone: ZONE, effectiveAt: T0 }], T0, T0 + DAY)[0]!;

// A bottle id whose draws for the storm rolled at `rolledAt` lose (or keep) the bottle.
function bottleId(rolledAt: number, lose: boolean, salt = ''): string {
  for (let i = 0; i < 20000; i++) {
    const id = `btl_${lose ? 'lose' : 'keep'}${salt}_${i}`;
    if (bottleRiskDraws(id, rolledAt).lossDraw < RISK_POLICY.lossChance === lose) return id;
  }
  throw new Error('no bottle found');
}

// Long journeys (weeks) so a bottle sails through many nights.
function world(): TestWorld {
  return createTestWorld({ msPerChartUnit: 24 * HOUR, minJourneyMs: 20 * DAY });
}

// An account with a chosen id, befriended by Bo, whose device reports ZONE at T0.
function sailor(w: TestWorld, id: string, zone: string | null = ZONE) {
  w.db
    .insert(t.users)
    .values({
      id,
      username: id,
      displayName: id,
      shoreId: 'shore_lantern_cove',
      createdAt: T0,
      passwordHash: hashPassword(DEV_SEED_PASSWORD),
      passwordUpdatedAt: T0,
      email: `${id}@example.test`,
    })
    .run();
  const bo = w.user('bo').id;
  const [low, high] = canonicalPair(id, bo);
  w.db
    .insert(t.friendships)
    .values({
      id: `frd_${id}`,
      userLowId: low,
      userHighId: high,
      requestedById: id,
      status: 'accepted',
      createdAt: T0,
      acceptedAt: T0,
    })
    .run();
  if (zone) setAccountTimeZone(w.ctx, w.user(id), zone);
  return w.user(id);
}

let keyN = 0;
const key = () => `key-acct-${String(++keyN).padStart(8, '0')}`;
const send = (w: TestWorld, from: string) =>
  releaseBottle(w.ctx, w.user(from), releaseInput(w.user('bo').id, key())).bottleId;

const rollsOf = (w: TestWorld, userId: string) =>
  w.db
    .select()
    .from(t.weatherRolls)
    .where(eq(t.weatherRolls.userId, userId))
    .orderBy(t.weatherRolls.rolledAt)
    .all();
const decisionsOf = (w: TestWorld, bottle: string) =>
  w.db
    .select()
    .from(t.riskDecisions)
    .where(eq(t.riskDecisions.bottleId, bottle))
    .orderBy(t.riskDecisions.decisionAt)
    .all();
const bottleRow = (w: TestWorld, id: string) =>
  w.db.select().from(t.bottles).where(eq(t.bottles.id, id)).get()!;
const tick = (w: TestWorld, at: number) => {
  w.clock.set(at);
  return runJourneyTick(w.ctx);
};
// Stable comparison of persisted rows: ids and bookkeeping times aside.
const shapeOfRolls = (w: TestWorld, userId: string) =>
  rollsOf(w, userId).map(({ id: _i, createdAt: _c, decidedAt: _d, ...r }) => r);

// ---------- the map clock ----------

describe('one authoritative map clock', () => {
  it('uses the harbour zone before any device report, UTC without a harbour, then the device zone', async () => {
    const w = world();
    const app = createApp(w.ctx);
    const ada = await loginAs(app, 'ada');
    const get = async (token: string) =>
      (await (
        await app.request('/api/ocean/weather', { headers: { authorization: `Bearer ${token}` } })
      ).json()) as AccountWeatherDto;
    // Lantern Cove sits at 52.3°W: the nautical zone three hours behind UTC.
    expect(await get(ada.token)).toMatchObject({
      timeZone: 'Etc/GMT+3',
      timeZoneSource: 'harbour',
    });
    // Dee has chosen no harbour.
    const dee = await loginAs(app, 'dee');
    expect(await get(dee.token)).toMatchObject({ timeZone: 'UTC', timeZoneSource: 'utc' });
    // The device reports; the server validates, stores and returns it.
    const put = await app.request('/api/auth/time-zone', {
      method: 'PUT',
      headers: { authorization: `Bearer ${ada.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ timeZone: ZONE }),
    });
    expect(put.status).toBe(200);
    expect(await get(ada.token)).toMatchObject({ timeZone: ZONE, timeZoneSource: 'device' });
    expect(w.db.select().from(t.users).where(eq(t.users.username, 'ada')).get()!.timeZone).toBe(
      ZONE,
    );
  });

  it('gives every session of the account the same day, night and storm, and flips the map at once', async () => {
    const id = accountId('storm');
    const w = world();
    sailor(w, id);
    const app = createApp(w.ctx);
    const phone = await loginAs(app, id);
    const desktop = await loginAs(app, id);
    await app.request('/api/policies/accept', {
      method: 'POST',
      headers: { authorization: `Bearer ${phone.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(acceptCurrent()),
    });
    const get = async (token: string) => {
      const res = await app.request('/api/ocean/weather', {
        headers: { authorization: `Bearer ${token}` },
      });
      // Everything but the server's own timestamp must match between devices.
      const body = (await res.json()) as Partial<AccountWeatherDto>;
      delete body.serverTime;
      return body;
    };
    expect(await get(phone.token)).toMatchObject({ phase: 'day', storm: null });
    w.clock.set(firstRoll(id).storm!.startsAt + 60_000);
    const a = await get(phone.token);
    const b = await get(desktop.token);
    expect(a).toEqual(b);
    expect(a.phase).toBe('night');
    expect(a.storm).not.toBeNull();
    // The phone crosses to Los Angeles (daytime there): the next read on either device is day,
    // with no storm.
    await app.request('/api/auth/time-zone', {
      method: 'PUT',
      headers: { authorization: `Bearer ${phone.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ timeZone: 'America/Los_Angeles' }),
    });
    const after = await get(desktop.token);
    expect(after).toMatchObject({ timeZone: 'America/Los_Angeles', phase: 'day', storm: null });
    expect(await get(phone.token)).toEqual(after);
  });

  it('refuses an invalid zone without spending the change budget', async () => {
    const w = world();
    const app = createApp(w.ctx);
    const ada = await loginAs(app, 'ada');
    const put = (zone: string) =>
      app.request('/api/auth/time-zone', {
        method: 'PUT',
        headers: { authorization: `Bearer ${ada.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ timeZone: zone }),
      });
    for (const bad of ['Mars/Olympus', '+05:00', 'EST5EDT; drop', 'Europe/Nowhere', 'utc'])
      expect((await put(bad)).status).toBe(400);
    const statuses = [];
    for (const z of [
      'Europe/Berlin',
      'Asia/Tokyo',
      'America/Chicago',
      'Europe/Paris',
      'Asia/Dubai',
    ])
      statuses.push((await put(z)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
    // No history row for any refused value.
    const zones = w.db
      .select()
      .from(t.accountZoneChanges)
      .all()
      .map((r) => r.zone);
    expect(zones.some((z) => z.includes('Mars') || z.includes('Nowhere'))).toBe(false);
  });
});

// ---------- storms follow the map ----------

describe('storms follow the visible map state', () => {
  it('a daytime map has no roll, no storm and nothing scheduled', () => {
    const id = accountId('storm');
    const w = world();
    sailor(w, id);
    send(w, id);
    for (let at = T0; at < DUSK; at += 15 * 60_000) {
      tick(w, at);
      expect(accountWeather(w.ctx, id)).toMatchObject({
        phase: 'day',
        storm: null,
        lastRoll: null,
      });
    }
    expect(rollsOf(w, id)).toEqual([]);
  });

  it('a night gets exactly one deterministic 25% roll, persisted and never rerolled', () => {
    const storm = accountId('storm');
    const calm = accountId('calm');
    for (const [id, outcome] of [
      [storm, 'storm'],
      [calm, 'calm'],
    ] as const) {
      const w = world();
      sailor(w, id);
      send(w, id);
      // Refresh, poll, reopen: many reads and ticks through the night.
      for (let at = DUSK; at < DUSK + 11 * HOUR; at += 20 * 60_000) {
        tick(w, at);
        accountWeather(w.ctx, id);
        ensureRolls(w.ctx, id, at);
      }
      const rolls = rollsOf(w, id);
      expect(rolls).toHaveLength(1);
      expect(rolls[0]).toMatchObject({ rolledAt: DUSK, outcome, zone: ZONE, policyVersion: 4 });
      // A worker restart: a fresh context on the same database changes nothing.
      const restarted = { ...w.ctx };
      processRiskDecisions(restarted, w.clock.now());
      ensureRolls(restarted, id, w.clock.now());
      expect(rollsOf(w, id)).toEqual(rolls);
    }
  });

  it('the same account and inputs always produce the same result, in any database', () => {
    const id = accountId('storm');
    const shapes = [0, 1].map(() => {
      const w = world();
      sailor(w, id);
      for (let at = T0; at < T0 + 10 * DAY; at += 6 * HOUR) ensureRolls(w.ctx, id, at);
      return shapeOfRolls(w, id);
    });
    expect(shapes[0]!.length).toBe(10);
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[0]).toEqual(
      predictRolls(id, [{ zone: ZONE, effectiveAt: T0 }], T0, T0 + 10 * DAY - 6 * HOUR).map(
        (r): unknown =>
          expect.objectContaining({ rolledAt: r.rolledAt, outcome: r.storm ? 'storm' : 'calm' }),
      ),
    );
  });

  it('keeps every storm wholly inside the night it was rolled in, and only shows it at night', () => {
    const w = world();
    const ids = Array.from({ length: 12 }, (_, i) => accountId('storm', `_n${i}`));
    for (const id of ids) sailor(w, id);
    const end = T0 + 40 * DAY;
    for (const id of ids) ensureRolls(w.ctx, id, end);
    const storms = w.db
      .select()
      .from(t.weatherRolls)
      .all()
      .filter((r) => r.outcome === 'storm');
    expect(storms.length).toBeGreaterThan(40);
    for (const r of storms) {
      expect(r.stormStartsAt!).toBeGreaterThanOrEqual(r.nightStartsAt);
      expect(r.stormStartsAt!).toBeGreaterThanOrEqual(r.rolledAt);
      expect(r.stormEndsAt!).toBeLessThanOrEqual(r.nightEndsAt);
      expect(phaseAt(r.stormStartsAt!, r.zone)).toBe('night');
      expect(phaseAt(r.stormEndsAt! - 1, r.zone)).toBe('night');
      expect(r.decisionAt).toBe(Math.round((r.stormStartsAt! + r.stormEndsAt!) / 2));
    }
    // The map shows no storm in daytime, whatever the rolls say.
    for (let at = T0; at < T0 + 3 * DAY; at += 30 * 60_000) {
      w.clock.set(at);
      const weather = accountWeather(w.ctx, ids[0]!);
      if (weather.phase === 'day') expect(weather.storm).toBeNull();
    }
  });
});

// ---------- the rolling 24 hours ----------

describe('no weather reroll inside a rolling 24 hours', () => {
  it('a zone change, a date boundary or a later evening elsewhere never adds a roll', () => {
    const id = accountId('calm');
    const w = world();
    sailor(w, id);
    send(w, id); // a journey at sea keeps the worker rolling this account
    tick(w, DUSK + 30 * 60_000); // rolled at 19:00 Jerusalem
    expect(rollsOf(w, id)).toHaveLength(1);
    // Past local midnight: a new calendar date, same night, no roll.
    tick(w, DUSK + 6 * HOUR);
    expect(rollsOf(w, id)).toHaveLength(1);
    // Fly west: New York's evening starts 7 hours after Jerusalem's — a fresh local night, but
    // inside the same 24 hours, so still no roll.
    w.clock.set(DUSK + 6 * HOUR + 30 * 60_000);
    setAccountTimeZone(w.ctx, w.user(id), 'America/New_York');
    for (let at = DUSK + 7 * HOUR; at < DUSK + 23 * HOUR; at += HOUR) tick(w, at);
    expect(rollsOf(w, id)).toHaveLength(1);
    // Back and forth changes do not help either.
    setAccountTimeZone(w.ctx, w.user(id), ZONE);
    setAccountTimeZone(w.ctx, w.user(id), 'Asia/Tokyo');
    tick(w, DUSK + 23 * HOUR + 59 * 60_000);
    expect(rollsOf(w, id)).toHaveLength(1);
    // A day later the account rolls again, never sooner than 24 hours after the last roll.
    tick(w, DUSK + 3 * DAY);
    const rolls = rollsOf(w, id);
    expect(rolls.length).toBeGreaterThan(1);
    for (let i = 1; i < rolls.length; i++)
      expect(rolls[i]!.rolledAt - rolls[i - 1]!.rolledAt).toBeGreaterThanOrEqual(DAY);
  });

  it('turning an active storm to day before its midpoint cancels only the pending decision', () => {
    const id = accountId('storm');
    const w = world();
    sailor(w, id);
    const bottle = send(w, id);
    const predicted = firstRoll(id);
    const storm = predicted.storm!;
    tick(w, storm.startsAt + 60_000);
    expect(accountWeather(w.ctx, id).storm).not.toBeNull();
    // Before the midpoint the device reports Los Angeles, where it is daytime.
    w.clock.set(storm.startsAt + 2 * 60_000);
    expect(w.clock.now()).toBeLessThan(storm.decisionAt);
    setAccountTimeZone(w.ctx, w.user(id), 'America/Los_Angeles');
    const [roll] = rollsOf(w, id);
    expect(roll).toMatchObject({ outcome: 'storm', decidedAt: null, cancelReason: 'daytime' });
    expect(roll!.cancelledAt).toBe(storm.startsAt + 2 * 60_000);
    expect(accountWeather(w.ctx, id).storm).toBeNull();
    expect(stormWindowsFor(w.ctx, bottleRow(w, bottle), w.clock.now())).toEqual([
      {
        startsAt: new Date(storm.startsAt).toISOString(),
        endsAt: new Date(roll!.cancelledAt!).toISOString(),
      },
    ]);
    // Past the midpoint and through Los Angeles' night: no decision, and no replacement roll
    // inside 24 hours of the consumed one.
    for (let at = storm.decisionAt; at < predicted.rolledAt + DAY - 1; at += HOUR) tick(w, at);
    expect(decisionsOf(w, bottle)).toEqual([]);
    expect(rollsOf(w, id)).toHaveLength(1);
  });

  it('a zone whose morning comes before the midpoint cancels it at the worker too', () => {
    // Dubai is an hour ahead of Jerusalem in September: at 05:xx Jerusalem it is still night in
    // Dubai, but Dubai's morning (07:00, 06:00 in Jerusalem) comes first. An account whose first
    // storm straddles 06:00 Jerusalem shows the case: a night-to-night change, then morning.
    const DUBAI = 'Asia/Dubai';
    const sixAm = Date.parse('2026-09-07T03:00:00.000Z');
    const id = accountId(
      'storm',
      '_late',
      (r) => r.storm!.startsAt + 60_000 < sixAm && r.storm!.decisionAt > sixAm,
    );
    const w = world();
    sailor(w, id);
    const bottle = send(w, id);
    const storm = firstRoll(id).storm!;
    const at = storm.startsAt + 60_000;
    w.clock.set(at);
    expect(phaseAt(at, DUBAI)).toBe('night');
    const changes: ZoneChange[] = [
      { zone: ZONE, effectiveAt: T0 },
      { zone: DUBAI, effectiveAt: at },
    ];
    expect(firstDaytime(changes, at, storm.decisionAt)).toBe(sixAm);
    setAccountTimeZone(w.ctx, w.user(id), DUBAI);
    expect(rollsOf(w, id)[0]!.cancelledAt).toBeNull();
    tick(w, storm.decisionAt + 60_000);
    expect(rollsOf(w, id)[0]!.cancelReason).toBe('daytime');
    expect(decisionsOf(w, bottle)).toEqual([]);
  });
});

// ---------- decisions ----------

describe('midpoint decisions', () => {
  it('one visible storm, an independent decision for every eligible bottle, taken once', () => {
    const id = accountId('storm', '_multi');
    const rolledAt = firstRoll(id).rolledAt;
    const w = world();
    sailor(w, id);
    const losing = bottleId(rolledAt, true);
    const keeping = [bottleId(rolledAt, false, 'a'), bottleId(rolledAt, false, 'b')];
    for (const b of [losing, ...keeping]) bottleIds.pinned.push(b);
    const ids = [send(w, id), send(w, id), send(w, id)];
    expect(ids).toEqual([losing, ...keeping]);
    const storm = rollsOf(w, id)[0] ?? null;
    expect(storm).toBeNull(); // no roll yet in daytime
    tick(w, DUSK + 30 * 60_000);
    const roll = rollsOf(w, id)[0]!;
    w.clock.set(roll.stormStartsAt! + 60_000);
    // One storm on the account's map; every bottle card shows the same window.
    const windows = ids.map((b) => stormWindowsFor(w.ctx, bottleRow(w, b), w.clock.now()));
    expect(windows[0]).toHaveLength(1);
    expect(windows[1]).toEqual(windows[0]);
    expect(windows[2]).toEqual(windows[0]);
    // The midpoint: three decisions in one commit, each from the bottle's own draws.
    tick(w, roll.decisionAt! + 60_000);
    tick(w, roll.decisionAt! + 2 * 60_000); // a retry
    decideDueStorms(w.ctx, w.db, id, w.clock.now()); // and another
    for (const b of ids) {
      const d = decisionsOf(w, b);
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({
        nightKey: roll.id,
        decisionAt: roll.decisionAt,
        eligible: true,
      });
    }
    expect(decisionsOf(w, losing)[0]!.lost).toBe(true);
    expect(bottleRow(w, losing).state).toBe('lost');
    for (const b of keeping) {
      expect(decisionsOf(w, b)[0]!.lost).toBe(false);
      expect(bottleRow(w, b).state).toBe('at_sea');
    }
    expect(rollsOf(w, id)[0]!.decidedAt).not.toBeNull();
    // The unique index backs this up: a second decision for the same storm cannot be written.
    expect(() =>
      w.db
        .insert(t.riskDecisions)
        .values({ ...decisionsOf(w, keeping[0]!)[0]!, id: 'rsk_dup' })
        .run(),
    ).toThrow();
  });

  it('a completed decision survives every later time-zone change', () => {
    const id = accountId('storm', '_keep');
    const w = world();
    sailor(w, id);
    const bottle = send(w, id);
    const storm = firstRoll(id).storm!;
    tick(w, storm.decisionAt + 60_000);
    const before = decisionsOf(w, bottle);
    const state = bottleRow(w, bottle).state;
    expect(before).toHaveLength(1);
    for (const z of ['America/Los_Angeles', 'Asia/Tokyo', 'Europe/London', ZONE]) {
      w.clock.advance(10 * 60_000);
      setAccountTimeZone(w.ctx, w.user(id), z);
      runJourneyTick(w.ctx);
    }
    expect(decisionsOf(w, bottle)).toEqual(before);
    expect(bottleRow(w, bottle).state).toBe(state);
    expect(rollsOf(w, id)[0]!.cancelledAt).toBeNull();
  });

  it('a midpoint already passed on server time is decided under the old clock before a change', () => {
    const id = accountId('storm', '_race');
    const w = world();
    sailor(w, id);
    const bottle = send(w, id);
    const storm = firstRoll(id).storm!;
    tick(w, storm.startsAt + 60_000);
    // The worker has not run since the midpoint; the device changes zone just after it.
    w.clock.set(storm.decisionAt + 1000);
    setAccountTimeZone(w.ctx, w.user(id), 'America/Los_Angeles');
    expect(decisionsOf(w, bottle)).toHaveLength(1);
    expect(rollsOf(w, id)[0]).toMatchObject({ cancelledAt: null });
    expect(rollsOf(w, id)[0]!.decidedAt).not.toBeNull();
  });

  it('keeps the five-decision limit, the 80% cutoff and arrival first', () => {
    const w = world();
    const id = accountId('storm', '_limits');
    sailor(w, id);
    const rolls = predictRolls(id, [{ zone: ZONE, effectiveAt: T0 }], T0, T0 + 150 * DAY).filter(
      (r) => r.storm,
    );
    // Five eligible decisions already on record (from any policy): the sixth is scenery.
    const capped = send(w, id);
    for (let i = 0; i < 5; i++)
      w.db
        .insert(t.riskDecisions)
        .values({
          id: `rsk_prior_${i}`,
          bottleId: capped,
          nightKey: `2026-08-0${i + 1}`,
          policyVersion: 3,
          decisionAt: T0 - (i + 1) * DAY,
          eligible: true,
          lost: false,
          createdAt: T0,
        })
        .run();
    tick(w, rolls[0]!.storm!.decisionAt + 60_000);
    const sixth = decisionsOf(w, capped).filter((d) => d.policyVersion === RISK_POLICY_VERSION);
    expect(sixth).toEqual([expect.objectContaining({ eligible: false, lost: false })]);

    // 80%: a bottle released so that a storm's midpoint falls at 85% of its journey. (Every
    // journey on this route takes the same time; a probe with no policy measures it.)
    const probe = send(w, id);
    const duration = activePlan(w.db, probe)!.plannedDurationMs;
    w.db.update(t.bottles).set({ riskPolicyVersion: null }).where(eq(t.bottles.id, probe)).run();
    const late = rolls.find((r) => r.storm!.decisionAt > w.clock.now() + duration + DAY)!;
    const releaseAt = late.storm!.decisionAt - Math.round(0.85 * duration);
    expect(releaseAt).toBeGreaterThan(w.clock.now());
    tick(w, releaseAt);
    const eighty = send(w, id);
    const plan = activePlan(w.db, eighty)!;
    expect(progressAt(plan, late.storm!.decisionAt)).toBeGreaterThanOrEqual(0.8);
    tick(w, late.storm!.decisionAt + 60_000);
    const d = decisionsOf(w, eighty).find((x) => x.decisionAt === late.storm!.decisionAt);
    expect(d).toMatchObject({ eligible: false, lost: false });

    // Arrival first: a bottle planned to arrive a minute before a storm's midpoint, with the
    // worker catching up only after both moments.
    const next = rolls.find((r) => r.storm!.decisionAt > w.clock.now() + duration + DAY)!;
    tick(w, next.storm!.decisionAt - duration - 60_000);
    const racer = send(w, id);
    expect(plannedArrivalAt(activePlan(w.db, racer)!)).toBeLessThan(next.storm!.decisionAt);
    // The worker catches up only after both moments have passed.
    tick(w, next.storm!.decisionAt + HOUR);
    expect(bottleRow(w, racer).state).toBe('delivered');
    expect(decisionsOf(w, racer).every((x) => !x.lost)).toBe(true);
  });

  it('catches up after downtime with exactly the rolls and decisions of a worker that never stopped', () => {
    const id = accountId('storm', '_down');
    const run = (step: number) => {
      bottleIds.next = 0;
      keyN = 0;
      const w = world();
      sailor(w, id);
      const bottles = [send(w, id), send(w, id)];
      w.clock.advance(3 * DAY);
      bottles.push(send(w, id));
      const end = T0 + 18 * DAY;
      for (let at = w.clock.now() + step; at < end; at += step) tick(w, at);
      tick(w, end);
      return {
        rolls: shapeOfRolls(w, id),
        decisions: bottles.map((b) =>
          decisionsOf(w, b).map(({ id: _i, createdAt: _c, nightKey: _n, ...d }) => d),
        ),
        states: bottles.map((b) => bottleRow(w, b).state),
      };
    };
    const live = run(HOUR);
    const afterOutage = run(15 * DAY);
    expect(live.rolls.length).toBeGreaterThan(10);
    // Identical decisions and outcomes. Rolls are persisted when needed, so one run may have
    // written a few more of the same sequence; every roll both have is identical.
    expect(afterOutage.decisions).toEqual(live.decisions);
    expect(afterOutage.states).toEqual(live.states);
    const shared = Math.min(live.rolls.length, afterOutage.rolls.length);
    expect(shared).toBeGreaterThan(10);
    expect(afterOutage.rolls.slice(0, shared)).toEqual(live.rolls.slice(0, shared));
  });
});

// ---------- what a zone change never touches ----------

describe('a time-zone change moves the map clock and nothing else', () => {
  it('never changes a journey release, route, duration, arrival or recorded timestamps', () => {
    const id = accountId('calm', '_journey');
    const w = world();
    sailor(w, id);
    const bottle = send(w, id);
    const snapshot = () => ({
      bottle: bottleRow(w, bottle),
      plan: activePlan(w.db, bottle),
      events: w.db.select().from(t.journeyEvents).where(eq(t.journeyEvents.bottleId, bottle)).all(),
      notifications: w.db.select().from(t.notifications).all(),
    });
    const before = snapshot();
    for (const z of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Europe/London', ZONE]) {
      w.clock.advance(HOUR);
      setAccountTimeZone(w.ctx, w.user(id), z);
    }
    expect(snapshot()).toEqual(before);
  });

  it('never changes appeal, suspension or rate-limit deadlines', async () => {
    const w = createTestWorld({ riskPolicyVersion: 0, defaultShoreCapacity: 40 });
    const app = createApp(w.ctx);
    // Forgot-password budget (per address): spend it, change zone, still spent.
    const forgot = () =>
      app.request('/api/auth/password/forgot', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
        body: JSON.stringify({ email: 'nobody@example.test' }),
      });
    // Three a day per address of mail: the fourth is refused.
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await forgot()).status);
    expect(codes).toEqual([202, 202, 202]);
    expect((await forgot()).status).toBe(429);
    setAccountTimeZone(w.ctx, w.user('ada'), 'Pacific/Kiritimati');
    expect((await forgot()).status).toBe(429);
    // Two upheld violations: a suspension with an end, each with a 30-day appeal deadline.
    w.db
      .update(t.users)
      .set({ role: 'admin' })
      .where(eq(t.users.id, w.user('cy').id))
      .run();
    for (let i = 0; i < 2; i++) {
      const b = releaseBottle(w.ctx, w.user('ada'), releaseInput(w.user('bo').id, key())).bottleId;
      w.clock.advance(60 * DAY);
      w.realClock.advance(DAY);
      runJourneyTick(w.ctx);
      openBottle(w.ctx, w.user('bo'), b);
      const caseId = reportLetter(w.ctx, w.user('bo'), {
        bottleId: b,
        reason: 'harassment',
        hide: false,
      }).caseId;
      decideCase(w.ctx, w.user('cy'), caseId, 'accepted', 'Harassment.', evidenceDigest(w, caseId));
    }
    const ada = w.user('ada');
    const deadlines = () => {
      const s = accountStanding(w.ctx, ada.id);
      return {
        standing: s.standing,
        until: s.suspendedUntil,
        appeals: s.violations.map((v) => v.appealDeadlineAt),
      };
    };
    const before = deadlines();
    expect(before.standing).toBe('suspended');
    expect(before.appeals).toHaveLength(2);
    for (const z of ['America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Tokyo']) {
      setAccountTimeZone(w.ctx, ada, z);
      expect(deadlines()).toEqual(before);
    }
  });
});

// ---------- earlier policies and restarts ----------

describe('journeys from earlier policies, restarts and migrations', () => {
  it('keeps every past decision and outcome of an earlier-policy journey; only new storms decide', () => {
    const id = accountId('storm', '_legacy');
    const w = world();
    sailor(w, id);
    const legacy = send(w, id);
    const unversioned = send(w, id);
    w.db.update(t.bottles).set({ riskPolicyVersion: 3 }).where(eq(t.bottles.id, legacy)).run();
    w.db
      .update(t.bottles)
      .set({ riskPolicyVersion: null })
      .where(eq(t.bottles.id, unversioned))
      .run();
    const past = {
      id: 'rsk_v3_past',
      bottleId: legacy,
      nightKey: '2026-09-05',
      policyVersion: 3,
      stormStartsAt: T0 - 20 * HOUR,
      stormEndsAt: T0 - 19 * HOUR,
      decisionAt: T0 - 19.5 * HOUR,
      eligible: true,
      lost: false,
      reason: null,
      createdAt: T0 - 19 * HOUR,
    };
    w.db.insert(t.riskDecisions).values(past).run();
    const storm = firstRoll(id).storm!;
    tick(w, storm.decisionAt + 60_000);
    const rows = decisionsOf(w, legacy);
    expect(rows.find((r) => r.id === past.id)).toEqual(past);
    expect(rows.filter((r) => r.policyVersion === 4)).toHaveLength(1);
    expect(bottleRow(w, legacy).riskPolicyVersion).toBe(3);
    expect(decisionsOf(w, unversioned)).toEqual([]);
  });

  it('a restart or a re-run of the migrations never duplicates a roll or a decision', () => {
    const id = accountId('storm', '_restart');
    const w = world();
    sailor(w, id);
    const bottle = send(w, id);
    const storm = firstRoll(id).storm!;
    tick(w, storm.decisionAt + 60_000);
    const rolls = rollsOf(w, id);
    const decisions = decisionsOf(w, bottle);
    runMigrations(w.db); // already applied: a no-op
    const restarted = { ...w.ctx };
    processRiskDecisions(restarted, w.clock.now());
    accountWeather(restarted, id);
    expect(rollsOf(w, id)).toEqual(rolls);
    expect(decisionsOf(w, bottle)).toEqual(decisions);
    const activations = w.db.select().from(t.riskPolicyActivations).all();
    expect(activations).toEqual([{ version: 4, activatedAt: T0 }]);
  });
});
