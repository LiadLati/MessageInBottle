import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { LOGIN_PER_ACCOUNT, REGISTER_PER_ADDRESS } from './routes/auth.js';
import { MIGRATIONS_FOLDER, createDb, runMigrations } from '../db/client.js';
import * as t from '../db/schema.js';
import { DEV_SEED_PASSWORD } from '../db/seed-data.js';
import { seedChart, seedUsers } from '../db/seed.js';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../lib/password.js';
import { T0, createTestWorld, loginAs, releaseInput, testConfig } from '../test/harness.js';

type App = ReturnType<typeof createApp>;
const json = (body: unknown, token?: string) => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});
const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const register = (
  app: App,
  username: string,
  password: string,
  extra: Record<string, string> = {},
) =>
  app.request('/api/auth/register', {
    ...json({ username, password }),
    headers: { 'content-type': 'application/json', ...extra },
  });
const login = (app: App, username: string, password: string, extra: Record<string, string> = {}) =>
  app.request('/api/auth/login', {
    ...json({ username, password }),
    headers: { 'content-type': 'application/json', ...extra },
  });

describe('registration', () => {
  it('creates an account, signs it in and never exposes the password', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const res = await register(app, 'Nell_7', 'a long enough password');
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; user: Record<string, unknown> };
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof body.user.id).toBe('string');
    expect(body.user).toMatchObject({ username: 'nell_7', displayName: 'Nell_7', shoreId: null });
    expect(JSON.stringify(body)).not.toContain('password');

    const me = await app.request('/api/auth/me', bearer(body.token));
    expect(me.status).toBe(200);
    expect(JSON.stringify(await me.json())).not.toContain('password');

    const row = w.db.select().from(t.users).where(eq(t.users.username, 'nell_7')).get()!;
    expect(row.passwordHash).toMatch(/^scrypt\$N=\d+,r=\d+,p=\d+\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(row.passwordHash).not.toContain('a long enough password');
    expect(row.passwordUpdatedAt).toBe(T0);
    // The session token itself is stored only as a hash.
    const sessions = w.db.select().from(t.sessions).where(eq(t.sessions.userId, row.id)).all();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.tokenHash).not.toBe(body.token);
  });

  it('rejects duplicate usernames case-insensitively and ignores surrounding spaces', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    expect((await register(app, 'Marin', 'password-one')).status).toBe(201);
    for (const dup of ['marin', 'MARIN', ' Marin ', 'mArIn']) {
      const res = await register(app, dup, 'password-two');
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('username_taken');
    }
    // Seeded accounts are protected the same way.
    expect((await register(app, 'ADA', 'password-two')).status).toBe(409);
    expect(w.db.select().from(t.users).where(eq(t.users.username, 'marin')).all()).toHaveLength(1);
  });

  it('validates credentials without echoing them back', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const short = await register(app, 'quill', 'short');
    expect(short.status).toBe(400);
    const text = await short.text();
    expect(text).toContain('validation');
    expect(text).not.toContain('short"');
    expect((await register(app, 'bad name!', 'long enough password')).status).toBe(400);
    expect((await register(app, 'q', 'long enough password')).status).toBe(400);
    expect((await app.request('/api/auth/register', json({ username: 'quill' }))).status).toBe(400);
    expect(w.db.select().from(t.users).where(eq(t.users.username, 'quill')).get()).toBeUndefined();
  });
});

describe('password hashing', () => {
  it('salts every hash and verifies in constant shape', () => {
    const a = hashPassword('same password');
    const b = hashPassword('same password');
    expect(a).not.toBe(b);
    expect(verifyPassword('same password', a)).toBe(true);
    expect(verifyPassword('same password', b)).toBe(true);
    expect(verifyPassword('Same password', a)).toBe(false);
    expect(verifyPassword('same password', null)).toBe(false);
    expect(verifyPassword('same password', 'garbage')).toBe(false);
    expect(verifyPassword('not-a-real-password', DUMMY_PASSWORD_HASH)).toBe(true);
    expect(verifyPassword('', DUMMY_PASSWORD_HASH)).toBe(false);
  });
});

describe('sign-in', () => {
  it('requires both fields and answers wrong passwords and unknown users identically', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    await register(app, 'petra', 'petra-secret-1');
    expect((await app.request('/api/auth/login', json({ username: 'petra' }))).status).toBe(400);
    expect(
      (await app.request('/api/auth/login', json({ password: 'petra-secret-1' }))).status,
    ).toBe(400);

    const wrong = await login(app, 'petra', 'petra-secret-2');
    const unknown = await login(app, 'nobody_here', 'petra-secret-1');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.text()).toBe(await unknown.text());

    const ok = await login(app, ' PETRA ', 'petra-secret-1');
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { user: { username: string } }).user.username).toBe('petra');
  });

  it('signs seeded development accounts in with the documented dev password only', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    expect((await login(app, 'ada', DEV_SEED_PASSWORD)).status).toBe(200);
    expect((await login(app, 'ada', 'ada')).status).toBe(401);
    expect((await login(app, 'ada', '')).status).toBe(400);
    // The old username-only development sign-in no longer exists.
    expect((await app.request('/api/auth/dev-login', json({ username: 'ada' }))).status).toBe(404);
  });

  it('never signs in an account that has no password', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    w.db
      .insert(t.users)
      .values({ id: 'usr_legacy', username: 'legacy', displayName: 'Legacy', createdAt: T0 })
      .run();
    expect((await login(app, 'legacy', '')).status).toBe(400);
    expect((await login(app, 'legacy', 'anything at all')).status).toBe(401);
    expect((await login(app, 'legacy', DEV_SEED_PASSWORD)).status).toBe(401);
  });
});

describe('sessions', () => {
  it('persists across requests until the token expires', async () => {
    const w = createTestWorld({ sessionTtlMs: 60 * 60 * 1000 });
    const app = createApp(w.ctx);
    const { token } = await loginAs(app, 'bo');
    expect((await app.request('/api/auth/me', bearer(token))).status).toBe(200);
    expect((await app.request('/api/friends', bearer(token))).status).toBe(200);
    w.clock.advance(59 * 60 * 1000);
    expect((await app.request('/api/auth/me', bearer(token))).status).toBe(200);
    w.clock.advance(2 * 60 * 1000);
    expect((await app.request('/api/auth/me', bearer(token))).status).toBe(401);
  });

  it('signs out safely: the token dies, other sessions and the account survive', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const phone = await loginAs(app, 'cy');
    const laptop = await loginAs(app, 'cy');
    expect(
      (await app.request('/api/auth/logout', { method: 'POST', ...bearer(phone.token) })).status,
    ).toBe(204);
    expect((await app.request('/api/auth/me', bearer(phone.token))).status).toBe(401);
    expect(
      (await app.request('/api/auth/logout', { method: 'POST', ...bearer(phone.token) })).status,
    ).toBe(401);
    expect((await app.request('/api/auth/me', bearer(laptop.token))).status).toBe(200);
    expect((await login(app, 'cy', DEV_SEED_PASSWORD)).status).toBe(200);
    expect((await app.request('/api/auth/logout', { method: 'POST' })).status).toBe(401);
  });
});

describe('authorization with registered accounts', () => {
  it('lets each user see only their own side of a journey', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const sender = (await (await register(app, 'sender_one', 'sender password')).json()) as {
      token: string;
      user: { id: string };
    };
    const other = (await (await register(app, 'other_two', 'other password')).json()) as {
      token: string;
      user: { id: string };
    };
    const bo = await loginAs(app, 'bo');

    // Fresh accounts have no friends: nothing can be sent yet and nothing is visible.
    const preview = await app.request(
      '/api/bottles/preview',
      json({ recipientId: bo.id }, sender.token),
    );
    expect(preview.status).toBe(200);
    expect(((await preview.json()) as { eligible: boolean }).eligible).toBe(false);

    // Befriend bo through the real flow, then release.
    expect(
      (await app.request('/api/friends/requests', json({ username: 'bo' }, sender.token))).status,
    ).toBe(204);
    const boFriends = (await (await app.request('/api/friends', bearer(bo.token))).json()) as {
      incomingRequests: Array<{ id: string }>;
    };
    const reqId = boFriends.incomingRequests[0]!.id;
    expect(
      (
        await app.request(`/api/friends/requests/${reqId}/accept`, {
          method: 'POST',
          ...bearer(bo.token),
        })
      ).status,
    ).toBe(204);
    w.db
      .update(t.users)
      .set({ shoreId: 'shore_heron_reach' })
      .where(eq(t.users.id, sender.user.id))
      .run();
    const release = await app.request(
      '/api/bottles/release',
      json(releaseInput(bo.id, 'auth-key-00001'), sender.token),
    );
    expect(release.status).toBe(201);
    const { bottle } = (await release.json()) as { bottle: { id: string } };

    // The other registered user sees nothing about it anywhere.
    expect((await app.request(`/api/bottles/sent/${bottle.id}`, bearer(other.token))).status).toBe(
      404,
    );
    expect(
      (
        await app.request(`/api/shore/bottles/${bottle.id}/open`, {
          method: 'POST',
          ...bearer(other.token),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        (await (await app.request('/api/bottles/sent', bearer(other.token))).json()) as {
          bottles: unknown[];
        }
      ).bottles,
    ).toEqual([]);
    expect(
      (
        (await (await app.request('/api/shore', bearer(other.token))).json()) as {
          bottles: unknown[];
        }
      ).bottles,
    ).toEqual([]);
    // The recipient cannot see the bottle before it arrives, and cannot read the sender's passport.
    expect(
      ((await (await app.request('/api/shore', bearer(bo.token))).json()) as { bottles: unknown[] })
        .bottles,
    ).toEqual([]);
    expect((await app.request(`/api/bottles/sent/${bottle.id}`, bearer(bo.token))).status).toBe(
      404,
    );
    // The sender can.
    expect((await app.request(`/api/bottles/sent/${bottle.id}`, bearer(sender.token))).status).toBe(
      200,
    );
  });
});

describe('rate limiting', () => {
  it('locks an account after repeated failed sign-ins and clears on success', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    for (let i = 0; i < LOGIN_PER_ACCOUNT.limit; i++) {
      expect((await login(app, 'ada', 'wrong password')).status).toBe(401);
    }
    const blocked = await login(app, 'ada', DEV_SEED_PASSWORD);
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as {
      error: { code: string; details: { retryAfterSeconds: number } };
    };
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    // Other accounts from the same address are still within their budget.
    expect((await login(app, 'bo', DEV_SEED_PASSWORD)).status).toBe(200);
  });

  it('limits registrations per client address', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const from = { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' };
    for (let i = 0; i < REGISTER_PER_ADDRESS.limit; i++) {
      expect((await register(app, `burst_${i}`, 'burst password')).status).toBe(201);
    }
    expect((await register(app, 'burst_more', 'burst password')).status).toBe(429);
    expect((await register(app, 'burst_other', 'burst password', from)).status).toBe(201);
  });
});

describe('migration compatibility', () => {
  it('upgrades a database created before authentication without losing users', async () => {
    // Replay only the migrations that existed before this feature, as an older deployment would.
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mib-legacy-migrations-'));
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as {
      entries: Array<{ tag: string }>;
    };
    const legacyEntries = journal.entries.filter((e) => !e.tag.includes('auth_credentials'));
    expect(legacyEntries.length).toBe(journal.entries.length - 1);
    fs.mkdirSync(path.join(legacyDir, 'meta'));
    fs.writeFileSync(
      path.join(legacyDir, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: legacyEntries }),
    );
    for (const e of legacyEntries)
      fs.copyFileSync(
        path.join(MIGRATIONS_FOLDER, `${e.tag}.sql`),
        path.join(legacyDir, `${e.tag}.sql`),
      );

    const { db, sqlite } = createDb(':memory:');
    runMigrations(db, legacyDir);
    const config = testConfig();
    seedChart(db, config.defaultShoreCapacity, T0);
    sqlite
      .prepare(
        "INSERT INTO users (id, username, display_name, shore_id, status, created_at) VALUES ('usr_old', 'oldtimer', 'Oldtimer', 'shore_lantern_cove', 'active', ?)",
      )
      .run(T0);
    expect(
      sqlite
        .prepare('PRAGMA table_info(users)')
        .all()
        .map((c) => (c as { name: string }).name),
    ).not.toContain('password_hash');

    // Upgrade in place: only the new migration runs, existing rows keep their data.
    runMigrations(db);
    const columns = sqlite
      .prepare('PRAGMA table_info(users)')
      .all()
      .map((c) => (c as { name: string }).name);
    expect(columns).toEqual(expect.arrayContaining(['password_hash', 'password_updated_at']));
    const old = db.select().from(t.users).where(eq(t.users.id, 'usr_old')).get()!;
    expect(old.username).toBe('oldtimer');
    expect(old.shoreId).toBe('shore_lantern_cove');
    expect(old.passwordHash).toBeNull();

    // The upgraded database serves the new API: old accounts cannot sign in until they get a
    // password, new accounts register normally, and the dev seed backfills only seed accounts.
    const w = createTestWorld();
    const app = createApp({ db, clock: w.clock, config });
    expect((await login(app, 'oldtimer', 'anything long enough')).status).toBe(401);
    expect((await register(app, 'newcomer', 'newcomer password')).status).toBe(201);
    seedUsers(db, T0);
    expect((await login(app, 'ada', DEV_SEED_PASSWORD)).status).toBe(200);
    expect(
      db.select().from(t.users).where(eq(t.users.id, 'usr_old')).get()!.passwordHash,
    ).toBeNull();
    // Re-seeding never rewrites an existing password.
    const adaHash = db.select().from(t.users).where(eq(t.users.username, 'ada')).get()!
      .passwordHash;
    seedUsers(db, T0 + 1);
    expect(db.select().from(t.users).where(eq(t.users.username, 'ada')).get()!.passwordHash).toBe(
      adaHash,
    );
    fs.rmSync(legacyDir, { recursive: true, force: true });
  });
});
