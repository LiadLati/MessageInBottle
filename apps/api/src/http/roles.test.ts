import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as t from '../db/schema.js';
import { createApp } from './app.js';
import {
  acceptCurrent,
  createTestWorld,
  loginAs as login,
  makeDeveloper,
} from '../test/harness.js';

const auth = (token: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});

// The admin and developer roles are deliberately disjoint. These tests are the proof: an
// administrator must get nothing from the DEV controls, and a developer must get nothing from
// the moderation console — neither by role, nor by asking nicely in a header or a body.
const ADMIN_ROUTES = [
  { method: 'GET', path: '/api/admin/reports' },
  { method: 'GET', path: '/api/admin/appeals' },
  { method: 'POST', path: '/api/admin/reports/cas_whatever/accept' },
  { method: 'POST', path: '/api/admin/reports/cas_whatever/critical' },
  { method: 'POST', path: '/api/admin/reports/cas_whatever/hold' },
];
const DEV_ROUTES = [
  { method: 'GET', path: '/api/dev/status' },
  { method: 'POST', path: '/api/dev/tick' },
  { method: 'POST', path: '/api/dev/advance' },
  { method: 'POST', path: '/api/dev/forget-policy-acceptances' },
];

async function worlds() {
  const w = createTestWorld();
  const app = createApp(w.ctx);
  w.db
    .update(t.users)
    .set({ role: 'admin' })
    .where(eq(t.users.id, w.user('cy').id))
    .run();
  makeDeveloper(w, 'bo');
  return {
    w,
    app,
    member: await login(app, 'ada'),
    developer: await login(app, 'bo'),
    admin: await login(app, 'cy'),
  };
}

describe('admin and developer are separate roles', () => {
  it('lets an administrator into the moderation console', async () => {
    const { app, admin } = await worlds();
    for (const path of ['/api/admin/reports', '/api/admin/appeals'])
      expect((await app.request(path, { headers: auth(admin.token) })).status).toBe(200);
  });

  it('refuses every admin route to a developer and to an ordinary member', async () => {
    const { app, developer, member } = await worlds();
    for (const who of [developer, member])
      for (const r of ADMIN_ROUTES) {
        const res = await app.request(r.path, {
          method: r.method,
          headers: auth(who.token),
          ...(r.method === 'POST' ? { body: JSON.stringify({ reason: 'x' }) } : {}),
        });
        expect(res.status, `${r.method} ${r.path}`).toBe(403);
      }
  });

  it('lets a developer use the DEV controls', async () => {
    const { app, developer } = await worlds();
    expect((await app.request('/api/dev/status', { headers: auth(developer.token) })).status).toBe(
      200,
    );
    expect(
      (await app.request('/api/dev/tick', { method: 'POST', headers: auth(developer.token) }))
        .status,
    ).toBe(200);
  });

  it('refuses every DEV control to an administrator and to an ordinary member', async () => {
    const { app, admin, member } = await worlds();
    // An administrator does not get simulation controls merely for being an administrator.
    for (const who of [admin, member])
      for (const r of DEV_ROUTES) {
        const res = await app.request(r.path, {
          method: r.method,
          headers: auth(who.token),
          ...(r.method === 'POST' ? { body: JSON.stringify({ ms: 1000 }) } : {}),
        });
        expect(res.status, `${r.method} ${r.path}`).toBe(403);
      }
  });

  it('refuses the DEV controls in production even to a developer', async () => {
    const w = createTestWorld({ devMode: false });
    const app = createApp(w.ctx);
    makeDeveloper(w, 'bo');
    const developer = await login(app, 'bo');
    // The router is not even mounted outside development, so there is nothing to reach.
    for (const r of DEV_ROUTES) {
      const res = await app.request(r.path, {
        method: r.method,
        headers: auth(developer.token),
        ...(r.method === 'POST' ? { body: JSON.stringify({ ms: 1000 }) } : {}),
      });
      expect(res.status, `${r.method} ${r.path}`).toBe(404);
    }
  });

  it('never lets a client choose a role', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    // Registration with every plausible way of asking for one.
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-role': 'admin', 'x-mib-role': 'developer' },
      body: JSON.stringify({
        username: 'climber',
        displayName: 'Climber',
        password: 'a-long-enough-password',
        email: 'climber@example.test',
        role: 'admin',
        user: { role: 'admin' },
        policies: acceptCurrent(),
      }),
    });
    expect(res.status).toBe(201);
    const row = w.db.select().from(t.users).where(eq(t.users.username, 'climber')).get()!;
    expect(row.role).toBe('member');

    const { token } = (await res.json()) as { token: string };
    expect((await app.request('/api/admin/reports', { headers: auth(token) })).status).toBe(403);
    expect((await app.request('/api/dev/status', { headers: auth(token) })).status).toBe(403);
  });

  it('reads the role from the row on every request, not from the session', async () => {
    const { w, app, member } = await worlds();
    expect((await app.request('/api/admin/reports', { headers: auth(member.token) })).status).toBe(
      403,
    );
    // The CLI grants the role; the very next request with the *same* session sees it.
    w.db.update(t.users).set({ role: 'admin' }).where(eq(t.users.id, member.id)).run();
    expect((await app.request('/api/admin/reports', { headers: auth(member.token) })).status).toBe(
      200,
    );
    // And revoking it closes the door again, with no sign-out needed.
    w.db.update(t.users).set({ role: 'member' }).where(eq(t.users.id, member.id)).run();
    expect((await app.request('/api/admin/reports', { headers: auth(member.token) })).status).toBe(
      403,
    );
  });

  it('reports the role to its owner so the app can show the right controls', async () => {
    const { app, developer, admin } = await worlds();
    const roleOf = async (token: string) => {
      const res = await app.request('/api/auth/me', { headers: auth(token) });
      return ((await res.json()) as { role: string }).role;
    };
    expect(await roleOf(developer.token)).toBe('developer');
    expect(await roleOf(admin.token)).toBe('admin');
  });
});
