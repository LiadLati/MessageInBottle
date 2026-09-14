import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, UNREACHABLE, api } from './client.js';

function respond(status: number, body: string, contentType = 'application/json') {
  vi.stubGlobal('fetch', () =>
    Promise.resolve(new Response(body, { status, headers: { 'content-type': contentType } })),
  );
}
const failure = async (call: Promise<unknown>): Promise<ApiError> => {
  try {
    await call;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected the call to fail');
};

afterEach(() => vi.unstubAllGlobals());

describe('api client error mapping', () => {
  it('reports a request that never completes as unreachable, not as a request problem', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    const err = await failure(api.login('ada', 'secret'));
    expect(err.code).toBe(UNREACHABLE);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/cannot reach/i);
  });

  it('reports a 5xx with no API error body as unreachable (a dev proxy with nothing behind it)', async () => {
    respond(500, '', 'text/plain');
    const err = await failure(api.login('ada', 'secret'));
    expect(err.code).toBe(UNREACHABLE);
    expect(err.status).toBe(500);
  });

  it('keeps a genuine server error distinct from an unreachable server', async () => {
    respond(500, JSON.stringify({ error: { code: 'internal', message: 'unexpected error' } }));
    const err = await failure(api.login('ada', 'secret'));
    expect(err.code).toBe('internal');
    expect(err.status).toBe(500);
  });

  it('never turns a non-JSON error body into a parse exception', async () => {
    respond(502, '<html><body>Bad Gateway</body></html>', 'text/html');
    const err = await failure(api.login('ada', 'secret'));
    expect(err.code).toBe(UNREACHABLE);
    expect(err).toBeInstanceOf(ApiError);
  });

  it('passes API failures through with their code, message and details', async () => {
    respond(401, JSON.stringify({ error: { code: 'invalid_credentials', message: 'nope' } }));
    const bad = await failure(api.login('ada', 'wrong'));
    expect([bad.status, bad.code, bad.message]).toEqual([401, 'invalid_credentials', 'nope']);
    respond(
      429,
      JSON.stringify({ error: { code: 'rate_limited', details: { retryAfterSeconds: 90 } } }),
    );
    const limited = await failure(api.login('ada', 'wrong'));
    expect(limited.details).toEqual({ retryAfterSeconds: 90 });
  });

  it('returns parsed data and handles 204 replies', async () => {
    respond(200, JSON.stringify({ token: 't', user: { id: 'u' } }));
    await expect(api.login('ada', 'secret')).resolves.toMatchObject({ token: 't' });
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 204 })));
    await expect(api.logout()).resolves.toBeUndefined();
  });
});
