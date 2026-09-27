import { describe, expect, it } from 'vitest';
import { releaseOriginProblem } from '../../scripts/android-build.mjs';

// A release build of the Android app may only ever talk to a real HTTPS server.
describe('the API origin a Play release is built with', () => {
  it('accepts a public https origin', () => {
    expect(releaseOriginProblem('https://api.seayou.app')).toBeNull();
    expect(releaseOriginProblem('https://seayou.app/')).toBeNull();
  });

  it.each([
    [undefined, /not set/],
    ['', /not set/],
    ['http://api.seayou.app', /must be https/],
    ['https://api.seayou.app/api', /origin only/],
    ['https://user:pw@api.seayou.app', /origin only/],
    ['https://10.0.2.2:3001', /development or placeholder/],
    ['https://localhost', /development or placeholder/],
    ['https://192.168.1.20', /development or placeholder/],
    ['https://seayou.example', /development or placeholder/],
    ['https://api.example.com', /development or placeholder/],
    ['not a url', /not a URL/],
  ])('refuses %j', (origin, why) => {
    expect(releaseOriginProblem(origin)).toMatch(why);
  });
});
