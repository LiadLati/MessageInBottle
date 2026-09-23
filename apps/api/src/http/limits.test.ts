import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../config.js';
import { createApp } from './app.js';
import { ZONE_CHANGES_PER_ACCOUNT } from './routes/auth.js';
import { PLAN_PER_ACCOUNT } from './routes/bottles.js';
import { createTestWorld, loginAs } from '../test/harness.js';

const json = (token: string) => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
});

describe('zone changes are bounded (ARCH-010, independent part)', () => {
  it('allows a few changes a day, and resyncing the same zone always', async () => {
    const app = createApp(createTestWorld().ctx);
    const ada = await loginAs(app, 'ada');
    const zones = ['Asia/Tokyo', 'Europe/Berlin', 'America/New_York', 'Australia/Sydney', 'UTC'];
    const statuses: number[] = [];
    for (const timeZone of zones)
      statuses.push(
        (
          await app.request('/api/auth/time-zone', {
            method: 'PUT',
            headers: json(ada.token),
            body: JSON.stringify({ timeZone }),
          })
        ).status,
      );
    expect(statuses.slice(0, ZONE_CHANGES_PER_ACCOUNT.limit)).toEqual([200, 200, 200, 200]);
    expect(statuses[ZONE_CHANGES_PER_ACCOUNT.limit]).toBe(429);
    // The zone it already has costs nothing.
    const same = await app.request('/api/auth/time-zone', {
      method: 'PUT',
      headers: json(ada.token),
      body: JSON.stringify({ timeZone: 'Australia/Sydney' }),
    });
    expect(same.status).toBe(200);
  });
});

describe('route planning is bounded per account (ARCH-012)', () => {
  it('refuses previews past the budget', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const ada = await loginAs(app, 'ada');
    const preview = () =>
      app.request('/api/bottles/preview', {
        method: 'POST',
        headers: json(ada.token),
        body: JSON.stringify({ recipientId: w.user('bo').id }),
      });
    for (let i = 0; i < PLAN_PER_ACCOUNT.limit; i++) expect((await preview()).status).toBe(200);
    expect((await preview()).status).toBe(429);
  });
});

describe('every published document can be read (ARCH-023)', () => {
  it('serves the Child Safety Standards by id', async () => {
    const app = createApp(createTestWorld().ctx);
    const list = (await (await app.request('/api/policies')).json()) as {
      documents: Array<{ id: string }>;
    };
    for (const { id } of list.documents)
      expect((await app.request(`/api/policies/${id}`)).status, id).toBe(200);
    expect((await app.request('/api/policies/no-such-thing')).status).toBe(400);
  });
});

describe('the risk policy version is validated (ARCH-019)', () => {
  it('accepts 0 or the implemented version only', () => {
    expect(loadConfig({ MIB_RISK_POLICY_VERSION: '0' }).riskPolicyVersion).toBe(0);
    expect(() => loadConfig({ MIB_RISK_POLICY_VERSION: '7' })).toThrow(ConfigError);
  });
});
