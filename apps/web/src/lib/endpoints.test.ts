import { describe, expect, it } from 'vitest';
import { apiUrl, endpointProblem, publicPageUrl } from './endpoints.js';

// In the browser (tests, development) the API shares the page's origin: paths stay relative.
// A packaged app with no configured origin must refuse to start rather than call itself.
describe('where the client finds the server', () => {
  it('keeps relative same-origin paths when no origin is configured', () => {
    expect(apiUrl('/auth/me')).toBe('/api/auth/me');
    expect(publicPageUrl('/support')).toBe('/support');
  });

  it('refuses to run a packaged app that has no server address', () => {
    expect(endpointProblem(true, '')).toMatch(/built without a server address/);
    expect(endpointProblem(true, 'https://api.seayou.example')).toBeNull();
    expect(endpointProblem(false, '')).toBeNull();
  });
});
