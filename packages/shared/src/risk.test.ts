import { describe, expect, it } from 'vitest';
import {
  RISK_POLICY,
  RISK_POLICY_VERSION,
  decideRisk,
  instantOfLocal,
  localParts,
  nightWindow,
  nightsOverlapping,
  bottleRiskDraws,
  firstDaytime,
  nextRollSlot,
  phaseAt,
  rollAccountStorm,
  type ZoneChange,
} from './weather.js';

const ZONE = 'Asia/Jerusalem';
const day = (n: number) => `2026-10-${String(n).padStart(2, '0')}`;

describe('nights in a zone', () => {
  it('runs from 19:00 local to 07:00 the next morning, DST included', () => {
    const w = nightWindow('2026-10-24', ZONE); // Israel leaves DST on 2026-10-25 02:00
    expect(localParts(w.startsAt, ZONE)).toMatchObject({ day: 24, hour: 19, minute: 0 });
    expect(localParts(w.endsAt, ZONE)).toMatchObject({ day: 25, hour: 7, minute: 0 });
    expect(w.endsAt - w.startsAt).toBe(13 * 60 * 60 * 1000); // the clock went back an hour
    const utc = nightWindow('2026-10-24', 'UTC');
    expect(utc.endsAt - utc.startsAt).toBe(12 * 60 * 60 * 1000);
  });

  it('instantOfLocal round-trips through localParts', () => {
    for (const [y, m, d, h] of [
      [2026, 1, 5, 19],
      [2026, 7, 5, 7],
      [2026, 3, 27, 3],
    ] as const) {
      const at = instantOfLocal(y, m, d, h, ZONE);
      expect(localParts(at, ZONE)).toMatchObject({ year: y, month: m, day: d, hour: h });
    }
  });

  it('lists exactly the nights overlapping a span, in order', () => {
    const from = instantOfLocal(2026, 10, 3, 12, ZONE); // noon
    const to = instantOfLocal(2026, 10, 6, 12, ZONE);
    const keys = nightsOverlapping(from, to, ZONE).map((n) => n.key);
    expect(keys).toEqual([day(3), day(4), day(5)]);
    // A span inside one night that started the previous evening.
    const dawn = instantOfLocal(2026, 10, 4, 2, ZONE);
    expect(nightsOverlapping(dawn, dawn + 60_000, ZONE).map((n) => n.key)).toEqual([day(3)]);
  });
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const jerusalem: ZoneChange[] = [{ zone: ZONE, effectiveAt: 0 }];

// Walks the account's rolls from `from` (the clock's start) to `to` exactly as the server does:
// each roll at a night entry no sooner than 24 hours after the previous one.
function rollsBetween(userId: string, changes: ZoneChange[], from: number, to: number) {
  const out = [];
  let notBefore = from;
  for (;;) {
    const slot = nextRollSlot(changes, notBefore, to, from);
    if (!slot) return out;
    out.push(rollAccountStorm(userId, slot));
    notBefore = slot.rolledAt + RISK_POLICY.rollSpacingMs;
  }
}

describe('account storms on the map clock (policy v4)', () => {
  const from = instantOfLocal(2026, 11, 1, 12, ZONE);
  const to = from + 60 * DAY;

  it('rolls once per night at nightfall, never in daytime, and never twice in 24 hours', () => {
    const rolls = rollsBetween('usr_a', jerusalem, from, to);
    expect(rolls).toHaveLength(60);
    for (const [i, r] of rolls.entries()) {
      expect(phaseAt(r.rolledAt, ZONE)).toBe('night');
      expect(localParts(r.rolledAt, ZONE)).toMatchObject({ hour: 19, minute: 0 });
      if (i > 0) expect(r.rolledAt - rolls[i - 1]!.rolledAt).toBeGreaterThanOrEqual(DAY);
    }
    // Daytime alone offers no slot at all.
    const noon = instantOfLocal(2026, 11, 3, 8, ZONE);
    expect(nextRollSlot(jerusalem, noon, noon + 10 * HOUR, noon)).toBeNull();
  });

  it('is deterministic: the same account and inputs always give the same calm or storm', () => {
    const a = rollsBetween('usr_stable', jerusalem, from, to);
    for (let i = 0; i < 5; i++) expect(rollsBetween('usr_stable', jerusalem, from, to)).toEqual(a);
    // Another account rolls independently.
    const b = rollsBetween('usr_other', jerusalem, from, to);
    expect(a.map((r) => r.storm !== null)).not.toEqual(b.map((r) => r.storm !== null));
  });

  it('storms ~25% of nights, 40–100 minutes, wholly inside the displayed night, decision at the midpoint', () => {
    let storms = 0;
    let total = 0;
    for (let u = 0; u < 300; u++) {
      for (const r of rollsBetween(`usr_${u}`, jerusalem, from, to)) {
        total++;
        if (!r.storm) continue;
        storms++;
        const s = r.storm;
        expect(s.startsAt).toBeGreaterThanOrEqual(r.rolledAt);
        expect(s.startsAt).toBeGreaterThanOrEqual(r.night.startsAt);
        expect(s.endsAt).toBeLessThanOrEqual(r.night.endsAt);
        expect(s.endsAt - s.startsAt).toBeGreaterThanOrEqual(RISK_POLICY.stormMinMs - 1);
        expect(s.endsAt - s.startsAt).toBeLessThanOrEqual(RISK_POLICY.stormMaxMs + 1);
        expect(Math.abs(s.decisionAt - (s.startsAt + s.endsAt) / 2)).toBeLessThanOrEqual(1);
        // Night on the map for the whole storm.
        expect(firstDaytime(jerusalem, s.startsAt, s.endsAt - 1)).toBeNull();
      }
    }
    const rate = storms / total;
    expect(total).toBe(300 * 60);
    expect(rate).toBeGreaterThan(0.23);
    expect(rate).toBeLessThan(0.27);
  });

  it('a local date boundary or a zone change inside 24 hours never adds a roll', () => {
    // Jerusalem at 19:00, then the device reports New York at 03:00 Jerusalem time (20:00 in
    // New York, a fresh evening there): same 24 hours, so no second roll that night.
    const evening = instantOfLocal(2026, 11, 5, 19, ZONE);
    const moved: ZoneChange[] = [
      ...jerusalem,
      { zone: 'America/New_York', effectiveAt: evening + 8 * HOUR },
    ];
    const rolls = rollsBetween('usr_x', moved, evening - HOUR, evening + 3 * DAY);
    for (let i = 1; i < rolls.length; i++)
      expect(rolls[i]!.rolledAt - rolls[i - 1]!.rolledAt).toBeGreaterThanOrEqual(DAY);
    expect(rolls[0]!.rolledAt).toBe(evening);
    expect(rolls[1]!.rolledAt).toBeGreaterThanOrEqual(evening + DAY);
    // Crossing midnight into a new local date within the same night adds nothing either.
    const oneNight = rollsBetween('usr_x', jerusalem, evening, evening + 11 * HOUR);
    expect(oneNight).toHaveLength(1);
  });

  it('one late entry never drags later rolls away from dusk', () => {
    // The clock starts at 03:00 Jerusalem on 5 Nov, mid-night: that counts as entering it.
    const midNight = instantOfLocal(2026, 11, 5, 3, ZONE);
    const rolls = rollsBetween('usr_drift', jerusalem, midNight, midNight + 6 * DAY);
    expect(rolls[0]!.rolledAt).toBe(midNight);
    // Dusk that evening is only 16 hours later: no roll. From the next dusk on, every roll is
    // at 19:00 again.
    expect(localParts(rolls[1]!.rolledAt, ZONE)).toMatchObject({ day: 6, hour: 19 });
    for (const r of rolls.slice(1))
      expect(localParts(r.rolledAt, ZONE)).toMatchObject({ hour: 19 });
  });

  it('a zone change that turns a daytime map to night is an entry, 24 hours after the last roll', () => {
    // Rolled at dusk in Jerusalem (17:00Z on 5 Nov). The next afternoon (15:00Z, 17:00 there,
    // before dusk) the device reports Los Angeles, 07:00 — still day. At 18:00Z, 25 hours after
    // the roll, it reports Tokyo, where it is 03:00: the map enters a night right then.
    const dusk = Date.parse('2026-11-05T17:00:00.000Z');
    const toLa = Date.parse('2026-11-06T15:00:00.000Z');
    const toTokyo = Date.parse('2026-11-06T18:00:00.000Z');
    const changes: ZoneChange[] = [
      { zone: ZONE, effectiveAt: 0 },
      { zone: 'America/Los_Angeles', effectiveAt: toLa },
      { zone: 'Asia/Tokyo', effectiveAt: toTokyo },
    ];
    const rolls = rollsBetween('usr_entry', changes, dusk - HOUR, toTokyo + HOUR);
    expect(rolls.map((r) => r.rolledAt)).toEqual([dusk, toTokyo]);
    expect(rolls[1]!.zone).toBe('Asia/Tokyo');
    // Reporting Tokyo only 20 hours after the roll would have given that night no roll at all.
    const early = changes.map((c) =>
      c.zone === 'Asia/Tokyo' ? { ...c, effectiveAt: dusk + 20 * HOUR } : c,
    );
    early[1] = { zone: 'America/Los_Angeles', effectiveAt: dusk + 19 * HOUR };
    expect(rollsBetween('usr_entry', early, dusk - HOUR, dusk + 21 * HOUR)).toHaveLength(1);
  });

  it('finds the first daytime moment across zone changes', () => {
    const night = instantOfLocal(2026, 11, 5, 22, ZONE);
    expect(firstDaytime(jerusalem, night, night + HOUR)).toBeNull();
    // At 23:00 Jerusalem the device reports Tokyo, where it is 06:00 and day comes at 07:00.
    const toTokyo: ZoneChange[] = [...jerusalem, { zone: 'Asia/Tokyo', effectiveAt: night + HOUR }];
    expect(firstDaytime(toTokyo, night, night + 3 * HOUR)).toBe(night + 2 * HOUR);
    // To Los Angeles, where 23:00 Jerusalem is 13:00: day at once.
    const toLa: ZoneChange[] = [
      ...jerusalem,
      { zone: 'America/Los_Angeles', effectiveAt: night + HOUR },
    ];
    expect(firstDaytime(toLa, night, night + 3 * HOUR)).toBe(night + HOUR);
  });

  it('gives every bottle its own draws for a storm; about 1% of eligible decisions lose, 75/25', () => {
    expect(bottleRiskDraws('btl_a', 1000)).toEqual(bottleRiskDraws('btl_a', 1000));
    expect(bottleRiskDraws('btl_a', 1000)).not.toEqual(bottleRiskDraws('btl_b', 1000));
    let lost = 0;
    let adrift = 0;
    const n = 400000;
    for (let i = 0; i < n; i++) {
      const d = decideRisk({
        storm: { decisionAt: 10, ...bottleRiskDraws(`btl_${i}`, 12345) },
        progressAtDecision: 0.3,
        arrivalAt: Number.MAX_SAFE_INTEGER,
        priorEligibleDecisions: 0,
      });
      if (d.lost) {
        lost++;
        if (d.reason === 'adrift') adrift++;
      }
    }
    expect(lost / n).toBeGreaterThan(0.008);
    expect(lost / n).toBeLessThan(0.012);
    expect(adrift / lost).toBeGreaterThan(0.7);
    expect(adrift / lost).toBeLessThan(0.8);
  });

  it('enforces the hard limits: 80% cutoff, arrival first, and only five risky decisions', () => {
    const storm = { decisionAt: 30, lossDraw: 0, reasonDraw: 0 }; // would always lose
    const base = { storm, progressAtDecision: 0.5, arrivalAt: 1000, priorEligibleDecisions: 0 };
    expect(decideRisk(base)).toEqual({ eligible: true, lost: true, reason: 'adrift' });
    expect(decideRisk({ ...base, progressAtDecision: 0.8 }).eligible).toBe(false);
    expect(decideRisk({ ...base, progressAtDecision: 0.79 }).eligible).toBe(true);
    expect(decideRisk({ ...base, arrivalAt: 30 }).eligible).toBe(false); // arrival is due
    expect(decideRisk({ ...base, priorEligibleDecisions: 4 }).eligible).toBe(true);
    expect(decideRisk({ ...base, priorEligibleDecisions: 5 }).eligible).toBe(false);
    expect(decideRisk({ ...base, storm: { ...storm, reasonDraw: 0.75 } }).reason).toBe('sunk');
    expect(decideRisk({ ...base, storm: { ...storm, lossDraw: 0.01 } }).lost).toBe(false);
  });

  it('caps the journey loss at 1 − 0.99⁵', () => {
    expect(RISK_POLICY_VERSION).toBe(4);
    expect(1 - Math.pow(1 - RISK_POLICY.lossChance, RISK_POLICY.maxRiskDecisions)).toBeCloseTo(
      0.049,
      3,
    );
  });
});
