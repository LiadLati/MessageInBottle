import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import {
  NOTIFICATIONS_PAGE_SIZE,
  type NotificationDto,
  type NotificationKind,
  type NotificationsPageDto,
} from '@mib/shared';
import type { DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';
import { newId } from '../lib/ids.js';
import type { AppContext } from './context.js';

// One notification per event per account. The dedupe key is unique, so a worker retry, a
// replayed request or a repeated tick can never write a second row for the same event.
export function enqueueNotification(
  db: DbOrTx,
  input: {
    userId: string;
    type: 'bottle_arrived' | 'journey_event' | 'moderation';
    kind: NotificationKind;
    bottleId: string | null;
    dedupeKey: string;
    message: string;
    now: number;
  },
): void {
  db.insert(t.notifications)
    .values({
      id: newId('ntf'),
      userId: input.userId,
      type: input.type,
      kind: input.kind,
      bottleId: input.bottleId,
      dedupeKey: input.dedupeKey,
      message: input.message,
      createdAt: input.now,
      readAt: null,
    })
    .onConflictDoNothing()
    .run();
}

// Rows written before `kind` existed are classified from the dedupe key they were written
// with; a loss row needs the bottle's reason to tell adrift from sunk.
function classify(
  row: { kind: string | null; dedupeKey: string },
  lossReason: string | null,
): NotificationKind {
  if (row.kind) return row.kind as NotificationKind;
  const prefix = row.dedupeKey.slice(0, row.dedupeKey.indexOf(':'));
  switch (prefix) {
    case 'arrived':
      return 'received_arrived';
    case 'sent_arrived':
      return 'sent_arrived';
    case 'lost':
      return lossReason === 'sunk' ? 'sent_sunk' : 'sent_adrift';
    case 'public_opened':
      return 'sent_found';
    case 'cancelled':
      return 'sent_cancelled';
    default:
      return 'other';
  }
}

// The user-visible notification history (product decision 6). It is kept for the life of the
// account — nothing prunes it — and read a page at a time, newest first, so an old account
// never loads everything at once. The cursor is "<createdAt>.<rowid>" of the last row served.
// This is the only notification data SeaYou keeps: delivery is a database write, so there are
// no separate delivery attempts or provider logs behind it (services/housekeeping.ts prunes
// only operational records).
export function notificationPage(
  ctx: AppContext,
  userId: string,
  page: { before?: string | null; limit?: number | undefined } = {},
): NotificationsPageDto {
  const limit = Math.min(Math.max(page.limit ?? NOTIFICATIONS_PAGE_SIZE, 1), 100);
  const cursor = parseCursor(page.before ?? null);
  const rowid = sql<number>`"notifications"."rowid"`;
  const rows = ctx.db
    .select({ n: t.notifications, lossReason: t.bottles.lossReason, rowid })
    .from(t.notifications)
    .leftJoin(t.bottles, eq(t.bottles.id, t.notifications.bottleId))
    .where(
      and(
        eq(t.notifications.userId, userId),
        cursor
          ? or(
              lt(t.notifications.createdAt, cursor.createdAt),
              and(eq(t.notifications.createdAt, cursor.createdAt), lt(rowid, cursor.rowid)),
            )
          : undefined,
      ),
    )
    // Newest first. Ids are random, so two notices written in the same millisecond (a
    // suspension and the appeal that lifted it, say) would otherwise come back in a different
    // order on every read; SQLite's rowid is insertion order, which is the one we mean.
    .orderBy(desc(t.notifications.createdAt), desc(rowid))
    .limit(limit + 1)
    .all();
  const more = rows.length > limit;
  const served = rows.slice(0, limit);
  const last = served.at(-1);
  const unread = ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(t.notifications)
    .where(and(eq(t.notifications.userId, userId), isNull(t.notifications.readAt)))
    .get();
  return {
    notifications: served.map(({ n, lossReason }) => ({
      id: n.id,
      type: n.type as NotificationDto['type'],
      kind: classify(n, lossReason),
      bottleId: n.bottleId,
      message: n.message,
      createdAt: new Date(n.createdAt).toISOString(),
      readAt: n.readAt === null ? null : new Date(n.readAt).toISOString(),
    })),
    nextCursor: more && last ? `${last.n.createdAt}.${last.rowid}` : null,
    unreadCount: unread?.n ?? 0,
  };
}

// The newest entries, for internal callers that need no paging.
export function listNotifications(ctx: AppContext, userId: string): NotificationDto[] {
  return notificationPage(ctx, userId, { limit: 100 }).notifications;
}

function parseCursor(raw: string | null): { createdAt: number; rowid: number } | null {
  const m = raw ? /^(\d{1,15})\.(\d{1,15})$/.exec(raw) : null;
  return m ? { createdAt: Number(m[1]), rowid: Number(m[2]) } : null;
}

// Reading the inbox marks everything as read. It only clears the unread badge: every entry stays
// in the history. This touches notifications only: no bottle, marker visibility, opening or
// outcome is involved.
export function markAllRead(ctx: AppContext, userId: string): void {
  ctx.db
    .update(t.notifications)
    .set({ readAt: ctx.clock.now() })
    .where(and(eq(t.notifications.userId, userId), isNull(t.notifications.readAt)))
    .run();
}
