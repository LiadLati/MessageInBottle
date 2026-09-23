// Operator password reset for one existing account. The logic lives here, free of process I/O,
// so it can be tested; tools/reset-password.ts is the command-line entry that drives it.
//
// It changes exactly what the in-app reset flow changes (services/auth.ts, resetPassword):
// the password hash and its timestamp, every outstanding reset token (invalidated), and every
// session (deleted). Username, e-mail, id, role and status are never written.
import { and, count, eq, isNull } from 'drizzle-orm';
import { normalizeEmail, normalizeUsername, passwordProblem } from '@mib/shared';
import type { Db } from '../db/client.js';
import * as t from '../db/schema.js';
import { hashPassword, verifyPassword } from '../lib/password.js';

export interface AccountSummary {
  id: string;
  username: string;
  role: string;
  status: string;
  deleted: boolean;
}

export interface LookupResult {
  username: string;
  email: string;
  byUsername: AccountSummary | null;
  byEmail: AccountSummary | null;
  // Set only when both lookups found the same active account (and, if one was expected, with
  // that role). Anything else is a reason to stop.
  account: AccountSummary | null;
  problem: string | null;
}

const summary = (row: typeof t.users.$inferSelect): AccountSummary => ({
  id: row.id,
  username: row.username,
  role: row.role,
  status: row.status,
  deleted: row.deletedAt !== null,
});

// Looks the account up by username and by e-mail independently, and accepts it only when both
// name the same active row.
export function lookUpAccount(
  db: Db,
  input: { username: string; email: string; expectRole?: string | undefined },
): LookupResult {
  const username = normalizeUsername(input.username);
  const email = normalizeEmail(input.email);
  const u = db.select().from(t.users).where(eq(t.users.username, username)).get();
  const e = db.select().from(t.users).where(eq(t.users.email, email)).get();
  const result: LookupResult = {
    username,
    email,
    byUsername: u ? summary(u) : null,
    byEmail: e ? summary(e) : null,
    account: null,
    problem: null,
  };
  if (!u) return { ...result, problem: `No account has the username "${username}".` };
  if (!e) return { ...result, problem: `No account is registered with ${email}.` };
  if (u.id !== e.id)
    return {
      ...result,
      problem: `The username and the e-mail identify DIFFERENT accounts (${u.id} and ${e.id}).`,
    };
  if (u.status !== 'active' || u.deletedAt !== null)
    return { ...result, problem: `The account ${u.id} is not active (status ${u.status}).` };
  if (input.expectRole && u.role !== input.expectRole)
    return {
      ...result,
      problem: `The account ${u.id} has the role ${u.role}, not ${input.expectRole}.`,
    };
  return { ...result, account: summary(u) };
}

export interface ResetOutcome {
  sessionsRevoked: number;
  resetTokensInvalidated: number;
}

export function resetAccountPassword(
  db: Db,
  input: { userId: string; password: string; now: number },
): ResetOutcome {
  const row = db.select().from(t.users).where(eq(t.users.id, input.userId)).get();
  if (!row || row.status !== 'active' || row.deletedAt !== null)
    throw new Error('The account is missing or not active. Nothing was changed.');
  const problem = passwordProblem(input.password, row.username);
  if (problem) throw new Error(`${problem} Nothing was changed.`);
  const passwordHash = hashPassword(input.password);
  return db.transaction((tx) => {
    // Guarded on the identity and state just confirmed: if anything changed in between, the
    // update matches nothing and the whole transaction is abandoned.
    const updated = tx
      .update(t.users)
      .set({ passwordHash, passwordUpdatedAt: input.now })
      .where(
        and(
          eq(t.users.id, row.id),
          eq(t.users.username, row.username),
          eq(t.users.role, row.role),
          eq(t.users.status, 'active'),
          isNull(t.users.deletedAt),
        ),
      )
      .run();
    if (updated.changes !== 1)
      throw new Error('The account changed while the reset was running. Nothing was changed.');
    const resetTokensInvalidated = tx
      .update(t.passwordResets)
      .set({ invalidatedAt: input.now })
      .where(
        and(
          eq(t.passwordResets.userId, row.id),
          isNull(t.passwordResets.usedAt),
          isNull(t.passwordResets.invalidatedAt),
        ),
      )
      .run().changes;
    const sessionsRevoked = tx
      .delete(t.sessions)
      .where(eq(t.sessions.userId, row.id))
      .run().changes;
    return { sessionsRevoked, resetTokensInvalidated };
  });
}

export interface Verification {
  sameId: boolean;
  sameUsername: boolean;
  sameEmail: boolean;
  active: boolean;
  sameRole: boolean;
  hashChanged: boolean;
  newPasswordVerifies: boolean;
  sessionsRemaining: number;
  outstandingResetTokens: number;
}

// Compares the account before and after. Only booleans and counts leave this function: the
// password and both hashes stay in memory.
export function verifyReset(
  db: Db,
  before: typeof t.users.$inferSelect,
  password: string,
): Verification {
  const after = db.select().from(t.users).where(eq(t.users.id, before.id)).get();
  const sessions = db
    .select({ n: count() })
    .from(t.sessions)
    .where(eq(t.sessions.userId, before.id))
    .get();
  const resets = db
    .select({ n: count() })
    .from(t.passwordResets)
    .where(
      and(
        eq(t.passwordResets.userId, before.id),
        isNull(t.passwordResets.usedAt),
        isNull(t.passwordResets.invalidatedAt),
      ),
    )
    .get();
  return {
    sameId: after?.id === before.id,
    sameUsername: after?.username === before.username,
    sameEmail: after?.email === before.email,
    active: after?.status === 'active' && after.deletedAt === null,
    sameRole: after?.role === before.role,
    hashChanged: !!after?.passwordHash && after.passwordHash !== before.passwordHash,
    newPasswordVerifies: verifyPassword(password, after?.passwordHash),
    sessionsRemaining: sessions?.n ?? -1,
    outstandingResetTokens: resets?.n ?? -1,
  };
}
