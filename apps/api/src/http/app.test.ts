import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { acceptCurrent, createTestWorld, loginAs as login, releaseInput } from '../test/harness.js';

const auth = (token: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});

describe('HTTP surface', () => {
  it('opening a bottle found adrift: authenticated, single winner, no content to the loser', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const ada = await login(app, 'ada');
    const bo = await login(app, 'bo');
    const cy = await login(app, 'cy');
    const release = await app.request('/api/bottles/release', {
      method: 'POST',
      headers: auth(ada.token),
      body: JSON.stringify(releaseInput(bo.id, 'http-key-0000010')),
    });
    const { bottle } = (await release.json()) as { bottle: { id: string } };
    await app.request('/api/dev/lose', {
      method: 'POST',
      headers: auth(ada.token),
      body: JSON.stringify({ bottleId: bottle.id, reason: 'adrift' }),
    });
    const openUrl = `/api/ocean/public/${bottle.id}/open`;
    expect((await app.request(openUrl, { method: 'POST' })).status).toBe(401);
    // The sender cannot claim their own bottle, but may read it as often as they like.
    expect((await app.request(openUrl, { method: 'POST', headers: auth(ada.token) })).status).toBe(
      400,
    );
    for (let i = 0; i < 2; i++) {
      const own = await app.request(`/api/bottles/sent/${bottle.id}/letter`, {
        headers: auth(ada.token),
      });
      expect(own.status).toBe(200);
      expect(JSON.stringify(await own.json())).toContain('tide was gentle');
    }
    expect(
      (await app.request(`/api/bottles/sent/${bottle.id}/letter`, { headers: auth(cy.token) }))
        .status,
    ).toBe(404);

    // Two finders race: exactly one wins, the other is told it is gone and shown nothing.
    const [first, second] = await Promise.all([
      app.request(openUrl, { method: 'POST', headers: auth(cy.token) }),
      app.request(openUrl, { method: 'POST', headers: auth(bo.token) }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = first.status === 200 ? first : second;
    const loser = first.status === 200 ? second : first;
    const winnerBody = (await winner.json()) as { letter: { text: string } };
    expect(winnerBody.letter.text).toContain('tide was gentle');
    const loserBody = JSON.stringify(await loser.json());
    expect(loserBody).toContain('already_opened');
    expect(loserBody).not.toContain('tide was gentle');

    // The bottle has left the public map for everyone.
    for (const token of [ada.token, bo.token, cy.token]) {
      const res = await app.request('/api/ocean/public', { headers: auth(token) });
      expect(((await res.json()) as { bottles: unknown[] }).bottles).toEqual([]);
    }
  });

  it('public ocean: authenticated, strict projection, dev loss only by the owner', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    expect((await app.request('/api/ocean/public')).status).toBe(401);
    const ada = await login(app, 'ada');
    const bo = await login(app, 'bo');
    const cy = await login(app, 'cy');
    const release = await app.request('/api/bottles/release', {
      method: 'POST',
      headers: auth(ada.token),
      body: JSON.stringify(releaseInput(bo.id, 'http-key-0000009')),
    });
    const { bottle } = (await release.json()) as { bottle: { id: string } };

    // Only the sender can end their own journey through the development control.
    for (const token of [bo.token, cy.token]) {
      const res = await app.request('/api/dev/lose', {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({ bottleId: bottle.id, reason: 'adrift' }),
      });
      expect(res.status).toBe(404);
    }
    const lose = await app.request('/api/dev/lose', {
      method: 'POST',
      headers: auth(ada.token),
      body: JSON.stringify({ bottleId: bottle.id, reason: 'adrift' }),
    });
    expect(lose.status).toBe(200);
    expect(((await lose.json()) as { outcome: { committed: boolean } }).outcome.committed).toBe(
      true,
    );

    // Every signed-in user sees exactly the permitted fields; only the sender gets `mine`.
    for (const [token, mine] of [
      [ada.token, true],
      [bo.token, false],
      [cy.token, false],
    ] as const) {
      const res = await app.request('/api/ocean/public', { headers: auth(token) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { bottles: Array<Record<string, unknown>> };
      expect(body.bottles).toHaveLength(1);
      expect(Object.keys(body.bottles[0]!).sort()).toEqual([
        'expiresAt',
        'id',
        'lostAt',
        'mine',
        'position',
        'reason',
      ]);
      expect(body.bottles[0]!.mine).toBe(mine);
      expect(JSON.stringify(body)).not.toMatch(/Ada|Bo|driftmoor|lantern|nodeIds|tide was gentle/);
    }
    // The visibility endpoints are the sender's alone.
    for (const token of [bo.token, cy.token]) {
      const res = await app.request(`/api/bottles/sent/${bottle.id}/seen`, {
        method: 'POST',
        headers: auth(token),
      });
      expect(res.status).toBe(404);
    }
  });

  it('requires authentication and never leaks bottle existence to non-participants', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    expect((await app.request('/api/bottles/sent')).status).toBe(401);

    const ada = await login(app, 'ada');
    const bo = await login(app, 'bo');
    const cy = await login(app, 'cy');

    const release = await app.request('/api/bottles/release', {
      method: 'POST',
      headers: auth(ada.token),
      body: JSON.stringify(releaseInput(bo.id, 'http-key-0000001')),
    });
    expect(release.status).toBe(201);
    const { bottle } = (await release.json()) as { bottle: { id: string } };

    const replay = await app.request('/api/bottles/release', {
      method: 'POST',
      headers: auth(ada.token),
      body: JSON.stringify(releaseInput(bo.id, 'http-key-0000001')),
    });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { bottle: { id: string } }).bottle.id).toBe(bottle.id);

    for (const token of [bo.token, cy.token]) {
      const res = await app.request(`/api/bottles/sent/${bottle.id}`, { headers: auth(token) });
      expect(res.status).toBe(404);
      const open = await app.request(`/api/shore/bottles/${bottle.id}/open`, {
        method: 'POST',
        headers: auth(token),
      });
      expect(open.status).toBe(404);
    }
    const shore = (await (await app.request('/api/shore', { headers: auth(bo.token) })).json()) as {
      bottles: unknown[];
    };
    expect(shore.bottles).toEqual([]);
  });

  it("time zone: the device's zone is kept per account, refused when unknown, shown by /me", async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const { token } = await login(app, 'ada');
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const me0 = (await (await app.request('/api/auth/me', { headers: auth })).json()) as {
      timeZone: string | null;
    };
    expect(me0.timeZone).toBeNull();
    const put = (timeZone: string) =>
      app.request('/api/auth/time-zone', {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ timeZone }),
      });
    const ok = await put('Asia/Tokyo');
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { timeZone: string }).timeZone).toBe('Asia/Tokyo');
    expect((await put('Mars/Olympus_Mons')).status).toBe(400);
    expect((await put('')).status).toBe(400);
    const me1 = (await (await app.request('/api/auth/me', { headers: auth })).json()) as {
      timeZone: string | null;
    };
    expect(me1.timeZone).toBe('Asia/Tokyo');
    expect((await app.request('/api/auth/time-zone', { method: 'PUT' })).status).toBe(401);
  });

  it('admin endpoints are refused to every non-admin, and the standing gate blocks a suspended account', async () => {
    const { eq } = await import('drizzle-orm');
    const t = await import('../db/schema.js');
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const member = await login(app, 'ada');
    const auth = (token: string) => ({
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    });
    // A member, and a member who *claims* to be an admin in the body or a header: all 403.
    for (const [method, path] of [
      ['GET', '/api/admin/reports'],
      ['GET', '/api/admin/reports/cas_x'],
      ['POST', '/api/admin/reports/cas_x/accept'],
      ['POST', '/api/admin/reports/cas_x/reject'],
      ['GET', '/api/admin/appeals'],
      ['GET', '/api/admin/appeals/apl_x'],
      ['POST', '/api/admin/appeals/apl_x/accept'],
      ['POST', '/api/admin/appeals/apl_x/reject'],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: { ...auth(member.token), 'x-role': 'admin' },
        ...(method === 'POST' ? { body: JSON.stringify({ role: 'admin', reason: 'x' }) } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(
        (await app.request(path, { method })).status,
        `${method} ${path} unauthenticated`,
      ).toBe(401);
    }
    // Registration cannot pick a role.
    const reg = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'wannabe',
        email: 'w@example.test',
        password: 'Tide-pass-2026',
        policies: acceptCurrent(),
        role: 'admin',
      }),
    });
    expect(reg.status).toBe(201);
    expect(((await reg.json()) as { user: { role: string } }).user.role).toBe('member');
    // The role granted the way the tool grants it opens the door — for that account only.
    w.db
      .update(t.users)
      .set({ role: 'admin' })
      .where(eq(t.users.id, w.user('cy').id))
      .run();
    const adminUser = await login(app, 'cy');
    expect(
      (await app.request('/api/admin/reports', { headers: auth(adminUser.token) })).status,
    ).toBe(200);
    expect(
      (await app.request('/api/admin/reports/cas_missing', { headers: auth(adminUser.token) }))
        .status,
    ).toBe(404);
    // A suspended account: sign-in, /me, standing and appeals answer; the rest is 403.
    const { decideCase } = await import('../services/admin.js');
    const { reportLetter } = await import('../services/moderation.js');
    const { releaseBottle } = await import('../services/release.js');
    const { commitArrivalIfDue } = await import('../services/journey.js');
    const { openBottle } = await import('../services/bottles.js');
    for (const key of ['key-0000000901', 'key-0000000902']) {
      const id = releaseBottle(w.ctx, w.user('ada'), releaseInput(w.user('bo').id, key)).bottleId;
      w.clock.advance(40 * 24 * 60 * 60 * 1000);
      commitArrivalIfDue(w.ctx, id, w.clock.now());
      openBottle(w.ctx, w.user('bo'), id);
      const caseId = reportLetter(w.ctx, w.user('bo'), {
        bottleId: id,
        reason: 'hate',
        hide: false,
      }).caseId;
      decideCase(w.ctx, { ...w.user('cy'), role: 'admin' }, caseId, 'accepted', null);
    }
    const again = await login(app, 'ada');
    expect((await app.request('/api/auth/me', { headers: auth(again.token) })).status).toBe(200);
    const standing = (await (
      await app.request('/api/moderation/standing', { headers: auth(again.token) })
    ).json()) as { standing: string; violations: Array<{ id: string }> };
    expect(standing.standing).toBe('suspended');
    for (const path of [
      '/api/bottles/sent',
      '/api/shore',
      '/api/ocean/public',
      '/api/friends',
      '/api/chart',
    ]) {
      const res = await app.request(path, { headers: auth(again.token) });
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
        /suspended until/,
      );
    }
    expect(
      (
        await app.request('/api/moderation/reports', {
          method: 'POST',
          headers: auth(again.token),
          body: JSON.stringify({ bottleId: 'btl_x', reason: 'hate', hide: true }),
        })
      ).status,
    ).toBe(403);
    const appeal = await app.request('/api/moderation/appeals', {
      method: 'POST',
      headers: auth(again.token),
      body: JSON.stringify({ violationId: standing.violations[0]!.id, text: 'Please look again.' }),
    });
    expect(appeal.status).toBe(201);
    expect(
      (await app.request('/api/auth/logout', { method: 'POST', headers: auth(again.token) }))
        .status,
    ).toBe(204);
    // What the sender is ever shown carries no reporter.
    expect(JSON.stringify(standing)).not.toContain(w.user('bo').id);
    expect(JSON.stringify(standing)).not.toMatch(/reporter/);
  });

  it('rejects malformed release bodies without creating anything', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const ada = await login(app, 'ada');
    const bo = await login(app, 'bo');
    const res = await app.request('/api/bottles/release', {
      method: 'POST',
      headers: auth(ada.token),
      body: JSON.stringify({ ...releaseInput(bo.id), disclosureAcknowledged: false }),
    });
    expect(res.status).toBe(400);
    const sent = (await (
      await app.request('/api/bottles/sent', { headers: auth(ada.token) })
    ).json()) as { bottles: unknown[] };
    expect(sent.bottles).toEqual([]);
  });

  it('chart responses list shores with app anchors and seas, never people or country names', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const ada = await login(app, 'ada');
    const res = await app.request('/api/chart', { headers: auth(ada.token) });
    const text = await res.text();
    // No user data, no device location, no route graph internals, no country attribution.
    expect(text).not.toMatch(/gps|user|flag|"nodes"|"edges"|country/i);
    for (const name of ['Portugal', 'Germany', 'France', 'United States of America', 'Russia'])
      expect(text, name).not.toContain(name);
    const chart = JSON.parse(text) as {
      graphVersion: number;
      shores: Array<{ id: string; geo: { lng: number; lat: number } | null; sea: string | null }>;
    };
    expect(chart.graphVersion).toBe(2);
    for (const s of chart.shores) {
      expect(s.geo).not.toBeNull();
      expect(Object.keys(s).sort()).toEqual(['capacity', 'geo', 'id', 'name', 'position', 'sea']);
    }
    expect(chart.shores.find((s) => s.id === 'shore_lantern_cove')!.sea).toBeNull();
    expect(chart.shores.find((s) => s.id === 'shore_jp_tokyo')!.sea).toBe('Tokyo Bay');
    expect(chart.shores.length).toBeGreaterThan(300);
  });

  it('user-facing responses never contain coordinates', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const ada = await login(app, 'ada');
    for (const path of ['/api/auth/me', '/api/friends', '/api/notifications']) {
      const text = await (await app.request(path, { headers: auth(ada.token) })).text();
      expect(text, path).not.toMatch(/lat|lng|longitude|latitude|gps|coordinate/i);
    }
  });
});
