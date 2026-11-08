import { afterEach, describe, expect, it } from 'vitest';
import * as t from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { createApp } from '../http/app.js';
import { createTestWorld, loginAs } from '../test/harness.js';
import {
  DEFAULT_SCRYPT_N,
  PasswordHashingBusyError,
  hashPassword,
  hashPasswordAsync,
  setPasswordHashCost,
  verifyPasswordAsync,
} from './password.js';

const TEST_N = 2 ** 14;
afterEach(() => {
  setPasswordHashCost(TEST_N);
});
const costOf = (hash: string) => Number(/N=(\d+)/.exec(hash)?.[1]);

describe('password storage cost (SEC-007)', () => {
  it('hashes at 2^16 in production', () => {
    expect(DEFAULT_SCRYPT_N).toBe(65536);
    setPasswordHashCost(DEFAULT_SCRYPT_N);
    expect(costOf(hashPassword('a production password'))).toBe(65536);
  });

  it('still verifies hashes made at an older cost, and says they need upgrading', async () => {
    const old = hashPassword('an old password'); // made at the test cost, 2^14
    setPasswordHashCost(2 ** 15);
    expect(await verifyPasswordAsync('an old password', old)).toEqual({
      ok: true,
      needsRehash: true,
    });
    expect(await verifyPasswordAsync('the wrong one', old)).toEqual({
      ok: false,
      needsRehash: false,
    });
    const current = await hashPasswordAsync('a new password');
    expect(await verifyPasswordAsync('a new password', current)).toEqual({
      ok: true,
      needsRehash: false,
    });
  });

  it('upgrades the stored hash on the next successful sign-in', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const before = w.db.select().from(t.users).where(eq(t.users.username, 'ada')).get()!;
    expect(costOf(before.passwordHash!)).toBe(TEST_N);
    setPasswordHashCost(2 ** 15);
    await loginAs(app, 'ada');
    const after = w.db.select().from(t.users).where(eq(t.users.username, 'ada')).get()!;
    expect(costOf(after.passwordHash!)).toBe(2 ** 15);
    // And the upgraded hash still signs the same password in.
    await expect(loginAs(app, 'ada')).resolves.toBeDefined();
  });
});

describe('password hashing never blocks the API (SEC-006)', () => {
  // Counted, not timed (audit QA-R-007): the event loop must keep turning while hashes are in
  // flight. Synchronous scrypt finished every hash before the loop could turn even once.
  it('keeps the event loop responsive while hashes run', async () => {
    let finished = false;
    let turnsWhileHashing = 0;
    const spin = (async () => {
      while (!finished) {
        await new Promise((resolve) => setImmediate(resolve));
        if (!finished) turnsWhileHashing++;
      }
    })();
    const work = Array.from({ length: 8 }, (_, i) => hashPasswordAsync(`password number ${i}`));
    await Promise.all(work);
    finished = true;
    await spin;
    expect(turnsWhileHashing).toBeGreaterThan(8);
  });

  it('refuses new work once the bounded queue is full', async () => {
    // One hash, reused: hashing 69 times synchronously first made the test slow under load.
    const stored = hashPassword('x');
    const attempts = Array.from({ length: 2 + 64 + 3 }, () =>
      verifyPasswordAsync('x', stored).then(
        () => 'done',
        (err: unknown) => (err instanceof PasswordHashingBusyError ? 'busy' : 'error'),
      ),
    );
    const outcomes = await Promise.all(attempts);
    expect(outcomes.filter((o) => o === 'busy').length).toBeGreaterThan(0);
    expect(outcomes).not.toContain('error');
  });
});
