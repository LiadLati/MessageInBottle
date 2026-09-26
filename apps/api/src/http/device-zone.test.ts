import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { SentBottleDto } from '@mib/shared';
import * as t from '../db/schema.js';
import { createApp } from './app.js';
import { decideCase } from '../services/admin.js';
import { openBottle } from '../services/bottles.js';
import { commitArrivalIfDue } from '../services/journey.js';
import { accountStanding, reportLetter } from '../services/moderation.js';
import { releaseBottle } from '../services/release.js';
import { createTestWorld, loginAs, releaseInput } from '../test/harness.js';

// Product decision 9 (and 15): the device zone is validated and stored, and it moves nothing
// authoritative — journey duration, ETA, arrival, appeal deadlines — all of which run on
// server time. (Storm nights follow the account zone under the approved risk policy v3; see
// docs/REMEDIATION.md for that reported conflict.)

const DAY = 24 * 60 * 60 * 1000;

async function setup() {
  const w = createTestWorld({ defaultShoreCapacity: 40 });
  const app = createApp(w.ctx);
  const ada = await loginAs(app, 'ada');
  const put = (zone: string) =>
    app.request('/api/auth/time-zone', {
      method: 'PUT',
      headers: { authorization: `Bearer ${ada.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ timeZone: zone }),
    });
  const passport = async (id: string) =>
    (
      (await (
        await app.request(`/api/bottles/sent/${id}`, {
          headers: { authorization: `Bearer ${ada.token}` },
        })
      ).json()) as { bottle: SentBottleDto }
    ).bottle;
  return { w, app, ada, put, passport };
}

describe('device time zone (product decision 9)', () => {
  it('stores a valid IANA zone, updates it when it changes, and refuses anything else', async () => {
    const { w, put } = await setup();
    expect((await put('Asia/Tokyo')).status).toBe(200);
    expect((await put('Europe/Lisbon')).status).toBe(200);
    expect(w.db.select().from(t.users).where(eq(t.users.username, 'ada')).get()!.timeZone).toBe(
      'Europe/Lisbon',
    );
    for (const bad of ['+05:00', 'GMT+2', 'Nowhere/Land'])
      expect((await put(bad)).status).toBe(400);
  });

  it('never changes a journey’s duration, ETA or arrival', async () => {
    const { w, put, passport } = await setup();
    await put('Pacific/Kiritimati');
    const id = releaseBottle(
      w.ctx,
      w.user('ada'),
      releaseInput(w.user('bo').id, 'zone-000001'),
    ).bottleId;
    const before = await passport(id);
    await put('Pacific/Pago_Pago'); // 25 hours away
    const after = await passport(id);
    expect(after.route.plannedDurationMs).toBe(before.route.plannedDurationMs);
    expect(after.plannedArrivalAt).toBe(before.plannedArrivalAt);
    w.clock.set(Date.parse(before.plannedArrivalAt) - 1);
    expect(commitArrivalIfDue(w.ctx, id, w.clock.now())).toBe(false);
    w.clock.set(Date.parse(before.plannedArrivalAt));
    expect(commitArrivalIfDue(w.ctx, id, w.clock.now())).toBe(true);
    expect((await passport(id)).deliveredAt).toBe(before.plannedArrivalAt);
  });

  it('never moves an appeal deadline', async () => {
    const { w, put } = await setup();
    w.db
      .update(t.users)
      .set({ role: 'admin' })
      .where(eq(t.users.id, w.user('cy').id))
      .run();
    const id = releaseBottle(
      w.ctx,
      w.user('ada'),
      releaseInput(w.user('bo').id, 'zone-000002'),
    ).bottleId;
    w.clock.advance(60 * DAY);
    commitArrivalIfDue(w.ctx, id, w.clock.now());
    openBottle(w.ctx, w.user('bo'), id);
    const caseId = reportLetter(w.ctx, w.user('bo'), {
      bottleId: id,
      reason: 'spam',
      hide: false,
    }).caseId;
    decideCase(w.ctx, { ...w.user('cy'), role: 'admin' }, caseId, 'accepted', 'spam');
    const deadline = accountStanding(w.ctx, w.user('ada').id).pendingDecision!.appealDeadlineAt;
    await put('America/Los_Angeles');
    expect(accountStanding(w.ctx, w.user('ada').id).pendingDecision!.appealDeadlineAt).toBe(
      deadline,
    );
  });
});
