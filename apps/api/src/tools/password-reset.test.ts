import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as t from '../db/schema.js';
import { createApp } from '../http/app.js';
import { verifyPassword } from '../lib/password.js';
import { createTestWorld, loginAs, makeDeveloper, type TestWorld } from '../test/harness.js';
import { lookUpAccount, resetAccountPassword, verifyReset } from './password-reset.js';

// A throwaway password generated for each run: no real credential is ever written into a test.
const freshPassword = () => `Pw-${randomBytes(9).toString('base64url')}`;

function world() {
  const w = createTestWorld();
  // "bo" plays the developer account; "ada" is an unrelated member with an e-mail of her own.
  makeDeveloper(w, 'bo');
  w.db
    .update(t.users)
    .set({ username: 'developer', email: 'dev@example.test' })
    .where(eq(t.users.id, w.user('bo').id))
    .run();
  w.db
    .update(t.users)
    .set({ email: 'ada@example.test' })
    .where(eq(t.users.id, w.user('ada').id))
    .run();
  return { w, app: createApp(w.ctx) };
}

const row = (w: TestWorld, username: string) =>
  w.db.select().from(t.users).where(eq(t.users.username, username)).get()!;

describe('looking the account up', () => {
  it('accepts a username and an e-mail that name the same active account, in any case', () => {
    const { w } = world();
    const r = lookUpAccount(w.db, {
      username: 'Developer',
      email: 'DEV@example.test',
      expectRole: 'developer',
    });
    expect(r.problem).toBeNull();
    expect(r.account).toMatchObject({
      id: row(w, 'developer').id,
      role: 'developer',
      status: 'active',
    });
  });

  it('stops when the username and the e-mail belong to different accounts', () => {
    const { w } = world();
    const r = lookUpAccount(w.db, { username: 'developer', email: 'ada@example.test' });
    expect(r.account).toBeNull();
    expect(r.problem).toMatch(/DIFFERENT accounts/);
    expect(r.byUsername?.id).not.toBe(r.byEmail?.id);
  });

  it('stops when either value is unknown', () => {
    const { w } = world();
    expect(lookUpAccount(w.db, { username: 'nobody', email: 'dev@example.test' }).problem).toMatch(
      /No account has the username/,
    );
    expect(lookUpAccount(w.db, { username: 'developer', email: 'x@example.test' }).problem).toMatch(
      /No account is registered/,
    );
  });

  it('stops when the role is not the expected one', () => {
    const { w } = world();
    const r = lookUpAccount(w.db, {
      username: 'ada',
      email: 'ada@example.test',
      expectRole: 'developer',
    });
    expect(r.account).toBeNull();
    expect(r.problem).toMatch(/role member, not developer/);
  });

  it('stops for an account that is not active', () => {
    const { w } = world();
    w.db.update(t.users).set({ status: 'deleted' }).where(eq(t.users.username, 'developer')).run();
    expect(
      lookUpAccount(w.db, { username: 'developer', email: 'dev@example.test' }).problem,
    ).toMatch(/not active/);
  });
});

describe('resetting the password', () => {
  it('changes only the password, ends every session and every outstanding reset link', async () => {
    const { w, app } = world();
    // Two live sessions for the developer, one for someone else.
    await loginAs(app, 'developer');
    const devSession = await loginAs(app, 'developer');
    const adaSession = await loginAs(app, 'ada');
    // Two outstanding reset links for the developer (the second supersedes the first).
    for (let i = 0; i < 2; i++)
      await app.request('/api/auth/password/forgot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'dev@example.test' }),
      });
    const before = row(w, 'developer');
    const adaBefore = row(w, 'ada');
    const password = freshPassword();

    const outcome = resetAccountPassword(w.db, { userId: before.id, password, now: Date.now() });
    expect(outcome.sessionsRevoked).toBe(2);
    expect(outcome.resetTokensInvalidated).toBe(1);

    const v = verifyReset(w.db, before, password);
    expect(v).toEqual({
      sameId: true,
      sameUsername: true,
      sameEmail: true,
      active: true,
      sameRole: true,
      hashChanged: true,
      newPasswordVerifies: true,
      sessionsRemaining: 0,
      outstandingResetTokens: 0,
    });
    const after = row(w, 'developer');
    expect(after.role).toBe('developer');
    expect(after.roleGrantedAt).toBe(before.roleGrantedAt);
    expect(verifyPassword(password, before.passwordHash)).toBe(false);

    // The old session is gone; the old password no longer signs in; the new one does.
    const me = await app.request('/api/auth/me', {
      headers: { authorization: `Bearer ${devSession.token}` },
    });
    expect(me.status).toBe(401);
    await expect(loginAs(app, 'developer')).rejects.toThrow();
    await expect(loginAs(app, 'developer', password)).resolves.toBeDefined();

    // Nobody else was touched.
    expect(row(w, 'ada')).toEqual(adaBefore);
    const adaMe = await app.request('/api/auth/me', {
      headers: { authorization: `Bearer ${adaSession.token}` },
    });
    expect(adaMe.status).toBe(200);
    const outstanding = w.db
      .select()
      .from(t.passwordResets)
      .where(and(eq(t.passwordResets.userId, before.id), isNull(t.passwordResets.invalidatedAt)))
      .all();
    expect(outstanding).toHaveLength(0);
  });

  it('refuses a password the product would refuse, changing nothing', () => {
    const { w } = world();
    const before = row(w, 'developer');
    expect(() =>
      resetAccountPassword(w.db, { userId: before.id, password: 'short', now: Date.now() }),
    ).toThrow(/at least 8/);
    expect(() =>
      resetAccountPassword(w.db, { userId: before.id, password: 'Developer', now: Date.now() }),
    ).toThrow(/same as the username/);
    expect(row(w, 'developer')).toEqual(before);
  });

  it('refuses an account that is not active', () => {
    const { w } = world();
    const before = row(w, 'developer');
    w.db.update(t.users).set({ status: 'deleted' }).where(eq(t.users.id, before.id)).run();
    expect(() =>
      resetAccountPassword(w.db, { userId: before.id, password: freshPassword(), now: Date.now() }),
    ).toThrow(/not active/);
    expect(row(w, 'developer').passwordHash).toBe(before.passwordHash);
  });
});
