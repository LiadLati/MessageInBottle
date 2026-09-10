import { and, eq, or } from 'drizzle-orm';
import type { FriendsResponse } from '@mib/shared';
import type { DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import type { AppContext } from './context.js';

export function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export function areAcceptedFriends(db: DbOrTx, a: string, b: string): boolean {
  const [low, high] = canonicalPair(a, b);
  const row = db
    .select({ status: t.friendships.status })
    .from(t.friendships)
    .where(and(eq(t.friendships.userLowId, low), eq(t.friendships.userHighId, high)))
    .get();
  return row?.status === 'accepted';
}

// Blocks are enforced in both directions for correspondence (spec §8.2, §16).
export function isBlockedEitherWay(db: DbOrTx, a: string, b: string): boolean {
  const row = db
    .select({ blockerId: t.blocks.blockerId })
    .from(t.blocks)
    .where(
      or(
        and(eq(t.blocks.blockerId, a), eq(t.blocks.blockedId, b)),
        and(eq(t.blocks.blockerId, b), eq(t.blocks.blockedId, a)),
      ),
    )
    .get();
  return row !== undefined;
}

function publicUser(u: { id: string; username: string; displayName: string }) {
  return { id: u.id, username: u.username, displayName: u.displayName };
}

export function listFriends(ctx: AppContext, userId: string): FriendsResponse {
  const rows = ctx.db
    .select()
    .from(t.friendships)
    .where(or(eq(t.friendships.userLowId, userId), eq(t.friendships.userHighId, userId)))
    .all();
  const otherIds = rows.map((r) => (r.userLowId === userId ? r.userHighId : r.userLowId));
  const users = new Map<string, typeof t.users.$inferSelect>();
  for (const id of new Set([...otherIds, userId])) {
    const u = ctx.db.select().from(t.users).where(eq(t.users.id, id)).get();
    if (u) users.set(id, u);
  }
  const me = users.get(userId)!;
  const friends: FriendsResponse['friends'] = [];
  const incomingRequests: FriendsResponse['incomingRequests'] = [];
  const outgoingRequests: FriendsResponse['outgoingRequests'] = [];
  for (const r of rows) {
    const otherId = r.userLowId === userId ? r.userHighId : r.userLowId;
    const other = users.get(otherId);
    if (!other || other.status !== 'active') continue;
    // A blocked pair is invisible to each other in the friends UI.
    if (isBlockedEitherWay(ctx.db, userId, otherId)) continue;
    if (r.status === 'accepted') {
      friends.push({ ...publicUser(other), hasShore: other.shoreId !== null });
    } else if (r.requestedById === userId) {
      outgoingRequests.push({
        id: r.id,
        from: publicUser(me),
        to: publicUser(other),
        createdAt: new Date(r.createdAt).toISOString(),
      });
    } else {
      incomingRequests.push({
        id: r.id,
        from: publicUser(other),
        to: publicUser(me),
        createdAt: new Date(r.createdAt).toISOString(),
      });
    }
  }
  friends.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { friends, incomingRequests, outgoingRequests };
}

export function sendFriendRequest(ctx: AppContext, fromId: string, toUsername: string): void {
  const target = ctx.db
    .select()
    .from(t.users)
    .where(eq(t.users.username, toUsername.toLowerCase()))
    .get();
  // Same generic error whether the user is missing or has blocked the requester.
  if (!target || target.status !== 'active' || isBlockedEitherWay(ctx.db, fromId, target.id)) {
    throw notFound('user');
  }
  if (target.id === fromId) throw badRequest('self_request', 'you cannot befriend yourself');
  const [low, high] = canonicalPair(fromId, target.id);
  const now = ctx.clock.now();
  const existing = ctx.db
    .select()
    .from(t.friendships)
    .where(and(eq(t.friendships.userLowId, low), eq(t.friendships.userHighId, high)))
    .get();
  if (existing) {
    if (existing.status === 'accepted') throw conflict('already_friends', 'already friends');
    if (existing.requestedById !== fromId) {
      // They already asked us: treat as mutual approval.
      ctx.db
        .update(t.friendships)
        .set({ status: 'accepted', acceptedAt: now })
        .where(eq(t.friendships.id, existing.id))
        .run();
      return;
    }
    throw conflict('request_pending', 'request already pending');
  }
  ctx.db
    .insert(t.friendships)
    .values({
      id: newId('frd'),
      userLowId: low,
      userHighId: high,
      requestedById: fromId,
      status: 'pending',
      createdAt: now,
      acceptedAt: null,
    })
    .run();
}

export function acceptFriendRequest(ctx: AppContext, userId: string, requestId: string): void {
  const row = ctx.db.select().from(t.friendships).where(eq(t.friendships.id, requestId)).get();
  if (!row || row.status !== 'pending') throw notFound('friend request');
  if (row.requestedById === userId || (row.userLowId !== userId && row.userHighId !== userId)) {
    throw notFound('friend request');
  }
  if (isBlockedEitherWay(ctx.db, row.userLowId, row.userHighId)) throw notFound('friend request');
  ctx.db
    .update(t.friendships)
    .set({ status: 'accepted', acceptedAt: ctx.clock.now() })
    .where(and(eq(t.friendships.id, requestId), eq(t.friendships.status, 'pending')))
    .run();
}

export function blockUser(ctx: AppContext, blockerId: string, username: string): void {
  const target = ctx.db
    .select()
    .from(t.users)
    .where(eq(t.users.username, username.toLowerCase()))
    .get();
  if (!target) throw notFound('user');
  if (target.id === blockerId) throw badRequest('self_block', 'you cannot block yourself');
  ctx.db
    .insert(t.blocks)
    .values({ blockerId, blockedId: target.id, createdAt: ctx.clock.now() })
    .onConflictDoNothing()
    .run();
}
