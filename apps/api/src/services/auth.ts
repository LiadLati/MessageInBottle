import { and, eq, gt } from 'drizzle-orm';
import { normalizeUsername } from '@mib/shared';
import * as t from '../db/schema.js';
import { newId, newSecretToken, sha256 } from '../lib/ids.js';
import { AppError, conflict } from '../lib/errors.js';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../lib/password.js';
import type { AppContext, AuthUser } from './context.js';

export function toAuthUser(row: typeof t.users.$inferSelect): AuthUser {
  return { id: row.id, username: row.username, displayName: row.displayName, shoreId: row.shoreId };
}

// One generic failure for a missing user, a wrong password and an account that cannot sign in,
// so the response never reveals whether a username exists.
export const invalidCredentials = () =>
  new AppError(401, 'invalid_credentials', 'incorrect username or password');

function issueSession(ctx: AppContext, userId: string): string {
  const token = newSecretToken();
  const now = ctx.clock.now();
  ctx.db
    .insert(t.sessions)
    .values({
      tokenHash: sha256(token),
      userId,
      createdAt: now,
      expiresAt: now + ctx.config.sessionTtlMs,
    })
    .run();
  return token;
}

export function register(
  ctx: AppContext,
  input: { username: string; password: string },
): { token: string; user: AuthUser } {
  const username = normalizeUsername(input.username);
  const displayName = input.username.trim();
  const now = ctx.clock.now();
  const passwordHash = hashPassword(input.password);
  const id = newId('usr');
  try {
    ctx.db
      .insert(t.users)
      .values({
        id,
        username,
        displayName,
        shoreId: null,
        createdAt: now,
        passwordHash,
        passwordUpdatedAt: now,
      })
      .run();
  } catch (err) {
    // The unique index is the authority; the normalized lookup is only a friendlier pre-check.
    if (isUniqueViolation(err)) throw conflict('username_taken', 'that username is already taken');
    throw err;
  }
  const row = ctx.db.select().from(t.users).where(eq(t.users.id, id)).get()!;
  return { token: issueSession(ctx, id), user: toAuthUser(row) };
}

export function usernameTaken(ctx: AppContext, username: string): boolean {
  return Boolean(
    ctx.db
      .select({ id: t.users.id })
      .from(t.users)
      .where(eq(t.users.username, normalizeUsername(username)))
      .get(),
  );
}

export function login(
  ctx: AppContext,
  input: { username: string; password: string },
): { token: string; user: AuthUser } {
  const row = ctx.db
    .select()
    .from(t.users)
    .where(eq(t.users.username, normalizeUsername(input.username)))
    .get();
  // Always verify against some hash so timing does not differ for unknown usernames.
  const ok = verifyPassword(input.password, row?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!row || !row.passwordHash || !ok || row.status !== 'active') throw invalidCredentials();
  return { token: issueSession(ctx, row.id), user: toAuthUser(row) };
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

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    String(err.code).startsWith('SQLITE_CONSTRAINT')
  );
}
