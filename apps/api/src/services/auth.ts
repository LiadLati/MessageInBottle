import { and, eq, gt } from 'drizzle-orm';
import * as t from '../db/schema.js';
import { newId, newSecretToken, sha256 } from '../lib/ids.js';
import { badRequest } from '../lib/errors.js';
import type { AppContext, AuthUser } from './context.js';

function toAuthUser(row: typeof t.users.$inferSelect): AuthUser {
  return { id: row.id, username: row.username, displayName: row.displayName, shoreId: row.shoreId };
}

// Development sign-in: a username is enough and unknown usernames are created on the spot.
// Real credentials/identity providers are a later stage; tokens are still opaque and stored hashed.
export function devLogin(ctx: AppContext, username: string): { token: string; user: AuthUser } {
  if (!ctx.config.devMode) throw badRequest('dev_only', 'dev login is disabled');
  const normalized = username.toLowerCase();
  const now = ctx.clock.now();
  const user = ctx.db.transaction((tx) => {
    const existing = tx.select().from(t.users).where(eq(t.users.username, normalized)).get();
    if (existing) return existing;
    const id = newId('usr');
    tx.insert(t.users)
      .values({
        id,
        username: normalized,
        displayName: normalized.charAt(0).toUpperCase() + normalized.slice(1),
        shoreId: null,
        createdAt: now,
      })
      .run();
    return tx.select().from(t.users).where(eq(t.users.id, id)).get()!;
  });
  const token = newSecretToken();
  ctx.db
    .insert(t.sessions)
    .values({
      tokenHash: sha256(token),
      userId: user.id,
      createdAt: now,
      expiresAt: now + ctx.config.sessionTtlMs,
    })
    .run();
  return { token, user: toAuthUser(user) };
}

export function resolveSession(ctx: AppContext, token: string): AuthUser | null {
  const now = ctx.clock.now();
  const row = ctx.db
    .select({ user: t.users })
    .from(t.sessions)
    .innerJoin(t.users, eq(t.users.id, t.sessions.userId))
    .where(and(eq(t.sessions.tokenHash, sha256(token)), gt(t.sessions.expiresAt, now)))
    .get();
  if (!row || row.user.status !== 'active') return null;
  return toAuthUser(row.user);
}

export function logout(ctx: AppContext, token: string): void {
  ctx.db
    .delete(t.sessions)
    .where(eq(t.sessions.tokenHash, sha256(token)))
    .run();
}
