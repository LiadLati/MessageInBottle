import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as t from '../db/schema.js';
import { plannedArrivalAt } from '../domain/routing.js';
import { createApp } from '../http/app.js';
import { activePlan, dueArrivals, runJourneyTick } from './journey.js';
import { releaseBottle } from './release.js';
import { sendersDueRolls } from './risk.js';
import { createTestWorld, releaseInput } from '../test/harness.js';

// Audit ARCH-R-008 (the worker visited every bottle at sea and every sender on every tick) and
// ARCH-R-009 (one failing bottle or account stopped the whole tick).

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function world() {
  const w = createTestWorld({ defaultShoreCapacity: 40, minJourneyMs: 2 * DAY });
  const ids = [1, 2, 3, 4].map(
    (i) =>
      releaseBottle(
        w.ctx,
        w.user(i % 2 ? 'ada' : 'cy'),
        releaseInput(w.user('bo').id, `worker-key-000${i}`),
      ).bottleId,
  );
  return { w, ids };
}

describe('the journey worker reads only what is due (ARCH-R-008)', () => {
  it('selects no arrival before its time and every one after, earliest first', () => {
    const { w, ids } = world();
    expect(dueArrivals(w.ctx, w.clock.now())).toEqual([]);
    const arrivals = ids
      .map((id) => ({ id, at: plannedArrivalAt(activePlan(w.db, id)!) }))
      .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    expect(dueArrivals(w.ctx, arrivals[0]!.at - 1)).toEqual([]);
    const first = arrivals[0]!.at;
    expect(dueArrivals(w.ctx, first)).toEqual(
      arrivals.filter((a) => a.at === first).map((a) => a.id),
    );
    const last = arrivals.at(-1)!.at;
    expect(dueArrivals(w.ctx, last)).toEqual(arrivals.map((a) => a.id));
    expect(dueArrivals(w.ctx, last, 2)).toEqual(arrivals.slice(0, 2).map((a) => a.id));
  });

  it('visits an account for weather only when its next roll can be due', () => {
    const { w } = world();
    const senders = [w.user('ada').id, w.user('cy').id].sort();
    const now = w.clock.now();
    expect(sendersDueRolls(w.ctx, now).sort()).toEqual(senders);
    // Roll everything due, then look again over the next day.
    w.clock.set(now + 12 * HOUR);
    runJourneyTick(w.ctx);
    const rolled = w.db.select().from(t.weatherRolls).all();
    const lastRoll = (userId: string) =>
      Math.max(...rolled.filter((r) => r.userId === userId).map((r) => r.rolledAt));
    for (const id of senders) {
      if (!rolled.some((r) => r.userId === id)) continue;
      // Within 24 hours of its last roll an account cannot roll again, so it is not visited.
      expect(sendersDueRolls(w.ctx, lastRoll(id) + DAY - 1)).not.toContain(id);
      expect(sendersDueRolls(w.ctx, lastRoll(id) + DAY)).toContain(id);
    }
  });

  it('delivers a backlog over several ticks with the same result as one pass', () => {
    const { w, ids } = world();
    const last = Math.max(...ids.map((id) => plannedArrivalAt(activePlan(w.db, id)!)));
    w.clock.set(last + HOUR);
    const r = runJourneyTick(w.ctx);
    expect(r.delivered + r.cancelled + r.risk.lost).toBeGreaterThan(0);
    for (const id of ids) {
      const b = w.db.select().from(t.bottles).where(eq(t.bottles.id, id)).get()!;
      expect(b.state).not.toBe('at_sea');
      if (b.state === 'delivered')
        expect(b.deliveredAt).toBe(plannedArrivalAt(activePlan(w.db, id)!));
    }
  });
});

describe('one failing bottle does not stop the others (ARCH-R-009)', () => {
  it('skips it, delivers the rest, reports the failure and retries it next tick', async () => {
    const { w, ids } = world();
    const last = Math.max(...ids.map((id) => plannedArrivalAt(activePlan(w.db, id)!)));
    const broken = ids[1]!;
    // A database-level fault on exactly one bottle, as a corrupt row would cause.
    const sqlite = (w.db as unknown as { $client: { exec(sql: string): void } }).$client;
    sqlite.exec(
      `CREATE TRIGGER fail_one BEFORE UPDATE ON bottles WHEN OLD.id = '${broken}' BEGIN SELECT RAISE(ABORT, 'simulated fault'); END;`,
    );
    w.clock.set(last + HOUR);
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    let first: ReturnType<typeof runJourneyTick>;
    try {
      first = runJourneyTick(w.ctx);
    } finally {
      console.error = original;
    }
    expect(first.failures).toBeGreaterThanOrEqual(1);
    expect(String((errors[0] as unknown[])[0])).toContain(broken);
    const state = (id: string) =>
      w.db.select().from(t.bottles).where(eq(t.bottles.id, id)).get()!.state;
    expect(state(broken)).toBe('at_sea');
    for (const id of ids.filter((x) => x !== broken)) expect(state(id)).not.toBe('at_sea');

    // The readiness check reports the degraded worker without detail.
    w.ctx.workers = {
      journey: { lastTickAt: 1, lastTickFailures: first.failures, failedTicks: 0 },
    };
    const app = createApp(w.ctx);
    const health = (await (await app.request('/api/health')).json()) as { worker?: string };
    expect(health.worker).toBe('degraded');
    w.ctx.workers.journey.failedTicks = 3;
    expect((await app.request('/api/health')).status).toBe(503);

    sqlite.exec('DROP TRIGGER fail_one');
    const second = runJourneyTick(w.ctx);
    expect(second.failures).toBe(0);
    expect(state(broken)).not.toBe('at_sea');
  });
});
