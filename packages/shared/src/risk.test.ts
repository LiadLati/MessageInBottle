import { describe, expect, it } from 'vitest';
import {
  RISK_POLICY,
  RISK_POLICY_VERSION,
  decideRisk,
  instantOfLocal,
  localParts,
  nightWindow,
  nightsOverlapping,
  stormForNight,
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
    expect(RISK_POLICY_VERSION).toBe(3);
    expect(1 - Math.pow(1 - RISK_POLICY.lossChance, RISK_POLICY.maxRiskDecisions)).toBeCloseTo(
      0.049,
      3,
    );
  });
});
