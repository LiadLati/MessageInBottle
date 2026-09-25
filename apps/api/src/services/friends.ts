import { and, desc, eq, isNull, ne, or, type SQL } from 'drizzle-orm';
import type { BlockedUsersResponse, FriendsResponse } from '@mib/shared';
import type { DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import type { AppContext } from './context.js';
import { isRestricted } from './moderation.js';

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
  const now = ctx.realClock.now();
  const friends: FriendsResponse['friends'] = [];
  const incomingRequests: FriendsResponse['incomingRequests'] = [];
  const outgoingRequests: FriendsResponse['outgoingRequests'] = [];
  for (const r of rows) {
    const otherId = r.userLowId === userId ? r.userHighId : r.userLowId;
    const other = users.get(otherId);
    if (!other || other.status !== 'active') continue;
    // A suspended or banned account is unavailable for the whole restriction (product decision
    // 14): hidden here, while the friendship row itself stays and reappears when it ends.
    if (isRestricted(ctx.db, otherId, now)) continue;
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
  return {
    friends,
    incomingRequests,
    outgoingRequests,
    pendingIncomingCount: incomingRequests.length,
  };
}

export function sendFriendRequest(ctx: AppContext, fromId: string, toUsername: string): void {
  const target = ctx.db
    .select()
    .from(t.users)
    .where(eq(t.users.username, toUsername.toLowerCase()))
    .get();
  // Same generic error whether the user is missing, has blocked the requester, or is suspended
  // or banned (product decision 14: not findable while restricted).
  if (
    !target ||
    target.status !== 'active' ||
    isBlockedEitherWay(ctx.db, fromId, target.id) ||
    isRestricted(ctx.db, target.id, ctx.realClock.now())
  ) {
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

// Declining a request removes the pending row in one guarded statement: only the addressee can
// decline, an accepted friendship is never touched, and repeating the call is a no-op (the
// request is simply gone). Nothing about bottles or journeys is involved.
export function denyFriendRequest(ctx: AppContext, userId: string, requestId: string): void {
  ctx.db
    .delete(t.friendships)
    .where(
      and(
        eq(t.friendships.id, requestId),
        eq(t.friendships.status, 'pending'),
        or(eq(t.friendships.userLowId, userId), eq(t.friendships.userHighId, userId)),
        ne(t.friendships.requestedById, userId),
      ),
    )
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

// A finder blocking the anonymous writer of the bottle they are reading (product decision 12).
// Only during their own open reading session; the writer's identity is never returned, and the
// block works like any other from then on (no bottles either way, no public-ocean encounters).
export function blockFoundWriter(ctx: AppContext, finderId: string, bottleId: string): void {
  const now = ctx.clock.now();
  const row = ctx.db
    .select({ senderId: t.bottles.senderId, opening: t.publicOpenings })
    .from(t.publicOpenings)
    .innerJoin(t.bottles, eq(t.bottles.id, t.publicOpenings.bottleId))
    .where(and(eq(t.publicOpenings.bottleId, bottleId), eq(t.publicOpenings.openedById, finderId)))
    .get();
  if (
    !row ||
    row.opening.closedAt !== null ||
    (row.opening.sessionExpiresAt ?? 0) <= now ||
    row.senderId === finderId
  ) {
    throw notFound('reading');
  }
  ctx.db
    .insert(t.blocks)
    .values({
      blockerId: finderId,
      blockedId: row.senderId,
      createdAt: now,
      foundBottleId: bottleId,
    })
    .onConflictDoNothing()
    .run();
}

// The accounts this person has blocked, newest first (product decision 10). Deleted accounts
// drop out: deleting an account removes its blocks in both directions.
export function listBlocked(ctx: AppContext, blockerId: string): BlockedUsersResponse {
  const rows = ctx.db
    .select({
      username: t.users.username,
      displayName: t.users.displayName,
      status: t.users.status,
      blockedAt: t.blocks.createdAt,
      foundBottleId: t.blocks.foundBottleId,
    })
    .from(t.blocks)
    .innerJoin(t.users, eq(t.users.id, t.blocks.blockedId))
    .where(eq(t.blocks.blockerId, blockerId))
    .orderBy(desc(t.blocks.createdAt))
    .all();
  return {
    blocked: rows
      .filter((r) => r.status === 'active')
      .map((r) =>
        r.foundBottleId
          ? {
              username: null,
              displayName: FOUND_WRITER_NAME,
              blockedAt: new Date(r.blockedAt).toISOString(),
              foundBottleId: r.foundBottleId,
            }
          : {
              username: r.username,
              displayName: r.displayName,
              blockedAt: new Date(r.blockedAt).toISOString(),
              foundBottleId: null,
            },
      ),
  };
}

// Unblocking permits future contact under the ordinary rules, and nothing more: it removes this
// person's block and any friendship or pending request left over between the pair, so being
// friends again takes a new request. Nothing cancelled, removed or hidden while the block stood
// comes back, and nothing about that time is shown. The other person's own block, if any, stays.
export function unblockUser(ctx: AppContext, blockerId: string, username: string): void {
  const target = ctx.db
    .select({ id: t.users.id })
    .from(t.users)
    .where(eq(t.users.username, username.toLowerCase()))
    .get();
  if (!target) throw notFound('user');
  // A block made anonymously from a found bottle is undone only by that bottle, so trying names
  // can never confirm who wrote it.
  removeBlock(ctx, blockerId, target.id, isNull(t.blocks.foundBottleId));
}

// The label a finder sees in Blocked users for a writer they never learned the name of.
export const FOUND_WRITER_NAME = 'The writer of a bottle you found';

// Undoing an anonymous block from a found bottle. Same effects as any unblock.
export function unblockFoundWriter(ctx: AppContext, blockerId: string, bottleId: string): void {
  const row = ctx.db
    .select({ blockedId: t.blocks.blockedId })
    .from(t.blocks)
    .where(and(eq(t.blocks.blockerId, blockerId), eq(t.blocks.foundBottleId, bottleId)))
    .get();
  if (!row) throw notFound('block');
  removeBlock(ctx, blockerId, row.blockedId, eq(t.blocks.foundBottleId, bottleId));
}

function removeBlock(
  ctx: AppContext,
  blockerId: string,
  blockedId: string,
  which: SQL,
): void {
  ctx.db.transaction((tx) => {
    const removed = tx
      .delete(t.blocks)
      .where(and(eq(t.blocks.blockerId, blockerId), eq(t.blocks.blockedId, blockedId), which))
      .run().changes;
    if (removed === 0) throw notFound('block');
    const [low, high] = canonicalPair(blockerId, blockedId);
    tx.delete(t.friendships)
      .where(and(eq(t.friendships.userLowId, low), eq(t.friendships.userHighId, high)))
      .run();
  });
}
