import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { POLICY_DOCUMENTS, currentPolicyVersions } from '@mib/shared';
import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import * as t from '../db/schema.js';
import { DEV_SEED_PASSWORD, SEED_USERS } from '../db/seed-data.js';
import { prepareDatabase } from '../db/seed.js';
import { OutboxMailer } from '../lib/mail.js';
import { SystemClock } from '../lib/clock.js';
import { createApp } from './app.js';
import { devRoutes } from './routes/dev.js';
import { createTestWorld, loginAs, makeDeveloper, type TestWorld } from '../test/harness.js';

// Regression tests for audit finding DEPLOY-001 (ARCH-001 / SEC-001 / QA-002). The audited
// chain was: POST /api/auth/password/forgot for a victim → GET /api/dev/outbox with no
// credentials, which returned the reset link → POST /api/auth/password/reset → sign in as the
// victim. It worked because development mode was the default and the outbox was registered in
// front of the dev router's authentication.

// Every route the dev router defines, read from the router itself so a new control cannot be
// added without being covered here.
const DEV_ROUTES = devRoutes()
  .routes.filter((r) => r.method !== 'ALL')
  .map((r) => ({ method: r.method, path: `/api/dev${r.path}` }));

const json = (token?: string, extra: Record<string, string> = {}) => ({
  'content-type': 'application/json',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
  ...extra,
});

// Seeded development accounts predate e-mail and have none; give them one so they can recover.
function giveEmails(w: TestWorld) {
  for (const username of ['ada', 'bo', 'cy', 'dee'])
    w.db
      .update(t.users)
      .set({ email: `${username}@example.test` })
      .where(eq(t.users.id, w.user(username).id))
      .run();
}

function setRole(w: TestWorld, username: string, role: 'admin' | 'developer') {
  if (role === 'developer') return makeDeveloper(w, username);
  w.db
    .update(t.users)
    .set({ role })
    .where(eq(t.users.id, w.user(username).id))
    .run();
}

async function devWorld() {
  const w = createTestWorld({ devMode: true });
  giveEmails(w);
  const app = createApp(w.ctx);
  setRole(w, 'bo', 'developer');
  setRole(w, 'cy', 'admin');
  return {
    w,
    app,
    member: await loginAs(app, 'ada'),
    developer: await loginAs(app, 'bo'),
    admin: await loginAs(app, 'cy'),
  };
}

async function productionWorld() {
  const w = createTestWorld({
    devMode: false,
    mail: { ...createTestWorld().ctx.config.mail, provider: 'disabled' },
  });
  giveEmails(w);
  const app = createApp(w.ctx);
  setRole(w, 'bo', 'developer');
  setRole(w, 'cy', 'admin');
  return {
    w,
    app,
    member: await loginAs(app, 'ada'),
    developer: await loginAs(app, 'bo'),
    admin: await loginAs(app, 'cy'),
  };
}

const request = (
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  token?: string,
  headers: Record<string, string> = {},
) =>
  app.request(path, {
    method,
    headers: json(token, headers),
    ...(method === 'POST' ? { body: '{}' } : {}),
  });

describe('the dev router covers what it should', () => {
  it('knows every development route', () => {
    expect(DEV_ROUTES.map((r) => `${r.method} ${r.path}`)).toEqual(
      expect.arrayContaining([
        'GET /api/dev/outbox',
        'GET /api/dev/status',
        'POST /api/dev/advance',
        'POST /api/dev/arrive',
        'POST /api/dev/lose',
        'POST /api/dev/tick',
        'POST /api/dev/forget-policy-acceptances',
      ]),
    );
  });
});

describe('in production the development surface does not exist', () => {
  it('answers 404 on every /api/dev route, for everyone, including a developer', async () => {
    const { app, member, developer, admin } = await productionWorld();
    for (const { method, path } of DEV_ROUTES)
      for (const [who, token] of [
        ['anonymous', undefined],
        ['member', member.token],
        ['admin', admin.token],
        ['developer', developer.token],
      ] as const) {
        const res = await request(app, method, path, token);
        expect(res.status, `${who} ${method} ${path}`).toBe(404);
      }
  });

  it('omits development details from the health check', async () => {
    const { app } = await productionWorld();
    const body = (await (await app.request('/api/health')).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('devMode');
    expect(body).not.toHaveProperty('mail');
  });
});

describe('in development mode the outbox requires a developer', () => {
  it('refuses an anonymous reader with 401', async () => {
    const { app } = await devWorld();
    expect((await app.request('/api/dev/outbox')).status).toBe(401);
  });

  it('refuses a member with 403', async () => {
    const { app, member } = await devWorld();
    expect((await request(app, 'GET', '/api/dev/outbox', member.token)).status).toBe(403);
  });

  it('refuses an administrator with 403', async () => {
    const { app, admin } = await devWorld();
    expect((await request(app, 'GET', '/api/dev/outbox', admin.token)).status).toBe(403);
  });

  it('lets a developer read it', async () => {
    const { app, developer } = await devWorld();
    const res = await request(app, 'GET', '/api/dev/outbox', developer.token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { provider: string }).provider).toBe('outbox');
  });

  it('gives every other control the same gate', async () => {
    const { app, member, admin } = await devWorld();
    for (const { method, path } of DEV_ROUTES) {
      expect((await request(app, method, path)).status, `anon ${path}`).toBe(401);
      expect((await request(app, method, path, member.token)).status, `member ${path}`).toBe(403);
      expect((await request(app, method, path, admin.token)).status, `admin ${path}`).toBe(403);
    }
  });

  it('gives a developer no moderation authority', async () => {
    const { app, developer } = await devWorld();
    for (const path of ['/api/admin/reports', '/api/admin/appeals'])
      expect((await request(app, 'GET', path, developer.token)).status).toBe(403);
  });
});

describe('a role cannot be claimed by the client', () => {
  it('ignores role headers, query parameters and body fields on the dev routes', async () => {
    const { app, member, admin } = await devWorld();
    const spoof = {
      'x-role': 'developer',
      'x-user-role': 'developer',
      'x-mib-role': 'developer',
      'x-developer': 'true',
    };
    for (const token of [undefined, member.token, admin.token]) {
      const expected = token ? 403 : 401;
      expect(
        (await request(app, 'GET', '/api/dev/outbox?role=developer', token, spoof)).status,
      ).toBe(expected);
      const res = await app.request('/api/dev/tick?role=developer', {
        method: 'POST',
        headers: json(token, spoof),
        body: JSON.stringify({ role: 'developer', user: { role: 'developer' } }),
      });
      expect(res.status).toBe(expected);
    }
  });

  it('never takes a role from the registration body', async () => {
    const { app, w } = await devWorld();
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: json(undefined, { 'x-role': 'developer' }),
      body: JSON.stringify({
        username: 'claimant',
        email: 'claimant@example.test',
        password: 'a-long-enough-password',
        role: 'developer',
        policies: {
          acceptTerms: true,
          acceptGuidelines: true,
          acknowledgePrivacy: true,
          versions: currentPolicyVersions(POLICY_DOCUMENTS),
        },
      }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { user: { role: string } }).user.role).toBe('member');
    expect(w.user('claimant').role).toBe('member');
  });
});

describe('the audited account-takeover chain is closed', () => {
  async function attempt(app: ReturnType<typeof createApp>, w: TestWorld, attacker?: string) {
    const victim = w.user('ada');
    const forgot = await app.request('/api/auth/password/forgot', {
      method: 'POST',
      headers: json(),
      body: JSON.stringify({ email: victim.email }),
    });
    expect(forgot.status).toBe(202);

    // Step 2 of the chain: read the reset link without developer authorisation.
    const read = await request(app, 'GET', '/api/dev/outbox', attacker);
    const text = await read.text();
    expect([401, 403, 404]).toContain(read.status);
    expect(text).not.toMatch(/reset=/);
    expect(text).not.toContain(victim.email!);

    // Step 3: without the leaked token there is nothing to reset with.
    const reset = await app.request('/api/auth/password/reset', {
      method: 'POST',
      headers: json(),
      body: JSON.stringify({ token: 'a'.repeat(64), password: 'attacker-chosen-password' }),
    });
    expect(reset.status).toBe(400);
    // The victim keeps their account.
    await expect(loginAs(app, 'ada')).resolves.toBeDefined();
    await expect(loginAs(app, 'ada', 'attacker-chosen-password')).rejects.toThrow();
  }

  it('fails in development mode for an anonymous attacker', async () => {
    const { app, w } = await devWorld();
    await attempt(app, w);
  });

  it('fails in development mode for a signed-in member', async () => {
    const { app, w } = await devWorld();
    await attempt(app, w, (await loginAs(app, 'dee')).token);
  });

  it('fails in development mode for an administrator', async () => {
    const { app, w, admin } = await devWorld();
    await attempt(app, w, admin.token);
  });

  it('fails in production for everyone', async () => {
    const { app, w, member, developer } = await productionWorld();
    await attempt(app, w);
    await attempt(app, w, member.token);
    await attempt(app, w, developer.token);
  });
});

describe('a clean production database has no development accounts', () => {
  it('creates none on start, so the published development password signs nobody in', async () => {
    const config = loadConfig(
      { MIB_DATABASE_PATH: '/var/lib/seayou/seayou.sqlite' },
      { productionBuild: true },
    );
    expect(config.devMode).toBe(false);
    const { db } = createDb(':memory:');
    prepareDatabase(db, config, Date.now());
    expect(db.select().from(t.users).all()).toHaveLength(0);
    expect(db.select().from(t.shores).all().length).toBeGreaterThan(0);

    const app = createApp({
      db,
      clock: new SystemClock(),
      realClock: new SystemClock(),
      config: { ...config, databasePath: ':memory:', logRequests: false },
      mailer: new OutboxMailer(() => Date.now()),
    });
    for (const { username } of SEED_USERS) {
      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: json(),
        body: JSON.stringify({ username, password: DEV_SEED_PASSWORD }),
      });
      expect(res.status, username).toBe(401);
    }
  });

  it('creates them only in explicit development mode', () => {
    const { db } = createDb(':memory:');
    prepareDatabase(db, loadConfig({ MIB_DEV_MODE: 'true' }), Date.now());
    expect(db.select().from(t.users).all().length).toBe(SEED_USERS.length);
  });
});

describe('a real developer can still work in development mode', () => {
  it('reads a captured reset link for their own account and uses it', async () => {
    const { app, w, developer } = await devWorld();
    const me = w.user('bo');
    expect(
      (
        await app.request('/api/auth/password/forgot', {
          method: 'POST',
          headers: json(),
          body: JSON.stringify({ email: me.email }),
        })
      ).status,
    ).toBe(202);
    const outbox = (await (
      await request(app, 'GET', '/api/dev/outbox', developer.token)
    ).json()) as {
      messages: Array<{ to: string; text: string }>;
    };
    const mail = outbox.messages.find((m) => m.to === me.email);
    const token = /reset=([a-f0-9]+)/.exec(mail?.text ?? '')?.[1];
    expect(token).toBeTruthy();
    const reset = await app.request('/api/auth/password/reset', {
      method: 'POST',
      headers: json(),
      body: JSON.stringify({ token, password: 'a-brand-new-password' }),
    });
    expect(reset.status).toBe(204);
    await expect(loginAs(app, 'bo', 'a-brand-new-password')).resolves.toBeDefined();
  });

  it('uses the simulation controls', async () => {
    const { app, developer } = await devWorld();
    const status = await request(app, 'GET', '/api/dev/status', developer.token);
    expect(status.status).toBe(200);
    expect(((await status.json()) as { devMode: boolean }).devMode).toBe(true);
    expect((await request(app, 'POST', '/api/dev/tick', developer.token)).status).toBe(200);
    // /advance needs the persisted DevClock the real server uses; the harness drives a manual
    // clock, so here it answers the documented `dev_only` refusal rather than 401/403.
    const advance = await app.request('/api/dev/advance', {
      method: 'POST',
      headers: json(developer.token),
      body: JSON.stringify({ ms: 60_000 }),
    });
    expect(advance.status).toBe(400);
    expect(((await advance.json()) as { error: { code: string } }).error.code).toBe('dev_only');
  });
});
