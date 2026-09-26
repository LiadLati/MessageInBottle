import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { AccountStandingDto, AppealResultsDto, NotificationsPageDto } from '@mib/shared';
import * as t from '../db/schema.js';
import { createApp } from './app.js';
import { openBottle } from '../services/bottles.js';
import { commitArrivalIfDue } from '../services/journey.js';
import { reportLetter, submitAppeal } from '../services/moderation.js';
import { releaseBottle } from '../services/release.js';
import { createTestWorld, evidenceDigest, loginAs, releaseInput } from '../test/harness.js';

// Manual review round 1, item 5: an appeal result reaches its author as a real, persisted
// notification in the history and as a one-time popup — also while suspended or banned — and
// the unread badge always counts entries the list actually shows. Nothing names the reporter.

const DAY = 24 * 60 * 60 * 1000;
const headers = (token: string) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
});

async function setup(letters = 2) {
  const w = createTestWorld({ defaultShoreCapacity: 80 });
  w.db
    .update(t.users)
    .set({ role: 'admin' })
    .where(eq(t.users.id, w.user('dee').id))
    .run();
  const app = createApp(w.ctx);
  const dee = await loginAs(app, 'dee');
  // Letters from Ada to Bo, all reported by Bo and upheld: two suspend Ada, three ban her.
  const ids = Array.from({ length: letters }, (_, i) => i + 1).map(
    (i) =>
      releaseBottle(w.ctx, w.user('ada'), releaseInput(w.user('bo').id, `appeal-res-${i}-00000`))
        .bottleId,
  );
  w.clock.advance(60 * DAY);
  const violations: string[] = [];
  const cases = ids.map((id) => {
    commitArrivalIfDue(w.ctx, id, w.clock.now());
    openBottle(w.ctx, w.user('bo'), id);
    return reportLetter(w.ctx, w.user('bo'), { bottleId: id, reason: 'harassment', hide: false })
      .caseId;
  });
  for (const caseId of cases) {
    const res = await app.request(`/api/admin/reports/${caseId}/accept`, {
      method: 'POST',
      headers: headers(dee.token),
      body: JSON.stringify({ reason: 'Upheld.', evidenceDigest: evidenceDigest(w, caseId) }),
    });
    expect(res.status).toBe(200);
    violations.push(
      w.db.select().from(t.violations).where(eq(t.violations.caseId, caseId)).get()!.id,
    );
  }
  const appeals = violations.map(
    (violationId) =>
      submitAppeal(w.ctx, w.user('ada'), { violationId, text: 'Please look again.' }).appeal!.id,
  );
  const ada = await loginAs(app, 'ada');
  const get = async <T>(path: string, token = ada.token) => {
    const res = await app.request(path, { headers: headers(token) });
    return { status: res.status, body: (await res.json().catch(() => null)) as T };
  };
  const decide = (id: string, outcome: 'accept' | 'reject') =>
    app.request(`/api/admin/appeals/${id}/${outcome}`, {
      method: 'POST',
      headers: headers(dee.token),
      body: JSON.stringify({ reason: 'Reviewed.' }),
    });
  const seen = (id: string, token = ada.token) =>
    app.request(`/api/moderation/appeal-results/${id}/seen`, {
      method: 'POST',
      headers: headers(token),
    });
  return { w, app, ada, appeals, get, decide, seen };
}

describe('appeal results reach the appellant', () => {
  it('a rejection reaches a suspended account as a popup, and stays in the history', async () => {
    const { w, appeals, get, decide, seen } = await setup();
    expect((await get<AccountStandingDto>('/api/moderation/standing')).body.standing).toBe(
      'suspended',
    );
    expect((await get<AppealResultsDto>('/api/moderation/appeal-results')).body.results).toEqual(
      [],
    );
    expect((await decide(appeals[1]!, 'reject')).status).toBe(200);

    // Suspended: the ordinary inbox stays closed (product decision 14), the result does not.
    expect((await get('/api/notifications')).status).toBe(403);
    const popup = (await get<AppealResultsDto>('/api/moderation/appeal-results')).body.results;
    expect(popup).toHaveLength(1);
    expect(popup[0]!.kind).toBe('moderation_appeal_rejected');
    expect(popup[0]!.message).toMatch(/was reviewed and rejected/);
    expect(popup[0]!.message).toMatch(/final within SeaYou/);
    expect(popup[0]!.message).toMatch(/\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}/);
    expect(popup[0]!.message).not.toMatch(/Bo\b/);

    // Dismissed once, it does not come back — on this visit or the next sign-in — and the
    // row is still there, now read.
    expect((await seen(popup[0]!.id)).status).toBe(204);
    expect((await seen(popup[0]!.id)).status).toBe(204);
    expect((await get<AppealResultsDto>('/api/moderation/appeal-results')).body.results).toEqual(
      [],
    );
    const row = w.db
      .select()
      .from(t.notifications)
      .where(eq(t.notifications.id, popup[0]!.id))
      .get()!;
    expect(row.readAt).not.toBeNull();
  });

  it('an acceptance is a visible notification, and the badge counts only what the list shows', async () => {
    const { app, appeals, get, decide } = await setup();
    expect((await decide(appeals[0]!, 'accept')).status).toBe(200);

    // One violation left in force: the account is out of suspension and has its inbox back.
    expect((await get<AccountStandingDto>('/api/moderation/standing')).body.standing).toBe(
      'warned',
    );
    const page = (await get<NotificationsPageDto>('/api/notifications')).body;
    const accepted = page.notifications.filter((n) => n.kind === 'moderation_appeal_accepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.message).toMatch(/was accepted/);
    expect(accepted[0]!.message).toMatch(/violation was withdrawn/);
    expect(accepted[0]!.message).toMatch(/standing was recalculated/);
    expect(accepted[0]!.message).not.toMatch(/Bo\b/);
    // No ghost badge: every unread counted is an entry in the list.
    expect(page.unreadCount).toBe(page.notifications.filter((n) => n.readAt === null).length);

    // The popup offers the same row; reading the inbox answers it too.
    const popup = (await get<AppealResultsDto>('/api/moderation/appeal-results')).body.results;
    expect(popup.map((n) => n.id)).toEqual([accepted[0]!.id]);
    await app.request('/api/notifications/read-all', {
      method: 'POST',
      headers: { authorization: `Bearer ${(await loginAs(app, 'ada')).token}` },
    });
    expect((await get<AppealResultsDto>('/api/moderation/appeal-results')).body.results).toEqual(
      [],
    );
    const after = (await get<NotificationsPageDto>('/api/notifications')).body;
    expect(after.unreadCount).toBe(0);
    expect(after.notifications.some((n) => n.id === accepted[0]!.id)).toBe(true);
  });

  it('a banned account still learns the result', async () => {
    const { appeals, get, decide } = await setup(3);
    expect((await get<AccountStandingDto>('/api/moderation/standing')).body.standing).toBe(
      'banned',
    );
    expect((await decide(appeals[1]!, 'reject')).status).toBe(200);
    const popup = (await get<AppealResultsDto>('/api/moderation/appeal-results')).body.results;
    expect(popup.map((n) => n.kind)).toEqual(['moderation_appeal_rejected']);
  });

  it('only the appellant can see or dismiss their result', async () => {
    const { app, appeals, get, decide, seen } = await setup();
    await decide(appeals[1]!, 'reject');
    const id = (await get<AppealResultsDto>('/api/moderation/appeal-results')).body.results[0]!.id;
    const bo = await loginAs(app, 'bo');
    expect(
      (await get<AppealResultsDto>('/api/moderation/appeal-results', bo.token)).body.results,
    ).toEqual([]);
    expect((await seen(id, bo.token)).status).toBe(404);
    expect((await app.request('/api/moderation/appeal-results')).status).toBe(401);
    expect(
      (await get<AppealResultsDto>('/api/moderation/appeal-results')).body.results,
    ).toHaveLength(1);
  });
});
