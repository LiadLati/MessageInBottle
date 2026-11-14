import { describe, expect, it } from 'vitest';
import { ANDROID_APP_ORIGIN } from '../config.js';
import { createApp } from './app.js';
import { createTestWorld } from '../test/harness.js';

// The Android app's interface runs at https://localhost inside its WebView and calls the API
// cross-origin. The API must answer that origin's preflight, and no other site's.
describe('the Android app origin may call the API', () => {
  const app = () => createApp(createTestWorld({ corsOrigin: [ANDROID_APP_ORIGIN] }).ctx);
  const preflight = (origin: string) =>
    app().request('/api/auth/login', {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, authorization',
      },
    });

  it('answers the app origin with its own origin and the headers it needs', async () => {
    const res = await preflight(ANDROID_APP_ORIGIN);
    expect(res.headers.get('access-control-allow-origin')).toBe(ANDROID_APP_ORIGIN);
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    expect(allowed).toContain('authorization');
    expect(allowed).toContain('content-type');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('does not grant any other origin', async () => {
    for (const origin of ['https://evil.example', 'http://localhost', 'https://localhost:8443']) {
      const res = await preflight(origin);
      expect(res.headers.get('access-control-allow-origin')).not.toBe(origin);
    }
  });
});
