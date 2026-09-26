import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { NotificationsPageDto } from '@mib/shared';
import * as t from '../db/schema.js';
import { createApp } from './app.js';
import { OPERATIONAL_LOG_KEEP_MS, pruneExpiredRecords } from '../services/housekeeping.js';
import { enqueueNotification } from '../services/notifications.js';
import { releaseBottle } from '../services/release.js';
import { createTestWorld, loginAs, releaseInput } from '../test/harness.js';

// Product decision 6: the notification history is kept for the life of the account and read
// in pages; marking it read only clears the badge; only operational worker data is pruned.

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const w = createTestWorld({ defaultShoreCapacity: 80 });
  const app = createApp(w.ctx);
  const ada = w.user('ada');
  const bottleId = releaseBottle(
    w.ctx,
    ada,
    releaseInput(w.user('bo').id, 'history-0000001'),
  ).bottleId;
  // 120 notices across a long-lived account, one a day, all tied to a real bottle.
  for (let i = 0; i < 120; i++)
    enqueueNotification(w.db, {
      userId: ada.id,
      type: 'journey_event',
      kind: 'sent_arrived',
      bottleId,
      dedupeKey: `history:${i}`,
      message: `Notice ${i}`,
      now: w.realClock.now() - (120 - i) * DAY,
    });
  return { w, app, bottleId };
}
const page = async (app: ReturnType<typeof createApp>, token: string, before?: string) =>
  (await (
    await app.request(`/api/notifications${before ? `?before=${before}` : ''}`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json()) as NotificationsPageDto;

describe('notification history (product decision 6)', () => {
  it('loads a page at a time, newest first, through the whole history', async () => {
    const { app } = setup();
    const ada = await loginAs(app, 'ada');
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const p = await page(app, ada.token, cursor);
      expect(p.notifications.length).toBeLessThanOrEqual(50);
      seen.push(...p.notifications.map((n) => n.message));
      cursor = p.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
    expect(seen[0]).toBe('Notice 119');
    expect(seen.at(-1)).toBe('Notice 0');
  });

  it('keeps every entry, with its type, bottle, time and read state, after reading', async () => {
    const { app, bottleId } = setup();
    const ada = await loginAs(app, 'ada');
    expect((await page(app, ada.token)).unreadCount).toBe(120);
    await app.request('/api/notifications/read-all', {
      method: 'POST',
      headers: { authorization: `Bearer ${ada.token}` },
    });
    const first = await page(app, ada.token);
    expect(first.unreadCount).toBe(0);
    expect(first.notifications).toHaveLength(50);
    for (const n of first.notifications) {
      expect(n.type).toBe('journey_event');
      expect(n.kind).toBe('sent_arrived');
      expect(n.bottleId).toBe(bottleId);
      expect(n.readAt).not.toBeNull();
    }
  });

  it('never prunes notifications, letters or journey events; only worker retry logs', () => {
    const { w } = setup();
    const count = (table: typeof t.notifications | typeof t.letters | typeof t.journeyEvents) =>
      w.db.select().from(table).all().length;
    const before = [count(t.notifications), count(t.letters), count(t.journeyEvents)];
    // An old, finished review left its retry state behind.
    const caseRow = {
      id: 'case_ops',
      bottleId: w.db.select().from(t.bottles).get()!.id,
      letterId: w.db.select().from(t.letters).get()!.id,
      senderId: w.user('ada').id,
      recipientId: w.user('bo').id,
      context: 'shore' as const,
      evidenceText: 'x',
      evidenceFont: 'print',
      evidenceCharacters: 1,
      createdAt: 0,
      updatedAt: 0,
      aiStatus: 'done' as const,
      aiAttempts: 3,
      aiCompletedAt: w.realClock.now() - OPERATIONAL_LOG_KEEP_MS - DAY,
      aiLastError: 'model endpoint answered 503',
      aiVerdict: 'uncertain' as const,
    };
    w.db.insert(t.moderationCases).values(caseRow).run();
    const later = w.realClock.now() + 400 * DAY;
    expect(pruneExpiredRecords(w.db, later).workerRetryLogs).toBe(1);
    const after = w.db
      .select()
      .from(t.moderationCases)
      .where(eq(t.moderationCases.id, 'case_ops'))
      .get()!;
    expect(after.aiLastError).toBeNull();
    // The review outcome itself is not operational data and stays.
    expect(after.aiVerdict).toBe('uncertain');
    expect([count(t.notifications), count(t.letters), count(t.journeyEvents)]).toEqual(before);
  });
});
