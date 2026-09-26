import net from 'node:net';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { RESET_TOKEN_TTL_MS } from '@mib/shared';
import * as t from '../db/schema.js';
import { SmtpMailer } from '../lib/mail.js';
import { createApp } from './app.js';
import { createTestWorld, loginAs } from '../test/harness.js';

// Product decision 4: the public Forgot Password flow sends a real one-time link through SMTP.
// This drives the production SmtpMailer (nodemailer) against a minimal SMTP server on
// localhost — a fake provider. No test ever contacts a real mailbox, and the password below is
// a placeholder, not a credential.

interface Captured {
  from: string;
  to: string[];
  data: string;
  auth: string | null;
}

// Speaks just enough SMTP for nodemailer: greeting, EHLO with AUTH PLAIN, MAIL, RCPT, DATA.
function fakeSmtp(): Promise<{ port: number; messages: Captured[]; close: () => Promise<void> }> {
  const messages: Captured[] = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let current: Captured = { from: '', to: [], data: '', auth: null };
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply('220 fake.smtp.test ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let i: number;
      while ((i = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(current);
            current = { from: '', to: [], data: '', auth: current.auth };
            reply('250 2.0.0 queued');
          } else current.data += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') {
          reply('250-fake.smtp.test');
          reply('250 AUTH PLAIN');
        } else if (verb === 'AUTH') {
          current.auth = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8');
          reply('235 2.7.0 accepted');
        } else if (verb === 'MAIL') {
          current.from = line;
          reply('250 ok');
        } else if (verb === 'RCPT') {
          current.to.push(line);
          reply('250 ok');
        } else if (verb === 'DATA') {
          inData = true;
          reply('354 go ahead');
        } else if (verb === 'QUIT') {
          reply('221 bye');
          socket.end();
        } else reply('250 ok');
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        messages,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    ),
  );
}

// Quoted-printable soft breaks and escapes, so the link can be read back out of the body.
const decodeQp = (s: string) =>
  s
    .replace(/=\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

let smtp: Awaited<ReturnType<typeof fakeSmtp>> | null = null;
afterEach(async () => {
  await smtp?.close();
  smtp = null;
});

async function world() {
  smtp = await fakeSmtp();
  const w = createTestWorld();
  w.db.update(t.users).set({ email: 'ada@example.test' }).where(eq(t.users.username, 'ada')).run();
  w.ctx.mailer = new SmtpMailer({
    provider: 'smtp',
    from: 'SeaYou <seayou.support@gmail.com>',
    smtp: {
      host: '127.0.0.1',
      port: smtp.port,
      secure: false,
      user: 'seayou.support@gmail.com',
      pass: 'placeholder-not-a-credential',
    },
  });
  return { w, app: createApp(w.ctx) };
}
const forgot = (app: ReturnType<typeof createApp>, email: string) =>
  app.request('/api/auth/password/forgot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
const reset = (app: ReturnType<typeof createApp>, token: string, password: string) =>
  app.request('/api/auth/password/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, password }),
  });
async function nextMessage(count: number): Promise<Captured> {
  for (let i = 0; i < 200 && smtp!.messages.length < count; i++)
    await new Promise((r) => setTimeout(r, 10));
  const m = smtp!.messages[count - 1];
  if (!m) throw new Error('no message arrived at the fake SMTP server');
  return m;
}
const tokenIn = (m: Captured) => {
  const body = decodeQp(m.data);
  const match = /\/\?reset=([A-Za-z0-9_-]{32,128})/.exec(body);
  if (!match) throw new Error('no reset link in the message');
  return match[1]!;
};

// Waits until `count` links of Ada's have been superseded by a completed send.
async function settled(w: Awaited<ReturnType<typeof world>>['w'], count: number) {
  const superseded = () =>
    w.db
      .select()
      .from(t.passwordResets)
      .all()
      .filter((r) => r.invalidatedAt !== null).length;
  for (let i = 0; i < 500 && superseded() < count; i++) await new Promise((r) => setTimeout(r, 10));
  expect(superseded()).toBe(count);
}

describe('password reset through SMTP (product decision 4)', () => {
  it('renders and sends a one-time link from the project mailbox', async () => {
    const { app } = await world();
    expect((await forgot(app, 'ada@example.test')).status).toBe(202);
    const m = await nextMessage(1);
    expect(m.from).toMatch(/seayou\.support@gmail\.com/);
    expect(m.to.join()).toMatch(/ada@example\.test/);
    expect(m.auth).toContain('seayou.support@gmail.com');
    const body = decodeQp(m.data);
    expect(body).toMatch(/Subject: Reset your SeaYou password/);
    expect(body).toMatch(/30 minutes/);
    expect(body).toContain(
      `https://seayou.example/?reset=${tokenIn(m)}`.replace('https://seayou.example', ''),
    );
  });

  it('resets once, invalidates the older link, and ends every session', async () => {
    const { w, app } = await world();
    const session = await loginAs(app, 'ada');
    await forgot(app, 'ada@example.test');
    const older = tokenIn(await nextMessage(1));
    await forgot(app, 'ada@example.test');
    const newer = tokenIn(await nextMessage(2));
    expect(newer).not.toBe(older);
    // The fake server has the message before the sender has finished its own bookkeeping:
    // wait for the condition itself (the older link superseded), not for a length of time.
    await settled(w, 1);
    // The newer link superseded the older one once it was delivered.
    expect((await reset(app, older, 'a-new-password-1')).status).toBe(400);
    expect((await reset(app, newer, 'a-new-password-1')).status).toBe(204);
    // One use only.
    expect((await reset(app, newer, 'a-new-password-2')).status).toBe(400);
    // Sessions from before the reset are gone.
    const me = await app.request('/api/auth/me', {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(me.status).toBe(401);
  });

  it('a slow older send never withdraws a newer link', async () => {
    // Two requests in flight, the first delivered last: completion order must not matter.
    const w = createTestWorld();
    w.db
      .update(t.users)
      .set({ email: 'ada@example.test' })
      .where(eq(t.users.username, 'ada'))
      .run();
    const releases: Array<() => void> = [];
    w.ctx.mailer = {
      kind: 'smtp',
      send: () => new Promise<void>((resolve) => releases.push(resolve)),
    };
    const { requestPasswordReset } = await import('../services/auth.js');
    const first = requestPasswordReset(w.ctx, 'ada@example.test');
    const second = requestPasswordReset(w.ctx, 'ada@example.test');
    releases[1]!(); // the newer message is handed over first…
    await second;
    releases[0]!(); // …then the older one
    await first;
    const rows = w.db.select().from(t.passwordResets).all();
    expect(rows).toHaveLength(2);
    // The older link was superseded by the newer send; the newer link is still valid.
    const [olderRow, newerRow] = rows;
    expect(olderRow!.invalidatedAt).not.toBeNull();
    expect(newerRow!.invalidatedAt).toBeNull();
  });

  it('expires the link after 30 minutes of real time', async () => {
    const { w, app } = await world();
    await forgot(app, 'ada@example.test');
    const token = tokenIn(await nextMessage(1));
    w.realClock.advance(RESET_TOKEN_TTL_MS + 1);
    expect(RESET_TOKEN_TTL_MS).toBe(30 * 60 * 1000);
    expect((await reset(app, token, 'a-new-password-1')).status).toBe(400);
  });

  it('sends nothing, and answers the same, for an address with no account', async () => {
    const { app } = await world();
    const unknown = await forgot(app, 'nobody@example.test');
    const known = await forgot(app, 'ada@example.test');
    expect(unknown.status).toBe(202);
    expect(await unknown.text()).toBe(await known.text());
    await nextMessage(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(smtp!.messages).toHaveLength(1);
    expect(smtp!.messages[0]!.to.join()).toMatch(/ada@example\.test/);
  });
});
