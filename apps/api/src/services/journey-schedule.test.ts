import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as t from '../db/schema.js';
import {
  JOURNEY_DURATION_FACTOR,
  journeyDurationMs,
  plannedArrivalAt,
  progressAt,
} from '../domain/routing.js';
import { createApp } from '../http/app.js';
import { setUserShore } from './chart.js';
import { getSentBottle } from './bottles.js';
import { activePlan, runJourneyTick } from './journey.js';
import { previewRelease, releaseBottle } from './release.js';
import { createTestWorld, loginAs, releaseInput } from '../test/harness.js';

// Journeys sail at 70% of the duration the route calculation produces (product decision,
// 2026-09-27). The calculation is untouched; the factor is applied once, when a new journey's
// plan is saved, and everything after reads that saved plan.

const HOUR = 60 * 60 * 1000;

function world() {
  // A 1 ms floor, so the distance-based calculation and not the minimum decides the duration.
  const w = createTestWorld({ minJourneyMs: 1, defaultShoreCapacity: 20 });
  setUserShore(w.ctx, w.user('ada').id, 'shore_gb_southampton');
  setUserShore(w.ctx, w.user('bo').id, 'shore_jp_yokohama');
  return w;
}

describe('a new journey is scheduled at 70% of its calculated duration', () => {
  it('saves 70% of the unchanged calculation, and preview, DTO, progress and arrival agree', () => {
    const w = world();
    const [ada, bo] = [w.user('ada'), w.user('bo')];
    const preview = previewRelease(w.ctx, ada, bo.id).route!;
    const calculated = journeyDurationMs(preview.totalLength, w.ctx.config.msPerChartUnit, 1);
    const scheduled = Math.round(calculated * 0.7);
    expect(JOURNEY_DURATION_FACTOR).toBe(0.7);
    expect(calculated).toBeGreaterThan(24 * HOUR);
    expect(preview.plannedDurationMs).toBe(scheduled);

    const id = releaseBottle(w.ctx, ada, releaseInput(bo.id, 'sched-key-000001')).bottleId;
    const plan = activePlan(w.db, id)!;
    // Same route and length as the preview; only the schedule is shorter.
    expect(plan.totalLength).toBe(preview.totalLength);
    expect(plan.nodeIds).toEqual(preview.nodeIds);
    expect(plan.plannedDurationMs).toBe(scheduled);
    const arrivalAt = plan.startsAt + scheduled;
    expect(plannedArrivalAt(plan)).toBe(arrivalAt);

    // What the sender's app is given: the shortened duration and its arrival time.
    const dto = getSentBottle(w.ctx, ada, id);
    expect(dto.route.plannedDurationMs).toBe(scheduled);
    expect(dto.plannedArrivalAt).toBe(new Date(arrivalAt).toISOString());

    // Halfway through the shortened schedule is halfway along the route.
    w.clock.set(plan.startsAt + scheduled / 2);
    expect(getSentBottle(w.ctx, ada, id).position.progress).toBeCloseTo(0.5, 6);
    expect(progressAt(plan, w.clock.now())).toBeCloseTo(0.5, 6);

    // It arrives exactly when the shortened schedule says, not a moment before.
    w.clock.set(arrivalAt - 1);
    runJourneyTick(w.ctx);
    expect(getSentBottle(w.ctx, ada, id).state).toBe('at_sea');
    w.clock.set(arrivalAt);
    runJourneyTick(w.ctx);
    const delivered = getSentBottle(w.ctx, ada, id);
    expect(delivered.state).toBe('delivered');
    expect(delivered.deliveredAt).toBe(new Date(arrivalAt).toISOString());
  });

  it('a same-harbour letter still arrives immediately', () => {
    const w = world();
    const [ada, cy] = [w.user('ada'), w.user('cy')];
    setUserShore(w.ctx, cy.id, 'shore_gb_southampton');
    const released = w.clock.now();
    const id = releaseBottle(w.ctx, ada, releaseInput(cy.id, 'sched-key-000002')).bottleId;
    const bottle = w.db.select().from(t.bottles).where(eq(t.bottles.id, id)).get()!;
    expect(bottle.state).toBe('delivered');
    expect(bottle.deliveredAt).toBe(released);
    expect(activePlan(w.db, id)!.plannedDurationMs).toBe(0);
  });

  it('a journey already at sea keeps the schedule it was saved with', () => {
    const w = world();
    const [ada, bo] = [w.user('ada'), w.user('bo')];
    const id = releaseBottle(w.ctx, ada, releaseInput(bo.id, 'sched-key-000003')).bottleId;
    // Stand in for a bottle released before the change: its plan holds the full, unshortened
    // duration, as every plan saved before this change does.
    const plan = activePlan(w.db, id)!;
    const full = journeyDurationMs(plan.totalLength, w.ctx.config.msPerChartUnit, 1);
    w.db
      .update(t.routePlans)
      .set({ plannedDurationMs: full })
      .where(eq(t.routePlans.id, plan.id))
      .run();

    // New releases, journey ticks and reads leave that stored schedule alone.
    releaseBottle(w.ctx, ada, releaseInput(bo.id, 'sched-key-000004'));
    w.clock.set(plan.startsAt + Math.round(full * 0.7) + HOUR);
    runJourneyTick(w.ctx);
    const stored = activePlan(w.db, id)!;
    expect(stored.plannedDurationMs).toBe(full);
    expect(stored.startsAt).toBe(plan.startsAt);
    // Past 70% of its time it is still at sea, on its own schedule, and arrives at 100%.
    const dto = getSentBottle(w.ctx, ada, id);
    expect(dto.state).toBe('at_sea');
    expect(dto.plannedArrivalAt).toBe(new Date(plan.startsAt + full).toISOString());
    w.clock.set(plan.startsAt + full);
    runJourneyTick(w.ctx);
    expect(getSentBottle(w.ctx, ada, id).state).toBe('delivered');
  });

  it('a change of the device time zone does not move the journey', async () => {
    const w = world();
    const [ada, bo] = [w.user('ada'), w.user('bo')];
    const app = createApp(w.ctx);
    const { token } = await loginAs(app, 'ada');
    const id = releaseBottle(w.ctx, ada, releaseInput(bo.id, 'sched-key-000005')).bottleId;
    const before = getSentBottle(w.ctx, ada, id);
    for (const timeZone of ['Pacific/Auckland', 'America/Los_Angeles']) {
      const res = await app.request('/api/auth/time-zone', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ timeZone }),
      });
      expect(res.status).toBe(200);
      const after = getSentBottle(w.ctx, ada, id);
      expect(after.plannedArrivalAt).toBe(before.plannedArrivalAt);
      expect(after.route.plannedDurationMs).toBe(before.route.plannedDurationMs);
      expect(after.position.progress).toBe(before.position.progress);
    }
  });
});
