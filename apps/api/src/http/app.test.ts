import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createTestWorld, releaseInput } from '../test/harness.js';

async function login(app: ReturnType<typeof createApp>, username: string) {
  const res = await app.request('/api/auth/dev-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  const body = (await res.json()) as { token: string; user: { id: string } };
  return { token: body.token, id: body.user.id };
}

const auth = (token: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});

describe('HTTP surface', () => {
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

  it('chart responses contain only abstract chart units, no coordinates or countries', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const ada = await login(app, 'ada');
    const text = await (await app.request('/api/chart', { headers: auth(ada.token) })).text();
    expect(text).not.toMatch(/lat|lng|longitude|latitude|country|border/i);
  });
});
