import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { RISK_POLICY_VERSION } from '@mib/shared';
import * as t from '../db/schema.js';
import { plannedArrivalAt } from '../domain/routing.js';
import { newId } from '../lib/ids.js';
import { decideCase } from './admin.js';
import { openBottle } from './bottles.js';
import { setUserShore } from './chart.js';
import { deleteAccount } from './deletion.js';
import { activePlan } from './journey.js';
import { reportLetter } from './moderation.js';
import { releaseBottle } from './release.js';
import { T0, createTestWorld, releaseInput } from '../test/harness.js';

// Audit ARCH-R-005: a storm whose midpoint has already passed is decided before anything ends
// the journeys it struck: a deletion (of the sender or the recipient), a restriction of the
// recipient, or a harbour change that turns the map to day. Before, the result depended on
// whether the worker had happened to run since the midpoint: an on-time worker decided it, a
// late one found the journeys already ended or the storm cancelled.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ZONE = 'Asia/Jerusalem'; // T0 (12:00Z) is 15:00 there; 16:00Z is 19:00, night.
const DUSK = Date.parse('2026-09-06T16:00:00.000Z');
const MIDPOINT = DUSK + 2 * HOUR;

// Ada's map runs on Jerusalem time from before T0; she sends three long journeys to Bo, and a
// storm on her map has its midpoint two hours after dusk. The clock is then an hour past it, and
// no worker has run.
function stormDue(source: 'device' | 'harbour' = 'device') {
  const w = createTestWorld({ defaultShoreCapacity: 20, minJourneyMs: 4 * DAY });
  const ada = w.user('ada');
  w.db
    .insert(t.accountZoneChanges)
    .values({
      id: newId('azc'),
      userId: ada.id,
      zone: ZONE,
      source,
      effectiveAt: T0 - DAY,
      createdAt: T0 - DAY,
    })
    .run();
  const ids = [1, 2, 3].map(
    (i) => releaseBottle(w.ctx, ada, releaseInput(w.user('bo').id, `settle-key-0000${i}`)).bottleId,
  );
  for (const id of ids) expect(plannedArrivalAt(activePlan(w.db, id)!)).toBeGreaterThan(MIDPOINT);
  const rollId = newId('wrl');
  w.db
    .insert(t.weatherRolls)
    .values({
      id: rollId,
      userId: ada.id,
      policyVersion: RISK_POLICY_VERSION,
      rolledAt: DUSK,
      zone: ZONE,
      nightStartsAt: DUSK,
      nightEndsAt: DUSK + 11 * HOUR,
      outcome: 'storm',
      stormStartsAt: DUSK + HOUR,
      stormEndsAt: DUSK + 3 * HOUR,
      decisionAt: MIDPOINT,
      createdAt: DUSK,
    })
    .run();
  w.clock.set(MIDPOINT + HOUR);
  w.realClock.set(MIDPOINT + HOUR);
  const roll = () => w.db.select().from(t.weatherRolls).where(eq(t.weatherRolls.id, rollId)).get()!;
  const decisions = () =>
    w.db.select().from(t.riskDecisions).where(eq(t.riskDecisions.nightKey, rollId)).all();
  return { w, ids, roll, decisions };
}

function expectDecided(s: ReturnType<typeof stormDue>) {
  expect(s.roll().decidedAt).not.toBeNull();
  expect(s.roll().cancelledAt).toBeNull();
  // One decision per journey that was at sea at the midpoint, as an on-time worker writes.
  expect(
    s
      .decisions()
      .map((d) => d.bottleId)
      .sort(),
  ).toEqual([...s.ids].sort());
}

describe('storms already due are decided before journeys end (ARCH-R-005)', () => {
  it('when the sender deletes their account', () => {
    const s = stormDue();
    const decisionsBefore = s.decisions();
    expect(decisionsBefore).toEqual([]);
    deleteAccount(s.w.ctx, s.w.user('ada').id);
    // The account's rolls go with it; the decisions taken on its journeys remain.
    expect(
      s
        .decisions()
        .map((d) => d.bottleId)
        .sort(),
    ).toEqual([...s.ids].sort());
  });

  it('when the recipient deletes their account', () => {
    const s = stormDue();
    deleteAccount(s.w.ctx, s.w.user('bo').id);
    expectDecided(s);
  });

  it('when the recipient is restricted and the journeys to them end', () => {
    const s = stormDue();
    const w = s.w;
    const [bo, cy, dee] = [w.user('bo'), w.user('cy'), w.user('dee')];
    w.db.update(t.users).set({ role: 'admin' }).where(eq(t.users.id, dee.id)).run();
    // Bo writes twice to Cy on Bo's own harbour (delivered at once); both upheld: suspended.
    w.db.update(t.users).set({ shoreId: bo.shoreId }).where(eq(t.users.id, cy.id)).run();
    for (const i of [1, 2]) {
      const id = releaseBottle(w.ctx, bo, releaseInput(cy.id, `settle-bo-000${i}`)).bottleId;
      openBottle(w.ctx, cy, id);
      const { caseId } = reportLetter(w.ctx, cy, { bottleId: id, reason: 'spam', hide: false });
      decideCase(w.ctx, dee, caseId, 'accepted', 'upheld');
    }
    // The journeys travelling to Bo have ended, and the storm that struck them was decided.
    for (const id of s.ids)
      expect(w.db.select().from(t.bottles).where(eq(t.bottles.id, id)).get()!.state).not.toBe(
        'at_sea',
      );
    expectDecided(s);
  });

  it('when a harbour change turns the map to day after the midpoint', () => {
    const s = stormDue('harbour');
    // New York's nautical zone: 14:00 there at this instant, daytime.
    setUserShore(s.w.ctx, s.w.user('ada').id, 'shore_us_new_york');
    expectDecided(s);
  });

  it('a harbour change before the midpoint still cancels the storm, deciding nothing', () => {
    const s = stormDue('harbour');
    s.w.clock.set(MIDPOINT - 30 * 60 * 1000);
    setUserShore(s.w.ctx, s.w.user('ada').id, 'shore_us_new_york');
    expect(s.roll().cancelledAt).not.toBeNull();
    expect(s.roll().decidedAt).toBeNull();
    expect(s.decisions()).toEqual([]);
  });
});
