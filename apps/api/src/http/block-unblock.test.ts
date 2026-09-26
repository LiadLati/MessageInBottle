import { and, eq, or } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { FriendsResponse } from '@mib/shared';
import * as t from '../db/schema.js';
import { createApp } from './app.js';
import { createTestWorld, loginAs, releaseInput } from '../test/harness.js';

// Manual review round 1, follow-up: Block → Unblock between two friends. Reproduced through the
// real HTTP surface: the block left the friendship row untouched and only hid it, but Unblock
// deleted that row, so the pair stayed invisible to each other and could not write. Unblock
// now lifts the block and nothing else; it never creates a relationship that was not there.
// Seeded pairs: Ada–Bo friends, Ada–Cy friends, Dee asked Ada (pending), Bo–Dee nothing.

async function world() {
  const w = createTestWorld({ defaultShoreCapacity: 60 });
  const app = createApp(w.ctx);
  const tokens: Record<string, string> = {};
  for (const u of ['ada', 'bo', 'cy', 'dee']) tokens[u] = (await loginAs(app, u)).token;
  const call = (who: string, method: string, path: string, body?: unknown) =>
    app.request(`/api${path}`, {
      method,
      headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const friendsOf = async (who: string) =>
    ((await (await call(who, 'GET', '/friends')).json()) as FriendsResponse).friends
      .map((f) => f.username)
      .sort();
  const requestsOf = async (who: string) => {
    const r = (await (await call(who, 'GET', '/friends')).json()) as FriendsResponse;
    return {
      incoming: r.incomingRequests.map((q) => q.from.username),
      outgoing: r.outgoingRequests.map((q) => q.to.username),
    };
  };
  let n = 0;
  // Recipient eligibility, as the server decides it at release.
  const canWrite = async (from: string, to: string) => {
    const res = await call(
      from,
      'POST',
      '/bottles/release',
      releaseInput(w.user(to).id, `bu-${String(++n).padStart(12, '0')}`),
    );
    return res.status === 201;
  };
  const block = (who: string, whom: string) =>
    call(who, 'POST', '/friends/blocks', { username: whom });
  const unblock = (who: string, whom: string) => call(who, 'DELETE', `/friends/blocks/${whom}`);
  const rows = (a: string, b: string) => {
    const [x, y] = [w.user(a).id, w.user(b).id];
    return {
      friendships: w.db
        .select()
        .from(t.friendships)
        .where(
          or(
            and(eq(t.friendships.userLowId, x), eq(t.friendships.userHighId, y)),
            and(eq(t.friendships.userLowId, y), eq(t.friendships.userHighId, x)),
          ),
        )
        .all()
        .map((r) => r.status),
      blocks: w.db
        .select()
        .from(t.blocks)
        .where(
          or(
            and(eq(t.blocks.blockerId, x), eq(t.blocks.blockedId, y)),
            and(eq(t.blocks.blockerId, y), eq(t.blocks.blockedId, x)),
          ),
        )
        .all().length,
    };
  };
  return { w, call, friendsOf, requestsOf, canWrite, block, unblock, rows };
}

describe('Block → Unblock between friends', () => {
  it('restores what the block prevented, for both accounts (the reproduced case)', async () => {
    const { friendsOf, canWrite, block, unblock, rows } = await world();
    // Before: friends, visible and writable both ways.
    expect(await friendsOf('ada')).toContain('bo');
    expect(await friendsOf('bo')).toContain('ada');
    expect(await canWrite('ada', 'bo')).toBe(true);
    expect(await canWrite('bo', 'ada')).toBe(true);
    expect(rows('ada', 'bo')).toEqual({ friendships: ['accepted'], blocks: 0 });

    // During the block: hidden and unwritable both ways.
    expect((await block('ada', 'bo')).status).toBe(204);
    expect(rows('ada', 'bo')).toEqual({ friendships: ['accepted'], blocks: 1 });
    expect(await friendsOf('ada')).not.toContain('bo');
    expect(await friendsOf('bo')).not.toContain('ada');
    expect(await canWrite('ada', 'bo')).toBe(false);
    expect(await canWrite('bo', 'ada')).toBe(false);

    // After Unblock: exactly as before the block.
    expect((await unblock('ada', 'bo')).status).toBe(204);
    expect(rows('ada', 'bo')).toEqual({ friendships: ['accepted'], blocks: 0 });
    expect(await friendsOf('ada')).toContain('bo');
    expect(await friendsOf('bo')).toContain('ada');
    expect(await canWrite('ada', 'bo')).toBe(true);
    expect(await canWrite('bo', 'ada')).toBe(true);
  });

  it('works the same when the other person is the one who blocks and unblocks', async () => {
    const { friendsOf, canWrite, block, unblock, rows } = await world();
    await block('bo', 'ada');
    expect(await canWrite('ada', 'bo')).toBe(false);
    await unblock('bo', 'ada');
    expect(rows('ada', 'bo')).toEqual({ friendships: ['accepted'], blocks: 0 });
    expect(await friendsOf('ada')).toContain('bo');
    expect(await canWrite('ada', 'bo')).toBe(true);
    expect(await canWrite('bo', 'ada')).toBe(true);
  });

  it('keeps everything blocked while the other person’s own block still stands', async () => {
    const { friendsOf, canWrite, block, unblock, rows } = await world();
    await block('ada', 'bo');
    await block('bo', 'ada');
    await unblock('ada', 'bo');
    expect(rows('ada', 'bo')).toEqual({ friendships: ['accepted'], blocks: 1 });
    expect(await friendsOf('ada')).not.toContain('bo');
    expect(await canWrite('ada', 'bo')).toBe(false);
    expect(await canWrite('bo', 'ada')).toBe(false);
    await unblock('bo', 'ada');
    expect(await friendsOf('ada')).toContain('bo');
    expect(await canWrite('ada', 'bo')).toBe(true);
  });

  it('never creates a friendship that was not there before the block', async () => {
    const { friendsOf, canWrite, block, unblock, rows, requestsOf } = await world();
    // Bo and Dee were never connected.
    expect(rows('bo', 'dee')).toEqual({ friendships: [], blocks: 0 });
    await block('bo', 'dee');
    await unblock('bo', 'dee');
    expect(rows('bo', 'dee')).toEqual({ friendships: [], blocks: 0 });
    expect(await friendsOf('bo')).not.toContain('dee');
    expect(await canWrite('bo', 'dee')).toBe(false);
    // A pending request stays a pending request: it is not turned into a friendship.
    await block('ada', 'dee');
    expect((await requestsOf('ada')).incoming).not.toContain('dee');
    await unblock('ada', 'dee');
    expect(rows('ada', 'dee')).toEqual({ friendships: ['pending'], blocks: 0 });
    expect((await requestsOf('ada')).incoming).toContain('dee');
    expect(await friendsOf('ada')).not.toContain('dee');
    expect(await canWrite('dee', 'ada')).toBe(false);
  });

  it('stays consistent through repeated blocks and unblocks', async () => {
    const { friendsOf, canWrite, block, unblock, rows } = await world();
    for (let i = 0; i < 3; i++) {
      expect((await block('ada', 'bo')).status).toBe(204);
      expect((await block('ada', 'bo')).status).toBe(204);
      expect(rows('ada', 'bo')).toEqual({ friendships: ['accepted'], blocks: 1 });
      expect((await unblock('ada', 'bo')).status).toBe(204);
      expect((await unblock('ada', 'bo')).status).toBe(404);
      expect(rows('ada', 'bo')).toEqual({ friendships: ['accepted'], blocks: 0 });
    }
    expect(await friendsOf('bo')).toContain('ada');
    expect(await canWrite('bo', 'ada')).toBe(true);
  });
});
