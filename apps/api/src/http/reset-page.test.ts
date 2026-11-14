import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { acceptCurrent, createTestWorld, loginAs } from '../test/harness.js';

// SeaYou's interface is an Android app, so the link in a password-reset e-mail opens a plain
// server page instead of the app. It must apply exactly the API's reset: one use, 30 minutes,
// the same password rules, and every session ended.

type App = ReturnType<typeof createApp>;
const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function mira(app: App) {
  const res = await app.request(
    '/api/auth/register',
    json({
      username: 'mira',
      email: 'mira@example.test',
      password: 'first password',
      policies: acceptCurrent(),
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; user: { id: string } };
}

async function mailedToken(app: App, w: ReturnType<typeof createTestWorld>, email: string) {
  const res = await app.request('/api/auth/password/forgot', json({ email }));
  expect(res.status).toBe(202);
  for (let i = 0; i < 50 && w.outbox.messages.length === 0; i++)
    await new Promise((r) => setTimeout(r, 10));
  const text = w.outbox.messages.at(-1)!.text;
  const link = /http:\/\/app\.test\/reset-password\?token=([0-9a-f]{64})/.exec(text);
  expect(link).not.toBeNull();
  return link![1]!;
}

const submit = (app: App, fields: Record<string, string>) =>
  app.request('/reset-password', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });

describe('the password-reset page a reset e-mail links to', () => {
  it('shows a script-free form for a live link, and refuses a bad one', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    await mira(app);
    const token = await mailedToken(app, w, 'mira@example.test');

    const res = await app.request(`/reset-password?token=${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<form method="post" action="/reset-password">');
    expect(html).toContain(`name="token" value="${token}"`);
    expect(html).not.toContain('<script');
    expect(res.headers.get('content-security-policy')).toContain("form-action 'self'");
    expect(res.headers.get('content-security-policy')).not.toContain('script-src');
    expect(res.headers.get('cache-control')).toBe('no-store');

    for (const bad of ['', 'short', 'f'.repeat(64)]) {
      const r = await app.request(`/reset-password?token=${bad}`);
      expect(r.status).toBe(400);
      expect(await r.text()).toContain('This link cannot be used');
    }
  });

  it('sets the password once, ends every session, and the new password signs in', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const before = await mira(app);
    const token = await mailedToken(app, w, 'mira@example.test');

    const mismatch = await submit(app, { token, password: 'a new password', confirm: 'other one' });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.text()).toContain('The two passwords are not the same.');
    const short = await submit(app, { token, password: 'short', confirm: 'short' });
    expect(short.status).toBe(400);
    expect(await short.text()).toContain('8 to 128 characters');

    const done = await submit(app, {
      token,
      password: 'a new password',
      confirm: 'a new password',
    });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('Your password has been changed');

    // The session held before the reset is over; the new password works.
    const me = await app.request('/api/auth/me', {
      headers: { authorization: `Bearer ${before.token}` },
    });
    expect(me.status).toBe(401);
    await expect(loginAs(app, 'mira', 'a new password')).resolves.toMatchObject({
      id: before.user.id,
    });

    // And the link is spent.
    const again = await submit(app, {
      token,
      password: 'third password',
      confirm: 'third password',
    });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain('This link cannot be used');
    expect((await app.request(`/reset-password?token=${token}`)).status).toBe(400);
  });
});
