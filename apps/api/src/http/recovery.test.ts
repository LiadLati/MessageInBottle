import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { RESET_TOKEN_TTL_MS } from '@mib/shared';
import { createApp } from './app.js';
import { FORGOT_PER_EMAIL } from './routes/auth.js';
import * as t from '../db/schema.js';
import { DisabledMailer, OutboxMailer, SmtpMailer, createMailer } from '../lib/mail.js';
import { sha256 } from '../lib/ids.js';
import { createTestWorld, testConfig } from '../test/harness.js';

type App = ReturnType<typeof createApp>;
const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
async function registered(app: App, username: string, email: string, password = 'first password') {
  const res = await app.request('/api/auth/register', json({ username, email, password }));
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; user: { id: string; email: string | null } };
}
const forgot = (app: App, email: string) =>
  app.request('/api/auth/password/forgot', json({ email }));
const reset = (app: App, token: string, password: string) =>
  app.request('/api/auth/password/reset', json({ token, password }));
const tokenFrom = (text: string) => /\?reset=([0-9a-f]{64})/.exec(text)![1]!;

describe('registration with e-mail', () => {
  it('requires a valid address, normalizes it and keeps it unique case-insensitively', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    expect(
      (await app.request('/api/auth/register', json({ username: 'mira', password: 'long enough' })))
        .status,
    ).toBe(400);
    expect(
      (
        await app.request(
          '/api/auth/register',
          json({ username: 'mira', email: 'nope', password: 'long enough' }),
        )
      ).status,
    ).toBe(400);
    const a = await registered(app, 'mira', '  Mira@Example.COM ');
    expect(a.user.email).toBe('mira@example.com');
    const dup = await app.request(
      '/api/auth/register',
      json({ username: 'other', email: 'MIRA@example.com', password: 'long enough' }),
    );
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe('email_taken');
    // Seeded accounts predate e-mail and simply have none.
    const me = await app.request('/api/auth/me', bearer(a.token));
    expect(((await me.json()) as { email: string }).email).toBe('mira@example.com');
    expect(w.db.select().from(t.users).where(eq(t.users.username, 'ada')).get()!.email).toBeNull();
  });
});

describe('password recovery', () => {
  it('answers identically for known and unknown addresses and mails one token for known ones', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    await registered(app, 'mira', 'mira@example.com');
    const known = await forgot(app, 'MIRA@example.com');
    const unknown = await forgot(app, 'nobody@example.com');
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(await known.text()).toBe(await unknown.text());
    expect(w.outbox.messages).toHaveLength(1);
    const mail = w.outbox.messages[0]!;
    expect(mail.to).toBe('mira@example.com');
    expect(mail.text).toContain('http://app.test/?reset=');
    // Only the hash is stored, never the token.
    const token = tokenFrom(mail.text);
    const row = w.db.select().from(t.passwordResets).get()!;
    expect(row.tokenHash).toBe(sha256(token));
    expect(row.expiresAt - row.createdAt).toBe(RESET_TOKEN_TTL_MS);
    expect(JSON.stringify(w.db.select().from(t.passwordResets).all())).not.toContain(token);
  });

  it('resets once, supersedes older tokens and revokes every session', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const first = await registered(app, 'mira', 'mira@example.com');
    const phone = (await (
      await app.request('/api/auth/login', json({ username: 'mira', password: 'first password' }))
    ).json()) as { token: string };
    await forgot(app, 'mira@example.com');
    const older = tokenFrom(w.outbox.messages[0]!.text);
    await forgot(app, 'mira@example.com');
    const newer = tokenFrom(w.outbox.messages[1]!.text);
    expect(older).not.toBe(newer);
    // A superseded token is dead even before it expires.
    expect((await reset(app, older, 'second password')).status).toBe(400);
    expect((await reset(app, newer, 'second password')).status).toBe(204);
    // Single use.
    expect((await reset(app, newer, 'third password')).status).toBe(400);
    // Old password gone, new one works, every earlier session is revoked.
    expect(
      (await app.request('/api/auth/login', json({ username: 'mira', password: 'first password' })))
        .status,
    ).toBe(401);
    expect(
      (
        await app.request(
          '/api/auth/login',
          json({ username: 'mira', password: 'second password' }),
        )
      ).status,
    ).toBe(200);
    expect((await app.request('/api/auth/me', bearer(first.token))).status).toBe(401);
    expect((await app.request('/api/auth/me', bearer(phone.token))).status).toBe(401);
    const rows = w.db.select().from(t.passwordResets).all();
    expect(rows.every((r) => r.usedAt !== null || r.invalidatedAt !== null)).toBe(true);
  });

  it('expires tokens after 30 minutes and rejects garbage and weak passwords', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    await registered(app, 'mira', 'mira@example.com');
    await forgot(app, 'mira@example.com');
    const token = tokenFrom(w.outbox.messages[0]!.text);
    expect((await reset(app, token, 'short')).status).toBe(400);
    expect((await reset(app, 'f'.repeat(64), 'long enough password')).status).toBe(400);
    w.clock.advance(RESET_TOKEN_TTL_MS + 1);
    const late = await reset(app, token, 'long enough password');
    expect(late.status).toBe(400);
    expect(((await late.json()) as { error: { code: string } }).error.code).toBe('reset_invalid');
    expect(
      (await app.request('/api/auth/login', json({ username: 'mira', password: 'first password' })))
        .status,
    ).toBe(200);
  });

  it('rate limits requests per address and per address book entry', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    await registered(app, 'mira', 'mira@example.com');
    for (let i = 0; i < FORGOT_PER_EMAIL.limit; i++)
      expect((await forgot(app, 'mira@example.com')).status).toBe(202);
    expect((await forgot(app, 'mira@example.com')).status).toBe(429);
    expect(w.outbox.messages).toHaveLength(FORGOT_PER_EMAIL.limit);
  });
});

describe('mail configuration', () => {
  it('builds every provider without loading a mail library', () => {
    // Starting the API must never depend on nodemailer: only an actual SMTP send does. A hard
    // import here would take the whole server down when the package is missing or unbuilt, and
    // the web app would then show every request as a server it cannot reach.
    const base = testConfig().mail;
    expect(createMailer({ ...base, provider: 'outbox' })).toBeInstanceOf(OutboxMailer);
    expect(createMailer({ ...base, provider: 'disabled' })).toBeInstanceOf(DisabledMailer);
    const smtp = createMailer({
      ...base,
      provider: 'smtp',
      smtp: { ...base.smtp, host: 'smtp.example.com' },
    });
    expect(smtp).toBeInstanceOf(SmtpMailer);
    expect(smtp.kind).toBe('smtp');
  });

  it('never allows the development outbox outside dev mode and drops mail when disabled', async () => {
    const prod = testConfig({ devMode: false });
    expect(createMailer({ ...prod.mail, provider: 'disabled' })).toBeInstanceOf(DisabledMailer);
    expect(() => createMailer({ ...prod.mail, provider: 'smtp' })).toThrow(/MIB_SMTP_HOST/);
    const w = createTestWorld({ devMode: false });
    const app = createApp({ ...w.ctx, mailer: new DisabledMailer() });
    const res = await app.request(
      '/api/auth/password/forgot',
      json({ email: 'anyone@example.com' }),
    );
    expect(res.status).toBe(202);
    // No dev routes, so no outbox is reachable in production.
    expect((await app.request('/api/dev/outbox')).status).toBe(404);
  });
});
