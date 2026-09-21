import { and, eq, gt, isNull } from 'drizzle-orm';
import type { PolicyAcceptanceRequest } from '@mib/shared';
import { RESET_TOKEN_TTL_MS, normalizeEmail, normalizeUsername } from '@mib/shared';
import * as t from '../db/schema.js';
import { newId, newSecretToken, sha256 } from '../lib/ids.js';
import { AppError, badRequest, conflict } from '../lib/errors.js';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../lib/password.js';
import type { AppContext, AuthUser } from './context.js';
import { assertAcceptancesAllowed, recordAcceptances } from './policies.js';

export function toAuthUser(row: typeof t.users.$inferSelect): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    shoreId: row.shoreId,
    email: row.email,
    timeZone: row.timeZone,
  };
}

// Is this an IANA zone the runtime knows? Anything else is refused rather than stored.
export function isKnownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// The account's night zone (spec §9.3): first learned from the device, re-synced on every app
// start or resume. Recording *when* it took effect is what keeps a change from reaching into
// the past — nights are only ever walked from that instant on. Unchanged zones are a no-op, so
// a resume never moves the instant and never shortens the night in progress.
export function setAccountTimeZone(ctx: AppContext, user: AuthUser, zone: string): AuthUser {
  if (!isKnownTimeZone(zone)) throw badRequest('unknown_time_zone', 'unknown time zone');
  if (user.timeZone === zone) return user;
  ctx.db
    .update(t.users)
    .set({ timeZone: zone, timeZoneSince: ctx.clock.now() })
    .where(eq(t.users.id, user.id))
    .run();
  return { ...user, timeZone: zone };
}

// One generic failure for a missing user, a wrong password and an account that cannot sign in,
// so the response never reveals whether a username exists.
export const invalidCredentials = () =>
  new AppError(401, 'invalid_credentials', 'incorrect username or password');

function issueSession(ctx: AppContext, userId: string): string {
  const token = newSecretToken();
  // Real time, never the development clock: a clock jump that lands a bottle must not expire
  // the session of the person watching it arrive.
  const now = ctx.realClock.now();
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
  input: { username: string; email: string; password: string; policies: PolicyAcceptanceRequest },
): { token: string; user: AuthUser } {
  // Nobody is asked to agree to unfinished legal text outside development.
  assertAcceptancesAllowed(ctx);
  const username = normalizeUsername(input.username);
  const email = normalizeEmail(input.email);
  const displayName = input.username.trim();
  const now = ctx.clock.now();
  const passwordHash = hashPassword(input.password);
  const id = newId('usr');
  try {
    // The account and its acceptances are one write: no account exists without its record of
    // what it accepted, and no record exists without its account.
    ctx.db.transaction((tx) => {
      tx.insert(t.users)
        .values({
          id,
          username,
          displayName,
          shoreId: null,
          createdAt: now,
          passwordHash,
          passwordUpdatedAt: now,
          email,
        })
        .run();
      recordAcceptances(tx, id, input.policies, 'registration', ctx.realClock.now());
    });
  } catch (err) {
    // The unique indexes are the authority; the normalized lookups are only friendlier pre-checks.
    if (isUniqueViolation(err)) {
      if (String(err).includes('email'))
        throw conflict('email_taken', 'that email is already registered');
      throw conflict('username_taken', 'that username is already taken');
    }
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

export function emailTaken(ctx: AppContext, email: string): boolean {
  return Boolean(
    ctx.db
      .select({ id: t.users.id })
      .from(t.users)
      .where(eq(t.users.email, normalizeEmail(email)))
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
  const now = ctx.realClock.now();
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

// ---------- password recovery ----------

export const resetInvalid = () =>
  badRequest('reset_invalid', 'this reset link is invalid or has expired');

// Always completes the same way whether or not the address belongs to an account. When it
// does, earlier unused tokens are superseded and one fresh token is mailed. The token itself
// exists only in the message; the database keeps its hash.
export async function requestPasswordReset(ctx: AppContext, email: string): Promise<void> {
  const normalized = normalizeEmail(email);
  // Reset tokens are an authentication lifetime: real time, like sessions.
  const now = ctx.realClock.now();
  const user = normalized
    ? ctx.db.select().from(t.users).where(eq(t.users.email, normalized)).get()
    : undefined;
  if (!user || user.status !== 'active') return;
  const token = newSecretToken();
  ctx.db.transaction((tx) => {
    tx.update(t.passwordResets)
      .set({ invalidatedAt: now })
      .where(
        and(
          eq(t.passwordResets.userId, user.id),
          isNull(t.passwordResets.usedAt),
          isNull(t.passwordResets.invalidatedAt),
        ),
      )
      .run();
    tx.insert(t.passwordResets)
      .values({
        id: newId('prs'),
        userId: user.id,
        tokenHash: sha256(token),
        createdAt: now,
        expiresAt: now + RESET_TOKEN_TTL_MS,
      })
      .run();
  });
  const link = `${ctx.config.appUrl.replace(/\/$/, '')}/?reset=${token}`;
  await ctx.mailer.send({
    to: user.email!,
    subject: 'Reset your Message in a Bottle password',
    text: [
      `Hello ${user.displayName},`,
      '',
      'Someone asked to reset the password for your Message in a Bottle account.',
      'If that was you, open this link within 30 minutes:',
      '',
      link,
      '',
      'If it was not you, ignore this message; your password stays as it is.',
    ].join('\n'),
  });
}

// Consumes one valid token: sets the password, marks the token used, supersedes every other
// open token for the account and revokes all of its sessions.
export function resetPassword(ctx: AppContext, input: { token: string; password: string }): void {
  const now = ctx.realClock.now();
  const hash = sha256(input.token);
  const row = ctx.db
    .select()
    .from(t.passwordResets)
    .where(eq(t.passwordResets.tokenHash, hash))
    .get();
  if (!row || row.usedAt !== null || row.invalidatedAt !== null || row.expiresAt <= now)
    throw resetInvalid();
  const user = ctx.db.select().from(t.users).where(eq(t.users.id, row.userId)).get();
  if (!user || user.status !== 'active') throw resetInvalid();
  const passwordHash = hashPassword(input.password);
  ctx.db.transaction((tx) => {
    // Guarded update: a concurrent use of the same token loses.
    const used = tx
      .update(t.passwordResets)
      .set({ usedAt: now })
      .where(and(eq(t.passwordResets.id, row.id), isNull(t.passwordResets.usedAt)))
      .run();
    if (used.changes !== 1) throw resetInvalid();
    tx.update(t.passwordResets)
      .set({ invalidatedAt: now })
      .where(
        and(
          eq(t.passwordResets.userId, user.id),
          isNull(t.passwordResets.usedAt),
          isNull(t.passwordResets.invalidatedAt),
        ),
      )
      .run();
    tx.update(t.users)
      .set({ passwordHash, passwordUpdatedAt: now })
      .where(eq(t.users.id, user.id))
      .run();
    tx.delete(t.sessions).where(eq(t.sessions.userId, user.id)).run();
  });
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    String(err.code).startsWith('SQLITE_CONSTRAINT')
  );
}
