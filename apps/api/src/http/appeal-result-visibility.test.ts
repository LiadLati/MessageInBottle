import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { AppealResultsDto, NotificationsPageDto } from '@mib/shared';
import * as t from '../db/schema.js';
import { createApp } from './app.js';
import { openBottle } from '../services/bottles.js';
import { commitArrivalIfDue } from '../services/journey.js';
import { reportLetter, submitAppeal } from '../services/moderation.js';
import { releaseBottle } from '../services/release.js';
import { createTestWorld, evidenceDigest, loginAs, releaseInput } from '../test/harness.js';

// An accepted appeal reached its author in the database but not on screen. Two causes, both
// reproduced with separate administrator and appellant sessions:
//
//   1. The history was ordered by `createdAt`. Journey notices are stamped by the shared DEV
//      clock, which a developer account typically has days ahead; moderation notices by the
//      real clock. The appeal result, written last, sorted under every arrival stamped in the
//      simulated future.
//   2. Opening the inbox marked every notification read, the appeal result included, so opening
//      it before the next 20-second poll consumed the one-time popup before it was ever shown.

const DAY = 24 * 60 * 60 * 1000;
const auth = (token: string) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
});

async function acceptedAppeal() {
  const w = createTestWorld({ defaultShoreCapacity: 80 });
  w.db
    .update(t.users)
    .set({ role: 'admin' })
    .where(eq(t.users.id, w.user('dee').id))
    .run();
  const app = createApp(w.ctx);
  const admin = await loginAs(app, 'dee');
  const appellant = await loginAs(app, 'ada');
  const ada = w.user('ada');
  const bo = w.user('bo');
  // Ada's letters arrive while the journey clock runs far ahead of real time, as it does for a
  // developer who has advanced it: her "reached its destination" notices are stamped days ahead.
  const reported = releaseBottle(w.ctx, ada, releaseInput(bo.id, 'appeal-vis-1-00000')).bottleId;
  const other = releaseBottle(w.ctx, ada, releaseInput(bo.id, 'appeal-vis-2-00000')).bottleId;
  w.clock.advance(60 * DAY);
  commitArrivalIfDue(w.ctx, reported, w.clock.now());
  commitArrivalIfDue(w.ctx, other, w.clock.now());
  openBottle(w.ctx, bo, reported);
  const { caseId } = reportLetter(w.ctx, bo, {
    bottleId: reported,
    reason: 'harassment',
    hide: false,
  });
  const upheld = await app.request(`/api/admin/reports/${caseId}/accept`, {
    method: 'POST',
    headers: auth(admin.token),
    body: JSON.stringify({ reason: 'Upheld.', evidenceDigest: evidenceDigest(w, caseId) }),
  });
  expect(upheld.status).toBe(200);
  const violationId = w.db.select().from(t.violations).where(eq(t.violations.caseId, caseId)).get()!
    .id;
  const appealId = submitAppeal(w.ctx, ada, { violationId, text: 'Please look again.' }).appeal!.id;
  w.realClock.advance(60_000);
  const decided = await app.request(`/api/admin/appeals/${appealId}/accept`, {
    method: 'POST',
    headers: auth(admin.token),
    body: JSON.stringify({ reason: 'Reviewed.' }),
  });
  expect(decided.status).toBe(200);
  const get = async <T>(path: string) =>
    (await (await app.request(path, { headers: auth(appellant.token) })).json()) as T;
  const row = w.db
    .select()
    .from(t.notifications)
    .where(eq(t.notifications.dedupeKey, `appeal_accepted:${appealId}`))
    .get()!;
  return { w, app, appellant, ada, appealId, row, get };
}

describe('an accepted appeal is visible to its author', () => {
  it('is written once, for the appellant, by stable user id', async () => {
    const { w, ada, appealId, row } = await acceptedAppeal();
    const appeal = w.db.select().from(t.appeals).where(eq(t.appeals.id, appealId)).get()!;
    expect(appeal.userId).toBe(ada.id);
    expect(row.userId).toBe(ada.id);
    expect(row.kind).toBe('moderation_appeal_accepted');
    expect(row.readAt).toBeNull();
  });

  it('heads the history even when journey notices are stamped by a clock running ahead', async () => {
    const { w, row, get } = await acceptedAppeal();
    const arrivals = w.db
      .select()
      .from(t.notifications)
      .where(eq(t.notifications.kind, 'sent_arrived'))
      .all()
      .filter((n) => n.userId === row.userId);
    // The situation that buried it: arrivals stamped two months after the appeal result.
    expect(arrivals.length).toBeGreaterThan(0);
    expect(arrivals.every((n) => n.createdAt > row.createdAt)).toBe(true);

    const page = await get<NotificationsPageDto>('/api/notifications');
    expect(page.notifications[0]!.id).toBe(row.id);
    expect(page.notifications[0]!.kind).toBe('moderation_appeal_accepted');
  });

  it('opening the inbox before the popup does not consume the popup', async () => {
    const { app, appellant, row, get } = await acceptedAppeal();
    const read = await app.request('/api/notifications/read-all', {
      method: 'POST',
      headers: auth(appellant.token),
    });
    expect(read.status).toBeLessThan(300);

    // Still offered as the one-time popup, still in the history, and the badge counts exactly it.
    const popup = await get<AppealResultsDto>('/api/moderation/appeal-results');
    expect(popup.results.map((n) => n.id)).toEqual([row.id]);
    const page = await get<NotificationsPageDto>('/api/notifications');
    expect(page.unreadCount).toBe(1);
    expect(page.notifications.filter((n) => n.readAt === null).map((n) => n.id)).toEqual([row.id]);

    // Dismissing the popup is what reads it; the entry stays in the history.
    const seen = await app.request(`/api/moderation/appeal-results/${row.id}/seen`, {
      method: 'POST',
      headers: auth(appellant.token),
    });
    expect(seen.status).toBe(204);
    expect((await get<AppealResultsDto>('/api/moderation/appeal-results')).results).toEqual([]);
    const after = await get<NotificationsPageDto>('/api/notifications');
    expect(after.unreadCount).toBe(0);
    expect(after.notifications[0]!.id).toBe(row.id);
  });

  it('pages through mixed-clock history newest-written first, each entry once', async () => {
    const { w, row, get } = await acceptedAppeal();
    const all = w.db
      .select()
      .from(t.notifications)
      .all()
      .filter((n) => n.userId === row.userId);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const q: string = cursor ? `?before=${cursor}&limit=1` : '?limit=1';
      const page: NotificationsPageDto = await get<NotificationsPageDto>(`/api/notifications${q}`);
      seen.push(...page.notifications.map((n) => n.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen[0]).toBe(row.id);
    expect([...seen].sort()).toEqual(all.map((n) => n.id).sort());
    // A cursor in the earlier "<createdAt>.<rowid>" form is still understood.
    const legacy = await get<NotificationsPageDto>(`/api/notifications?before=1.999999&limit=100`);
    expect(legacy.notifications).toHaveLength(all.length);
  });
});
