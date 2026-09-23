import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import * as t from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { createApp, type AppEnv } from './app.js';
import { requireAuth } from './middleware/auth.js';
import { requireAdmin } from './middleware/admin.js';
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
//
// The routes are read from the assembled app rather than listed by hand (audit QA-012), so a
// route added later is probed without anyone remembering to add it here — including one
// registered ahead of, or outside, its router's role middleware.
type Route = { method: string; path: string };
type App = { routes: Array<{ method: string; path: string }> };
function routesUnder(app: App, prefix: string): Route[] {
  const seen = new Map<string, Route>();
  for (const r of app.routes) {
    // `use('*', …)` middleware shows up as ALL on a wildcard path; it is not a route.
    if (!r.path.startsWith(`${prefix}/`) || r.path.endsWith('*')) continue;
    const route = {
      method: r.method === 'ALL' ? 'GET' : r.method,
      path: r.path.replace(/:\w+(\{[^}]*\})?/g, 'probe_id'),
    };
    seen.set(`${route.method} ${route.path}`, route);
  }
  return [...seen.values()];
}
const ADMIN_ROUTES = routesUnder(createApp(createTestWorld().ctx), '/api/admin');
const DEV_ROUTES = routesUnder(createApp(createTestWorld().ctx), '/api/dev');

// Every route that does not answer `expected` to this caller, as "METHOD path → status".
async function answering(
  app: { request: ReturnType<typeof createApp>['request'] },
  routes: Route[],
  token: string,
  expected: number,
): Promise<string[]> {
  const wrong: string[] = [];
  for (const r of routes) {
    const res = await app.request(r.path, {
      method: r.method,
      headers: auth(token),
      ...(r.method === 'GET' ? {} : { body: JSON.stringify({ reason: 'x', ms: 1000 }) }),
    });
    if (res.status !== expected) wrong.push(`${r.method} ${r.path} → ${res.status}`);
  }
  return wrong;
}

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

  it('finds every admin and DEV route in the app, not just the ones someone listed', () => {
    // The routes an earlier hand-written list missed are among them.
    expect(ADMIN_ROUTES.length).toBeGreaterThanOrEqual(11);
    expect(DEV_ROUTES.length).toBeGreaterThanOrEqual(7);
    for (const r of [
      'GET /api/admin/reports/probe_id',
      'POST /api/admin/appeals/probe_id/accept',
      'POST /api/admin/reports/probe_id/hold/release',
    ])
      expect(ADMIN_ROUTES.map((x) => `${x.method} ${x.path}`)).toContain(r);
    for (const r of ['GET /api/dev/outbox', 'POST /api/dev/arrive', 'POST /api/dev/lose'])
      expect(DEV_ROUTES.map((x) => `${x.method} ${x.path}`)).toContain(r);
  });

  it('refuses every admin route to a developer and to an ordinary member', async () => {
    const { app, developer, member } = await worlds();
    for (const who of [developer, member])
      expect(await answering(app, ADMIN_ROUTES, who.token, 403)).toEqual([]);
  });

  it("would notice a route registered ahead of its router's role middleware", async () => {
    // A router that serves one route before its `use` guard, mounted in front of the real app:
    // the guard never runs for that route. The enumeration must find it and the probe flag it.
    const w = createTestWorld();
    const leaky = new Hono<AppEnv>();
    leaky.get('/leak', (c) => c.json({ ok: true }));
    leaky.use('*', requireAuth, requireAdmin);
    leaky.get('/guarded', (c) => c.json({ ok: true }));
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('ctx', w.ctx);
      await next();
    });
    app.route('/api/admin', leaky);
    app.route('/', createApp(w.ctx));
    app.onError((err, c) => c.json({}, err instanceof AppError ? (err.status as 403) : 500));
    const member = await login(app, 'ada');
    const routes = routesUnder(app, '/api/admin');
    expect(routes.map((r) => r.path)).toContain('/api/admin/leak');
    expect(await answering(app, routes, member.token, 403)).toEqual(['GET /api/admin/leak → 200']);
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
      expect(await answering(app, DEV_ROUTES, who.token, 403)).toEqual([]);
  });

  it('refuses the DEV controls in production even to a developer', async () => {
    const w = createTestWorld({ devMode: false });
    const app = createApp(w.ctx);
    makeDeveloper(w, 'bo');
    const developer = await login(app, 'bo');
    // The router is not even mounted outside development, so there is nothing to reach.
    expect(routesUnder(app, '/api/dev')).toEqual([]);
    expect(await answering(app, DEV_ROUTES, developer.token, 404)).toEqual([]);
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
