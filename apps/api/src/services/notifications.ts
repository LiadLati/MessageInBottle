import { and, asc, desc, eq, inArray, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
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
//
// Newest means most recently written, so the order and the cursor are SQLite's rowid (insertion
// order), not `createdAt`. The two agree in production, where there is one clock. In a DEV
// build they do not: journey notices are stamped by the shared DEV clock, which may be days
// ahead, and moderation notices by the real clock, so ordering by `createdAt` buried an appeal
// result written today under arrivals stamped in the simulated future — it was in the history,
// just nowhere the person would look. The cursor is the rowid of the last row served; an older
// "<createdAt>.<rowid>" cursor is still understood by its rowid.
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
    .where(and(eq(t.notifications.userId, userId), cursor === null ? undefined : lt(rowid, cursor)))
    .orderBy(desc(rowid))
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
    nextCursor: more && last ? String(last.rowid) : null,
    unreadCount: unread?.n ?? 0,
  };
}

// The newest entries, for internal callers that need no paging.
export function listNotifications(ctx: AppContext, userId: string): NotificationDto[] {
  return notificationPage(ctx, userId, { limit: 100 }).notifications;
}

function parseCursor(raw: string | null): number | null {
  const m = raw ? /^(?:\d{1,15}\.)?(\d{1,15})$/.exec(raw) : null;
  return m ? Number(m[1]) : null;
}

// Reading the inbox marks everything as read. It only clears the unread badge: every entry stays
// in the history. This touches notifications only: no bottle, marker visibility, opening or
// outcome is involved.
//
// An unread appeal result is the one exception: it stays unread until its one-time popup is
// dismissed (markAppealResultSeen). Otherwise opening the inbox before the next poll consumed
// the popup unseen, and the result was reduced to one row among many in the history.
export function markAllRead(ctx: AppContext, userId: string): void {
  ctx.db
    .update(t.notifications)
    .set({ readAt: ctx.clock.now() })
    .where(
      and(
        eq(t.notifications.userId, userId),
        isNull(t.notifications.readAt),
        or(
          isNull(t.notifications.kind),
          notInArray(t.notifications.kind, [...APPEAL_RESULT_KINDS]),
        ),
      ),
    )
    .run();
}

// ---------- appeal results (manual review round 1) ----------

const APPEAL_RESULT_KINDS = ['moderation_appeal_accepted', 'moderation_appeal_rejected'] as const;

// Appeal results the person has not read yet: the one-time popup shows these, on this visit or
// the next sign-in, and — unlike the inbox — also while the account is suspended or banned,
// because an appeal result is often exactly what a restricted person is waiting for. It is the
// same notification row as in the history, so the badge and the popup can never disagree.
export function unreadAppealResults(ctx: AppContext, userId: string): NotificationDto[] {
  return ctx.db
    .select()
    .from(t.notifications)
    .where(
      and(
        eq(t.notifications.userId, userId),
        isNull(t.notifications.readAt),
        inArray(t.notifications.kind, [...APPEAL_RESULT_KINDS]),
      ),
    )
    .orderBy(asc(t.notifications.createdAt))
    .all()
    .map((n) => ({
      id: n.id,
      type: n.type as NotificationDto['type'],
      kind: n.kind as NotificationKind,
      bottleId: n.bottleId,
      message: n.message,
      createdAt: new Date(n.createdAt).toISOString(),
      readAt: null,
    }));
}

// Dismissing the popup marks that one notification read — exactly what opening the inbox does
// to it — and deletes nothing: the entry stays in the history. Only the caller's own appeal
// results can be marked this way; anything else is not found.
export function markAppealResultSeen(ctx: AppContext, userId: string, id: string): boolean {
  const row = ctx.db
    .select({ id: t.notifications.id })
    .from(t.notifications)
    .where(
      and(
        eq(t.notifications.id, id),
        eq(t.notifications.userId, userId),
        inArray(t.notifications.kind, [...APPEAL_RESULT_KINDS]),
      ),
    )
    .get();
  if (!row) return false;
  ctx.db
    .update(t.notifications)
    .set({ readAt: ctx.clock.now() })
    .where(and(eq(t.notifications.id, id), isNull(t.notifications.readAt)))
    .run();
  return true;
}
