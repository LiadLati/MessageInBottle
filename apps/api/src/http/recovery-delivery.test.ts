import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
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
    let sends = 0;
    const counted: Mailer = {
      kind: 'smtp',
      send: async (message) => {
        await flaky.send(message);
        sends++;
      },
    };
    w.ctx.mailer = counted;
    await forgot(app, 'ada@example.test');
    // The send runs after the answer; wait for it to have happened, not for a fixed time.
    await vi.waitFor(() => expect(sends).toBe(1));
    const [delivered] = resets();
    expect(delivered!.invalidatedAt).toBeNull();
    fail = true;
    await forgot(app, 'ada@example.test');
    await vi.waitFor(() =>
      expect(resets().filter((r) => r.invalidatedAt !== null)).toHaveLength(1),
    );
    const rows = resets();
    expect(rows).toHaveLength(2);
    // The delivered link is still the live one; the undelivered one was withdrawn.
    expect(rows.filter((r) => r.invalidatedAt === null).map((r) => r.id)).toEqual([delivered!.id]);
  });
});

describe('password recovery takes the same time either way (SEC-017)', () => {
  // Structural, not timed (audit QA-R-007): the mail server never answers until the test lets
  // it, so a route that waited for it could not answer at all.
  it('does not wait for a slow mail server', async () => {
    let release: (() => void) | undefined;
    const held: Mailer = {
      kind: 'smtp',
      send: () => new Promise<void>((resolve) => (release = resolve)),
    };
    const { app } = worldWith(held);
    const res = await forgot(app, 'ada@example.test');
    expect(res.status).toBe(202);
    // The send did start, and is still waiting on the mail server.
    await vi.waitFor(() => expect(release).toBeDefined());
    release!();
  });
});
