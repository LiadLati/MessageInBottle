import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as t from '../db/schema.js';
import { setUserShore } from '../services/chart.js';
import { activePlan } from '../services/journey.js';
import { previewRelease, releaseBottle } from '../services/release.js';
import { createTestWorld, releaseInput } from '../test/harness.js';
import { journeyDurationMs } from './routing.js';

const HOUR = 60 * 60 * 1000;

// Audit QA-016: travel time is a function of distance and of the two operator knobs
// (MIB_MS_PER_CHART_UNIT, MIB_MIN_JOURNEY_MS). Every other test only reads the planned duration
// back; these assert what it is.
describe('journeyDurationMs: distance-based travel time', () => {
  it('a longer route takes longer', () => {
    expect(journeyDurationMs(80, HOUR, 0)).toBeGreaterThan(journeyDurationMs(40, HOUR, 0));
    expect(journeyDurationMs(40, HOUR, 0)).toBe(40 * HOUR);
  });

  it('scales linearly with msPerChartUnit', () => {
    expect(journeyDurationMs(50, 2 * HOUR, 0)).toBe(2 * journeyDurationMs(50, HOUR, 0));
    expect(journeyDurationMs(50, 1000, 0)).toBe(50_000);
    // Fractional products are rounded to whole milliseconds.
    expect(journeyDurationMs(3, 0.5, 0)).toBe(2);
  });

  it('never plans less than minJourneyMs, and the floor does not stretch longer routes', () => {
    expect(journeyDurationMs(1, HOUR, 6 * HOUR)).toBe(6 * HOUR);
    expect(journeyDurationMs(0, HOUR, 6 * HOUR)).toBe(6 * HOUR);
    expect(journeyDurationMs(10, HOUR, 6 * HOUR)).toBe(10 * HOUR);
    expect(journeyDurationMs(6, HOUR, 6 * HOUR)).toBe(6 * HOUR);
  });
});

describe('planned duration on the real sea graph', () => {
  it('plans Tokyo -> Yokohama shorter than Southampton -> Yokohama, from the route length', () => {
    // A 1 ms floor so the minimum journey cannot mask the difference.
    const w = createTestWorld({ minJourneyMs: 1, defaultShoreCapacity: 20 });
    const [ada, bo, cy] = [w.user('ada'), w.user('bo'), w.user('cy')];
    setUserShore(w.ctx, ada.id, 'shore_jp_tokyo');
    setUserShore(w.ctx, bo.id, 'shore_jp_yokohama');
    setUserShore(w.ctx, cy.id, 'shore_gb_southampton');

    const near = previewRelease(w.ctx, ada, bo.id).route!;
    const far = previewRelease(w.ctx, cy, bo.id).route!;
    expect(near.totalLength).toBeLessThan(far.totalLength);
    expect(near.plannedDurationMs).toBeLessThan(far.plannedDurationMs);
    for (const r of [near, far])
      expect(r.plannedDurationMs).toBe(
        journeyDurationMs(r.totalLength, w.ctx.config.msPerChartUnit, 1),
      );

    // And the persisted plan of an actual release is the same number.
    const nearId = releaseBottle(w.ctx, ada, releaseInput(bo.id, 'dur-key-00000001')).bottleId;
    const farId = releaseBottle(w.ctx, cy, releaseInput(bo.id, 'dur-key-00000002')).bottleId;
    const nearPlan = activePlan(w.db, nearId)!;
    const farPlan = activePlan(w.db, farId)!;
    expect(nearPlan.plannedDurationMs).toBe(near.plannedDurationMs);
    expect(farPlan.plannedDurationMs).toBe(far.plannedDurationMs);
    expect(nearPlan.plannedDurationMs).toBeLessThan(farPlan.plannedDurationMs);
    expect(w.db.select().from(t.bottles).where(eq(t.bottles.id, nearId)).get()!.state).toBe(
      'at_sea',
    );
  });
});
