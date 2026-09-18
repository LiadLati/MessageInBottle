import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createTestWorld, loginAs as login, releaseInput } from '../test/harness.js';

const auth = (token: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});

describe('HTTP surface', () => {
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
