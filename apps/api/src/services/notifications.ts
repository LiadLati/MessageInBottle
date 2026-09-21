import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { NotificationDto, NotificationKind } from '@mib/shared';
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

export function listNotifications(ctx: AppContext, userId: string): NotificationDto[] {
  return (
    ctx.db
      .select({ n: t.notifications, lossReason: t.bottles.lossReason })
      .from(t.notifications)
      .leftJoin(t.bottles, eq(t.bottles.id, t.notifications.bottleId))
      .where(eq(t.notifications.userId, userId))
      // Newest first. Ids are random, so two notices written in the same millisecond (a
      // suspension and the appeal that lifted it, say) would otherwise come back in a different
      // order on every read; SQLite's rowid is insertion order, which is the one we mean.
      .orderBy(desc(t.notifications.createdAt), desc(sql`"notifications"."rowid"`))
      .limit(100)
      .all()
      .map(({ n, lossReason }) => ({
        id: n.id,
        type: n.type as NotificationDto['type'],
        kind: classify(n, lossReason),
        bottleId: n.bottleId,
        message: n.message,
        createdAt: new Date(n.createdAt).toISOString(),
        readAt: n.readAt === null ? null : new Date(n.readAt).toISOString(),
      }))
  );
}

// Reading the inbox marks everything as read. This touches notifications only: no bottle, marker
// visibility, opening or outcome is involved.
export function markAllRead(ctx: AppContext, userId: string): void {
  ctx.db
    .update(t.notifications)
    .set({ readAt: ctx.clock.now() })
    .where(and(eq(t.notifications.userId, userId), isNull(t.notifications.readAt)))
    .run();
}
