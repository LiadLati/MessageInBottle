import { and, desc, eq, isNull } from 'drizzle-orm';
import type { NotificationDto } from '@mib/shared';
import type { DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';
import { newId } from '../lib/ids.js';
import type { AppContext } from './context.js';

export function enqueueNotification(
  db: DbOrTx,
  input: {
    userId: string;
    type: 'bottle_arrived' | 'journey_event';
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
      bottleId: input.bottleId,
      dedupeKey: input.dedupeKey,
      message: input.message,
      createdAt: input.now,
      readAt: null,
    })
    .onConflictDoNothing()
    .run();
}

export function listNotifications(ctx: AppContext, userId: string): NotificationDto[] {
  return ctx.db
    .select()
    .from(t.notifications)
    .where(eq(t.notifications.userId, userId))
    .orderBy(desc(t.notifications.createdAt))
    .limit(100)
    .all()
    .map((n) => ({
      id: n.id,
      type: n.type as NotificationDto['type'],
      bottleId: n.bottleId,
      message: n.message,
      createdAt: new Date(n.createdAt).toISOString(),
      readAt: n.readAt === null ? null : new Date(n.readAt).toISOString(),
    }));
}

export function markAllRead(ctx: AppContext, userId: string): void {
  ctx.db
    .update(t.notifications)
    .set({ readAt: ctx.clock.now() })
    .where(and(eq(t.notifications.userId, userId), isNull(t.notifications.readAt)))
    .run();
}
