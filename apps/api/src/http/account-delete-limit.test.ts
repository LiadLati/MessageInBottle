import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DeletionModule from '../services/deletion.js';
import { DEV_SEED_PASSWORD } from '../db/seed-data.js';
import { acceptCurrent, createTestWorld, loginAs } from '../test/harness.js';
import { createApp } from './app.js';
import { DELETE_PER_ACCOUNT, DELETE_PER_ADDRESS } from './routes/account.js';

// Audit SEC-R-001: confirming account deletion checks a password, and every password check waits
// in the one bounded hashing queue sign-in, registration and reset share. Attempts are counted
// per account and per client address *before* the password is checked, and refused with 429.

// Counts how many requests actually reach password verification.
const verified = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../services/deletion.js', async (actual) => {
  const real = await actual<typeof DeletionModule>();
  return {
    ...real,
    verifyAccountPassword: (...args: Parameters<typeof real.verifyAccountPassword>) => {
      verified.calls++;
      return real.verifyAccountPassword(...args);
    },
  };
});

beforeEach(() => {
  verified.calls = 0;
});

// The harness trusts one proxy hop: the client address is the right-most X-Forwarded-For entry.
const del = (
  app: ReturnType<typeof createApp>,
  token: string,
  password: string,
  xff = '198.51.100.7',
) =>
  app.request('/api/account/delete', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-forwarded-for': xff,
    },
    body: JSON.stringify({ password, confirm: true }),
  });

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown, xff?: string) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(xff ? { 'x-forwarded-for': xff } : {}) },
    body: JSON.stringify(body),
  });

describe('POST /api/account/delete is rate-limited before the password is checked', () => {
  it('lets attempts within the budget reach verification and refuses the rest with 429 before it', async () => {
    const app = createApp(createTestWorld().ctx);
    const ada = await loginAs(app, 'ada');
    const statuses: number[] = [];
    for (let i = 0; i < DELETE_PER_ACCOUNT.limit + 3; i++)
      statuses.push((await del(app, ada.token, 'wrong password')).status);
    expect(statuses.slice(0, DELETE_PER_ACCOUNT.limit)).toEqual(
      Array(DELETE_PER_ACCOUNT.limit).fill(401),
    );
    expect(statuses.slice(DELETE_PER_ACCOUNT.limit)).toEqual([429, 429, 429]);
    // Only the attempts inside the budget cost a password check.
    expect(verified.calls).toBe(DELETE_PER_ACCOUNT.limit);

    // Past the budget the answer is the same with the right password: it reveals nothing, and
    // the account is still there.
    const right = await del(app, ada.token, DEV_SEED_PASSWORD);
    expect(right.status).toBe(429);
    const body = (await right.json()) as { error: { code: string } };
    expect(body.error.code).toBe('rate_limited');
    expect(verified.calls).toBe(DELETE_PER_ACCOUNT.limit);
    const me = await app.request('/api/auth/me', {
      headers: { authorization: `Bearer ${ada.token}` },
    });
    expect(me.status).toBe(200);
  });

  it('counts the account budget across addresses, and the address budget across accounts', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const ada = await loginAs(app, 'ada');
    // The account budget follows the account, whatever address it comes from.
    for (let i = 0; i < DELETE_PER_ACCOUNT.limit; i++)
      expect((await del(app, ada.token, 'wrong password', `203.0.113.${i + 1}`)).status).toBe(401);
    expect((await del(app, ada.token, 'wrong password', '203.0.113.200')).status).toBe(429);

    // The address budget follows the address, whichever accounts use it. Two fresh accounts
    // share one address: together they may spend exactly the address budget, each staying
    // within its own account budget.
    const shared = '192.0.2.50';
    const bo = await loginAs(app, 'bo');
    const cy = await loginAs(app, 'cy');
    const perAccount = DELETE_PER_ADDRESS.limit / 2;
    expect(perAccount).toBeLessThanOrEqual(DELETE_PER_ACCOUNT.limit);
    for (let i = 0; i < perAccount; i++) {
      expect((await del(app, bo.token, 'wrong password', shared)).status).toBe(401);
      expect((await del(app, cy.token, 'wrong password', shared)).status).toBe(401);
    }
    const dee = await loginAs(app, 'dee');
    expect((await del(app, dee.token, 'wrong password', shared)).status).toBe(429);
    // The same account from another address is still within its own budget.
    expect((await del(app, dee.token, 'wrong password', '192.0.2.51')).status).toBe(401);
  });

  it('cannot be bypassed by forging the left-most X-Forwarded-For entry', async () => {
    const w = createTestWorld({ trustProxy: true, trustedProxyHops: 1 });
    const app = createApp(w.ctx);
    const real = '198.51.100.99';
    const tokens = [await loginAs(app, 'ada'), await loginAs(app, 'bo'), await loginAs(app, 'cy')];
    let spent = 0;
    for (const t of tokens)
      for (
        let i = 0;
        i < DELETE_PER_ACCOUNT.limit && spent < DELETE_PER_ADDRESS.limit;
        i++, spent++
      )
        expect((await del(app, t.token, 'wrong password', `10.9.${spent}.1, ${real}`)).status).toBe(
          401,
        );
    const dee = await loginAs(app, 'dee');
    // A new forged client-written entry does not buy a new bucket: the proxy-appended one decides.
    expect((await del(app, dee.token, 'wrong password', `172.16.99.99, ${real}`)).status).toBe(429);
  });

  it('keeps a second account, and sign-in, registration and reset, available during a flood', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const ada = await loginAs(app, 'ada');
    const attacker = '203.0.113.66';
    // One account floods the endpoint concurrently. Without the limit these would all queue for
    // password hashing and push everyone else into 503s.
    const flood = await Promise.all(
      Array.from({ length: 150 }, async () => del(app, ada.token, 'wrong password', attacker)),
    );
    const counts = flood.reduce<Record<number, number>>((m, r) => {
      m[r.status] = (m[r.status] ?? 0) + 1;
      return m;
    }, {});
    expect(counts[503]).toBeUndefined();
    expect(counts[429]).toBe(150 - DELETE_PER_ACCOUNT.limit);
    expect(verified.calls).toBe(DELETE_PER_ACCOUNT.limit);

    const bystander = '198.51.100.20';
    expect(
      (
        await post(
          app,
          '/api/auth/login',
          { username: 'bo', password: DEV_SEED_PASSWORD },
          bystander,
        )
      ).status,
    ).toBe(200);
    const reg = await post(
      app,
      '/api/auth/register',
      {
        username: 'newcomer',
        password: 'a long enough password',
        email: 'newcomer@example.test',
        policies: acceptCurrent(),
      },
      bystander,
    );
    expect(reg.status).toBe(201);
    expect(
      (await post(app, '/api/auth/password/forgot', { email: 'bo@example.test' }, bystander))
        .status,
    ).toBe(202);
    // Another account can still delete itself.
    const cy = await loginAs(app, 'cy');
    expect((await del(app, cy.token, DEV_SEED_PASSWORD, bystander)).status).toBe(200);
  });

  it('still deletes an account whose owner mistyped a few times and then got it right', async () => {
    const app = createApp(createTestWorld().ctx);
    const bo = await loginAs(app, 'bo');
    for (let i = 0; i < DELETE_PER_ACCOUNT.limit - 1; i++)
      expect((await del(app, bo.token, 'wrong password')).status).toBe(401);
    const ok = await del(app, bo.token, DEV_SEED_PASSWORD);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { alreadyDeleted: boolean }).alreadyDeleted).toBe(false);
  });
});
