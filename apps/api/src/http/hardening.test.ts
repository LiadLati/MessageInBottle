import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp, MAX_REQUEST_BYTES } from './app.js';
import { FORGOT_PER_ADDRESS } from './routes/auth.js';
import { createTestWorld } from '../test/harness.js';

// Batch 1 of the audit remediation plan: the request edge of the API.

const forgot = (app: ReturnType<typeof createApp>, xff: string, n: number) =>
  app.request('/api/auth/password/forgot', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
    body: JSON.stringify({ email: `nobody${n}@example.test` }),
  });

describe('client address behind a trusted proxy (ARCH-018 / SEC-005)', () => {
  it('ignores a forged left-most X-Forwarded-For entry', async () => {
    const w = createTestWorld({ trustProxy: true, trustedProxyHops: 1 });
    const app = createApp(w.ctx);
    const statuses: number[] = [];
    // The attacker rotates the entry they control; the proxy always appends the same real peer.
    for (let i = 0; i <= FORGOT_PER_ADDRESS.limit; i++)
      statuses.push((await forgot(app, `192.0.2.${i}, 198.51.100.7`, i)).status);
    expect(statuses.slice(0, FORGOT_PER_ADDRESS.limit).every((s) => s === 202)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('keys distinct real clients separately', async () => {
    const w = createTestWorld({ trustProxy: true, trustedProxyHops: 1 });
    const app = createApp(w.ctx);
    for (let i = 0; i < FORGOT_PER_ADDRESS.limit; i++) await forgot(app, '198.51.100.7', i);
    expect((await forgot(app, '198.51.100.7', 99)).status).toBe(429);
    expect((await forgot(app, '198.51.100.8', 100)).status).toBe(202);
  });

  it('reads the client that many hops from the right with two proxies', async () => {
    const w = createTestWorld({ trustProxy: true, trustedProxyHops: 2 });
    const app = createApp(w.ctx);
    const statuses: number[] = [];
    for (let i = 0; i <= FORGOT_PER_ADDRESS.limit; i++)
      statuses.push((await forgot(app, `192.0.2.${i}, 198.51.100.7, 10.0.0.${i}`, i)).status);
    // The last hop (the inner proxy's view) varies, yet the client two from the right is fixed.
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('health check (ARCH-017)', () => {
  it('answers 200 while the database answers', async () => {
    const w = createTestWorld();
    const res = await createApp(w.ctx).request('/api/health');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('answers 503 when the database does not', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    (w.db as unknown as { $client: { close(): void } }).$client.close();
    const res = await app.request('/api/health');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: { code: 'database_unavailable' } });
  });
});

describe('response headers (SEC-014)', () => {
  it('sets framing, sniffing and referrer protection on API responses', async () => {
    const res = await createApp(createTestWorld().ctx).request('/api/health');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('lets the public deletion form post only to its own origin and never be framed', async () => {
    const res = await createApp(createTestWorld().ctx).request('/legal/delete-account');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).not.toContain('script-src');
  });

  it('sends HSTS only when the public URL is https', async () => {
    const plain = await createApp(createTestWorld({ appUrl: 'http://localhost:5173' }).ctx).request(
      '/api/health',
    );
    expect(plain.headers.get('strict-transport-security')).toBeNull();
    const secure = await createApp(
      createTestWorld({ appUrl: 'https://seayou.example' }).ctx,
    ).request('/api/health');
    expect(secure.headers.get('strict-transport-security')).toMatch(/max-age=31536000/);
  });
});

describe('request size (ARCH-027 / SEC-014)', () => {
  it('refuses an oversized body before parsing it', async () => {
    const app = createApp(createTestWorld().ctx);
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ada', password: 'x'.repeat(MAX_REQUEST_BYTES) }),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'payload_too_large',
    );
  });

  it('accepts an ordinary body', async () => {
    const app = createApp(createTestWorld().ctx);
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ada', password: 'wrong-password' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('validation errors never echo input (ARCH-022)', () => {
  it('reduces a ZodError reaching the fallback to path, code and message', async () => {
    const app = createApp(createTestWorld().ctx);
    // No route feeds raw input to a bare .parse() today; this probe is what one would do, with
    // the input reported in the issue so that echoing raw issues would leak it.
    app.post('/api/__probe', async (c) => {
      z.object({ password: z.number() }).parse(await c.req.json(), { reportInput: true });
      return c.body(null, 204);
    });
    const res = await app.request('/api/__probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'hunter2-secret' }),
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain('hunter2-secret');
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'validation' } });
  });
});
