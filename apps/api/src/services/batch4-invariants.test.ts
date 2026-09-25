import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as t from '../db/schema.js';
import { assertSchemaComplete } from '../db/compat.js';
import { createTestWorld, releaseInput, type TestWorld } from '../test/harness.js';
import { decideCase } from './admin.js';
import { setAccountTimeZone } from './auth.js';
import { openBottle } from './bottles.js';
import { loadActiveGraph } from './chart.js';
import { commitArrivalIfDue } from './journey.js';
import { reportLetter } from './moderation.js';
import { releaseBottle } from './release.js';
import { processRiskDecisions } from './risk.js';

// Direct evidence for Batch 4 fixes whose effect is otherwise only visible as speed or as the
// absence of a slow failure.

const DAY = 24 * 60 * 60 * 1000;
const sqliteOf = (w: TestWorld) =>
  (w.db as unknown as { $client: { prepare: (sql: string) => unknown } }).$client;

describe('the route graph is built once per connection (QA-006)', () => {
  it('is the same object inside every write transaction as outside', () => {
    const w = createTestWorld();
    const outside = loadActiveGraph(w.db);
    const first = w.db.transaction((tx) => loadActiveGraph(tx));
    const second = w.db.transaction((tx) => loadActiveGraph(tx));
    expect(first).toBe(outside);
    expect(second).toBe(outside);
  });
});

describe('the risk worker walks forward, not from the start (ARCH-011)', () => {
  it('does far less work on a tick with nothing new than on the first', () => {
    const w = createTestWorld({ msPerChartUnit: 60 * 60 * 1000 });
    setAccountTimeZone(w.ctx, w.user('ada'), 'Europe/Berlin');
    for (let i = 0; i < 5; i++)
      releaseBottle(
        w.ctx,
        w.user('ada'),
        releaseInput(w.user('bo').id, `key-arch011-${String(i).padStart(4, '0')}`),
      );
    w.clock.advance(12 * DAY);
    const client = sqliteOf(w);
    const real = client.prepare.bind(client);
    let prepared = 0;
    client.prepare = (sql: string) => {
      prepared++;
      return real(sql);
    };
    processRiskDecisions(w.ctx, w.clock.now());
    const firstTick = prepared;
    prepared = 0;
    processRiskDecisions(w.ctx, w.clock.now());
    const idleTick = prepared;
    client.prepare = real;
    expect(firstTick).toBeGreaterThan(0);
    // The first tick rolls twelve nights for the account and decides its storms for five
    // bottles. The second resumes from the account's last persisted roll and has nothing to
    // do: one query lists the accounts with journeys at risk, a fixed handful per account
    // reads its map clock, activation and last roll, and one lists due storms — however many
    // nights or bottles there are.
    expect(idleTick).toBeLessThanOrEqual(1 + 5 + 1);
    // The first tick wrote every roll it persisted (twelve nights here) on top of that fixed
    // cost, whatever the rolls decided; the idle tick wrote none.
    const rolls = w.db.select().from(t.weatherRolls).all().length;
    expect(rolls).toBeGreaterThanOrEqual(11);
    expect(firstTick).toBeGreaterThanOrEqual(idleTick + rolls);
  });
});

describe('the schema check follows schema.ts (ARCH-020)', () => {
  it('names a column that a migration failed to create, including recent ones', () => {
    const w = createTestWorld();
    const client = sqliteOf(w) as unknown as { exec: (sql: string) => void };
    expect(() => assertSchemaComplete(client as never)).not.toThrow();
    // `stormsWeathered` reads risk_decisions.storm_starts_at; drop a late-added column instead
    // of a whole table so the check has to look at columns.
    client.exec('ALTER TABLE risk_decisions DROP COLUMN reason');
    expect(() => assertSchemaComplete(client as never)).toThrow(/risk_decisions\.reason/);
  });
});

describe('moderation notices are dated by the real clock (ARCH-026)', () => {
  it('uses the real time even when the journey clock has run ahead', () => {
    const w = createTestWorld();
    const id = releaseBottle(
      w.ctx,
      w.user('ada'),
      releaseInput(w.user('bo').id, 'key-arch026-0001'),
    ).bottleId;
    w.clock.advance(60 * DAY); // the journey clock only
    commitArrivalIfDue(w.ctx, id, w.clock.now());
    openBottle(w.ctx, w.user('bo'), id);
    const caseId = reportLetter(w.ctx, w.user('bo'), {
      bottleId: id,
      reason: 'harassment',
      hide: false,
    }).caseId;
    w.realClock.advance(5 * 60 * 1000);
    w.db
      .update(t.users)
      .set({ role: 'admin' })
      .where(eq(t.users.id, w.user('cy').id))
      .run();
    decideCase(w.ctx, w.user('cy'), caseId, 'accepted', 'abusive');
    const notice = w.db
      .select()
      .from(t.notifications)
      .where(eq(t.notifications.userId, w.user('ada').id))
      .all()
      .find((n) => n.type === 'moderation');
    expect(notice?.createdAt).toBe(w.realClock.now());
    expect(notice?.createdAt).not.toBe(w.clock.now());
  });
});
