import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as t from '../db/schema.js';
import type { Mailer } from '../lib/mail.js';
import { createApp } from './app.js';
import { createTestWorld } from '../test/harness.js';

// ARCH-008 / QA-004 and SEC-017: password recovery answers the same way, just as fast, whether
// or not the address is known and whether or not mail can be delivered.
function worldWith(mailer: Mailer) {
  const w = createTestWorld();
  w.db.update(t.users).set({ email: 'ada@example.test' }).where(eq(t.users.username, 'ada')).run();
  w.ctx.mailer = mailer;
  return { w, app: createApp(w.ctx) };
}
const forgot = (app: ReturnType<typeof createApp>, email: string) =>
  app.request('/api/auth/password/forgot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('password recovery when mail fails (ARCH-008 / QA-004)', () => {
  const failing: Mailer = {
    kind: 'smtp',
    send: () => Promise.reject(new Error('connect ECONNREFUSED smtp.example.com:587')),
  };

  it('answers 202 for a known and an unknown address alike', async () => {
    const { app } = worldWith(failing);
    const known = await forgot(app, 'ada@example.test');
    const unknown = await forgot(app, 'nobody@example.test');
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(await known.text()).toBe(await unknown.text());
  });

  it('withdraws the undelivered link and keeps an earlier one working', async () => {
    let fail = false;
    const flaky: Mailer = {
      kind: 'smtp',
      send: () => (fail ? Promise.reject(new Error('down')) : Promise.resolve()),
    };
    const { w, app } = worldWith(flaky);
    const ada = w.user('ada').id;
    const resets = () =>
      w.db.select().from(t.passwordResets).where(eq(t.passwordResets.userId, ada)).all();
    await forgot(app, 'ada@example.test');
    await settle();
    const [delivered] = resets();
    expect(delivered!.invalidatedAt).toBeNull();
    fail = true;
    await forgot(app, 'ada@example.test');
    await settle();
    const rows = resets();
    expect(rows).toHaveLength(2);
    // The delivered link is still the live one; the undelivered one was withdrawn.
    expect(rows.filter((r) => r.invalidatedAt === null).map((r) => r.id)).toEqual([delivered!.id]);
  });
});

describe('password recovery takes the same time either way (SEC-017)', () => {
  it('does not wait for a slow mail server', async () => {
    const slow: Mailer = { kind: 'smtp', send: () => new Promise((r) => setTimeout(r, 400)) };
    const { app } = worldWith(slow);
    const started = performance.now();
    const res = await forgot(app, 'ada@example.test');
    const known = performance.now() - started;
    expect(res.status).toBe(202);
    expect(known).toBeLessThan(200);
  });
});
