import { describe, expect, it } from 'vitest';
import {
  RISK_POLICY,
  RISK_POLICY_VERSION,
  decideRisk,
  instantOfLocal,
  localParts,
  nightRuleOf,
  nightWindow,
  nightsOverlapping,
  seaNightWindow,
  seaNightsOverlapping,
  solarOffsetMs,
  solarPhaseAt,
  stormForNight,
  utcDayKey,
  type StormNight,
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

describe('storm nights are stable, independent and correctly distributed', () => {
  const nights = Array.from({ length: 40 }, (_, i) =>
    nightWindow(`2026-11-${String((i % 28) + 1).padStart(2, '0')}`, ZONE),
  );

  it('always yields the identical storm for the same bottle and night', () => {
    const n = nightWindow(day(10), ZONE);
    const a = stormForNight('btl_stable', n);
    for (let i = 0; i < 20; i++) expect(stormForNight('btl_stable', n)).toEqual(a);
    // A new policy version reshuffles: over a month the two versions cannot agree everywhere.
    const v1 = nights.map((w) => stormForNight('btl_stable', w, 1));
    const v2 = nights.map((w) => stormForNight('btl_stable', w, 2));
    expect(v1).not.toEqual(v2);
  });

  it('storms ~25% of nights, each 40–100 minutes inside the night, decision at the midpoint', () => {
    let storms = 0;
    let total = 0;
    for (let b = 0; b < 500; b++) {
      for (const n of nights) {
        total++;
        const s = stormForNight(`btl_${b}`, n);
        if (!s) continue;
        storms++;
        expect(s.startsAt).toBeGreaterThanOrEqual(n.startsAt);
        expect(s.endsAt).toBeLessThanOrEqual(n.endsAt);
        expect(s.endsAt - s.startsAt).toBeGreaterThanOrEqual(RISK_POLICY.stormMinMs);
        expect(s.endsAt - s.startsAt).toBeLessThanOrEqual(RISK_POLICY.stormMaxMs);
        expect(Math.abs(s.decisionAt - (s.startsAt + s.endsAt) / 2)).toBeLessThanOrEqual(1);
      }
    }
    const rate = storms / total;
    expect(rate).toBeGreaterThan(0.23);
    expect(rate).toBeLessThan(0.27);
  });

  it('gives two bottles independent nights', () => {
    const a = nights.map((n) => Boolean(stormForNight('btl_a', n)));
    const b = nights.map((n) => Boolean(stormForNight('btl_b', n)));
    expect(a).not.toEqual(b);
  });

  it('loses about 1% of eligible decisions, adrift 75% / sunk 25% of those', () => {
    let eligible = 0;
    let lost = 0;
    let adrift = 0;
    for (let b = 0; b < 20000; b++) {
      for (const n of nights) {
        const storm = stormForNight(`btl_${b}`, n);
        if (!storm) continue;
        const d = decideRisk({
          storm,
          progressAtDecision: 0.3,
          arrivalAt: Number.MAX_SAFE_INTEGER,
          priorEligibleDecisions: 0,
        });
        eligible++;
        if (d.lost) {
          lost++;
          if (d.reason === 'adrift') adrift++;
        }
      }
    }
    // A big enough sample that the bands below are many standard deviations wide.
    expect(eligible).toBeGreaterThan(150000);
    expect(lost).toBeGreaterThan(1000);
    const lossRate = lost / eligible;
    expect(lossRate).toBeGreaterThan(0.007);
    expect(lossRate).toBeLessThan(0.013);
    const adriftShare = adrift / lost;
    expect(adriftShare).toBeGreaterThan(0.68);
    expect(adriftShare).toBeLessThan(0.82);
  });

  it('enforces the hard limits: 80% cutoff, arrival first, and only five risky decisions', () => {
    const storm: StormNight = {
      key: day(1),
      startsAt: 0,
      endsAt: 60,
      decisionAt: 30,
      lossDraw: 0, // would always lose
      reasonDraw: 0,
    };
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
    expect(RISK_POLICY_VERSION).toBe(2);
    expect(1 - Math.pow(1 - RISK_POLICY.lossChance, RISK_POLICY.maxRiskDecisions)).toBeCloseTo(
      0.049,
      3,
    );
  });
});

describe('the sea night: 19:00–07:00 where the bottle is', () => {
  const HOUR = 60 * 60 * 1000;
  const hourAt = (ms: number, offsetMs: number) =>
    new Date(ms + offsetMs).getUTCHours() + new Date(ms + offsetMs).getUTCMinutes() / 60;

  it('is the same twelve hours at every meridian, with no zone and no daylight saving', () => {
    // 2026-03-29 and 2026-10-25 are European clock changes; 2026-11-01 is the American one.
    for (const key of ['2026-03-29', '2026-10-25', '2026-11-01', '2026-06-15']) {
      for (const lng of [0, 45, -73, 179.5, -179.5, 135]) {
        const offset = solarOffsetMs(lng);
        const w = seaNightWindow(key, offset);
        expect(w.endsAt - w.startsAt).toBe(12 * HOUR);
        expect(hourAt(w.startsAt, offset)).toBeCloseTo(19, 6);
        expect(hourAt(w.endsAt, offset)).toBeCloseTo(7, 6);
      }
    }
    // The zone rule it replaces loses or gains an hour on exactly those dates.
    expect(
      nightWindow('2026-10-24', 'Asia/Jerusalem').endsAt -
        nightWindow('2026-10-24', 'Asia/Jerusalem').startsAt,
    ).toBe(13 * HOUR);
  });

  it('turns longitude into solar time, wrapping the antimeridian', () => {
    expect(solarOffsetMs(0)).toBe(0);
    expect(solarOffsetMs(15)).toBe(HOUR);
    expect(solarOffsetMs(-15)).toBe(-HOUR);
    expect(solarOffsetMs(180)).toBe(-12 * HOUR); // 180 normalises to -180
    expect(solarOffsetMs(181)).toBe(solarOffsetMs(-179));
    expect(solarOffsetMs(540)).toBe(solarOffsetMs(180));
    for (const lng of [-360, -181, -1, 0, 1, 181, 360, 725]) {
      expect(Math.abs(solarOffsetMs(lng))).toBeLessThanOrEqual(12 * HOUR);
    }
  });

  it('agrees with the phase a client reads for the same instant', () => {
    const offset = solarOffsetMs(-140); // mid-Pacific
    const w = seaNightWindow('2026-09-16', offset);
    for (const at of [w.startsAt, w.startsAt + HOUR, w.endsAt - 1]) {
      expect(solarPhaseAt(at, offset)).toBe('night');
    }
    for (const at of [w.startsAt - 1, w.endsAt, w.endsAt + 6 * HOUR]) {
      expect(solarPhaseAt(at, offset)).toBe('day');
    }
  });

  it('gives a drifting bottle one night per date, in order and never overlapping', () => {
    const from = Date.parse('2026-09-16T00:00:00.000Z');
    const to = from + 5 * 24 * HOUR;
    // A bottle running 30° west a day, from Gibraltar out into the Atlantic.
    const offsetForKey = (key: string) => {
      const day = Math.round((Date.parse(`${key}T00:00:00.000Z`) - from) / (24 * HOUR));
      return solarOffsetMs(-5 - 30 * day);
    };
    const nights = seaNightsOverlapping(from, to, offsetForKey);
    expect(nights.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < nights.length; i++) {
      // Consecutive dates, in order, and one night is over before the next begins.
      expect(Date.parse(`${nights[i]!.key}T00:00:00.000Z`)).toBe(
        Date.parse(`${nights[i - 1]!.key}T00:00:00.000Z`) + 24 * HOUR,
      );
      expect(nights[i]!.startsAt).toBeGreaterThan(nights[i - 1]!.endsAt);
    }
    // Every night it returns overlaps the span — and no night it leaves out does.
    const keys = new Set(nights.map((n) => n.key));
    for (const n of nights) expect(n.endsAt > from && n.startsAt <= to).toBe(true);
    for (let d = -4; d <= 9; d++) {
      const key = utcDayKey(from + d * 24 * HOUR);
      const w = seaNightWindow(key, offsetForKey(key));
      expect(keys.has(key)).toBe(w.endsAt > from && w.startsAt <= to);
    }
    const inside = seaNightsOverlapping(
      nights[2]!.startsAt + HOUR,
      nights[2]!.startsAt + 2 * HOUR,
      offsetForKey,
    );
    expect(inside.map((n) => n.key)).toEqual([nights[2]!.key]);
  });

  it('keys a night by its own UTC date and stays stable whoever asks', () => {
    expect(utcDayKey(Date.parse('2026-09-16T23:59:59.999Z'))).toBe('2026-09-16');
    expect(utcDayKey(Date.parse('2026-09-17T00:00:00.000Z'))).toBe('2026-09-17');
    const offset = solarOffsetMs(12.5);
    const a = seaNightWindow('2026-09-16', offset);
    for (let i = 0; i < 20; i++) expect(seaNightWindow('2026-09-16', offset)).toEqual(a);
  });

  it('is the rule from policy v2 on; v1 journeys keep their zone nights', () => {
    expect(nightRuleOf(1)).toBe('zone');
    expect(nightRuleOf(2)).toBe('sea');
    expect(nightRuleOf(RISK_POLICY_VERSION)).toBe('sea');
  });

  it('never decides anything outside the storm a watcher can see', () => {
    // The invariant the whole rule exists for: the decision moment of every storm on every
    // meridian falls inside that storm's own window.
    let checked = 0;
    for (let b = 0; b < 300; b++) {
      for (const lng of [0, -140, 100, 179]) {
        const night = seaNightWindow(
          `2026-09-${String((b % 28) + 1).padStart(2, '0')}`,
          solarOffsetMs(lng),
        );
        const storm = stormForNight(`btl_${b}_${lng}`, night, RISK_POLICY_VERSION);
        if (!storm) continue;
        checked++;
        expect(storm.decisionAt).toBeGreaterThanOrEqual(storm.startsAt);
        expect(storm.decisionAt).toBeLessThan(storm.endsAt);
        expect(storm.startsAt).toBeGreaterThanOrEqual(night.startsAt);
        expect(storm.endsAt).toBeLessThanOrEqual(night.endsAt);
        expect(solarPhaseAt(storm.decisionAt, solarOffsetMs(lng))).toBe('night');
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});
