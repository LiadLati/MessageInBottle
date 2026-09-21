import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PUBLISHED_DOCUMENTS, SUPPORT_EMAIL } from '@mib/shared';
import { createApp } from './app.js';
import * as t from '../db/schema.js';
import { DEV_SEED_PASSWORD } from '../db/seed-data.js';
import {
  acceptCurrent,
  createTestWorld,
  legacyAccount,
  loginAs,
  releaseInput,
} from '../test/harness.js';
import { releaseBottle } from '../services/release.js';

const form = (fields: Record<string, string>) => {
  const body = new URLSearchParams(fields);
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  };
};

describe('public legal pages', () => {
  it('serve every document as responsive HTML at a stable URL, with no sign-in', async () => {
    const app = createApp(createTestWorld().ctx);
    for (const doc of PUBLISHED_DOCUMENTS) {
      const res = await app.request(`/legal/${doc.slug}`);
      expect(res.status, doc.slug).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      const html = await res.text();
      expect(html).toMatch(/^<!doctype html>/i);
      expect(html).toContain('<html lang="en" dir="ltr">');
      expect(html).toContain('name="viewport"');
      expect(html).toContain(`<h1>${doc.title}</h1>`);
      // The body of the document is really there, not a link to a file.
      expect(html).toContain(doc.blocks.find((b) => b.type === 'p')?.text ?? '');
      expect(html).not.toMatch(/\.pdf/i);
      // No draft, no Hebrew, no age claim anywhere on a public page.
      expect(html).not.toMatch(/[֐-׿]/);
      expect(html).not.toMatch(/\bdraft\b/i);
      expect(html).not.toMatch(/\b18\b/);
      expect(html).not.toMatch(/age[- ]?verif/i);
    }
  });

  it('publish an index and the four required pages, including child safety', async () => {
    const app = createApp(createTestWorld().ctx);
    const index = await app.request('/legal');
    expect(index.status).toBe(200);
    const html = await index.text();
    for (const slug of ['terms', 'community-rules', 'privacy', 'child-safety', 'delete-account'])
      expect(html, slug).toContain(`/legal/${slug}`);

    const cs = await (await app.request('/legal/child-safety')).text();
    expect(cs).toMatch(/child sexual abuse/i);
    expect(cs).toMatch(/grooming/i);
    expect(cs).toMatch(/report it from the reader/i);
    expect(cs).toMatch(/permanent ban/i);
    expect(cs).toMatch(/valid legal requests/i);
    expect(cs).toMatch(/support page/i);
    // It names the project support contact and nothing personal: one address on the page, and
    // it is the support address.
    expect(cs).toContain(SUPPORT_EMAIL);
    expect(cs).toContain('/support');
    const addresses = new Set(cs.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? []);
    expect([...addresses]).toEqual([SUPPORT_EMAIL]);
  });

  it('answer 404 for an unknown document', async () => {
    const app = createApp(createTestWorld().ctx);
    expect((await app.request('/legal/nonsense')).status).toBe(404);
  });
});

describe('the public account-deletion page', () => {
  it('explains what is deleted and offers a sign-in form', async () => {
    const app = createApp(createTestWorld().ctx);
    const res = await app.request('/legal/delete-account');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1>Delete your account</h1>');
    expect(html).toMatch(/every signed-in session ends at once/i);
    expect(html).toMatch(/letters of yours that are still at sea/i);
    expect(html).toMatch(/still open or still in force/i);
    expect(html).toContain('name="username"');
    expect(html).toContain('type="password"');
    expect(html).toContain('name="confirm"');
    expect(html).toMatch(/Settings → Delete account/);
  });

  it('refuses without the confirmation, and with the wrong password, changing nothing', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const noConfirm = await app.request(
      '/legal/delete-account',
      form({ username: 'ada', password: DEV_SEED_PASSWORD }),
    );
    expect(noConfirm.status).toBe(400);
    expect(await noConfirm.text()).toMatch(/Tick the box/);

    const wrong = await app.request(
      '/legal/delete-account',
      form({ username: 'ada', password: 'not-the-password', confirm: 'yes' }),
    );
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toMatch(/do not match an account/);
    expect(
      w.db.select().from(t.users).where(eq(t.users.username, 'ada')).get()!.deletedAt,
    ).toBeNull();
  });

  it('deletes the account from the web, ends its sessions and is safe to repeat', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const ada = await loginAs(app, 'ada');
    expect(
      (await app.request('/api/chart', { headers: { authorization: `Bearer ${ada.token}` } }))
        .status,
    ).toBe(200);

    const res = await app.request(
      '/legal/delete-account',
      form({ username: 'ada', password: DEV_SEED_PASSWORD, confirm: 'yes' }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Your account has been deleted/);

    const row = w.db.select().from(t.users).where(eq(t.users.id, ada.id)).get()!;
    expect(row.status).toBe('deleted');
    expect(row.deletedAt).not.toBeNull();
    expect(row.email).toBeNull();
    expect(row.passwordHash).toBeNull();
    expect(row.username).toMatch(/^deleted_/);
    expect(row.displayName).toBe('Deleted account');
    // The session is gone and cannot be used again.
    expect(w.db.select().from(t.sessions).where(eq(t.sessions.userId, ada.id)).all()).toHaveLength(
      0,
    );
    expect(
      (await app.request('/api/chart', { headers: { authorization: `Bearer ${ada.token}` } }))
        .status,
    ).toBe(401);

    // Repeating the request with the old credentials simply fails to sign in; nothing breaks.
    const again = await app.request(
      '/legal/delete-account',
      form({ username: 'ada', password: DEV_SEED_PASSWORD, confirm: 'yes' }),
    );
    expect(again.status).toBe(400);
  });
});

describe('the in-app deletion path', () => {
  it('needs the password and an explicit confirmation', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const bo = await loginAs(app, 'bo');
    const post = (body: unknown) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bo.token}` },
      body: JSON.stringify(body),
    });
    expect(
      (await app.request('/api/account/delete', post({ password: DEV_SEED_PASSWORD }))).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          '/api/account/delete',
          post({ password: DEV_SEED_PASSWORD, confirm: false }),
        )
      ).status,
    ).toBe(400);
    const wrong = await app.request(
      '/api/account/delete',
      post({ password: 'wrong-one', confirm: true }),
    );
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_password',
    );
    expect(w.db.select().from(t.users).where(eq(t.users.id, bo.id)).get()!.deletedAt).toBeNull();

    const ok = await app.request(
      '/api/account/delete',
      post({ password: DEV_SEED_PASSWORD, confirm: true }),
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { alreadyDeleted: boolean }).alreadyDeleted).toBe(false);
    expect(
      (await app.request('/api/auth/me', { headers: { authorization: `Bearer ${bo.token}` } }))
        .status,
    ).toBe(401);
  });

  it('stays available to an account that has not accepted the current policies', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const cy = legacyAccount(w, 'legacy_deleter');
    // Ordinary routes are gated…
    expect(
      (await app.request('/api/chart', { headers: { authorization: `Bearer ${cy.token}` } }))
        .status,
    ).toBe(403);
    // …deletion is not.
    const res = await app.request('/api/account/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cy.token}` },
      body: JSON.stringify({ password: DEV_SEED_PASSWORD, confirm: true }),
    });
    expect(res.status).toBe(200);
    expect(w.db.select().from(t.users).where(eq(t.users.id, cy.id)).get()!.status).toBe('deleted');
  });

  it('cancels letters still at sea, keeps delivered ones, and leaves moderation evidence alone', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const ada = w.user('ada');
    const bo = w.user('bo');
    const atSea = releaseBottle(w.ctx, ada, releaseInput(bo.id, 'del-key-0001')).bottleId;

    const before = w.db.select().from(t.bottles).where(eq(t.bottles.id, atSea)).get()!;
    expect(before.state).toBe('at_sea');
    const letterId = before.letterId;

    // A moderation case about a letter of Ada's must survive her deletion.
    const caseId = 'cas_test_retained';
    w.db
      .insert(t.moderationCases)
      .values({
        id: caseId,
        bottleId: atSea,
        letterId,
        senderId: ada.id,
        recipientId: bo.id,
        context: 'shore',
        status: 'pending',
        evidenceText: 'the evidence copy',
        evidenceFont: 'handwriting',
        evidenceCharacters: 17,
        createdAt: w.realClock.now(),
        updatedAt: w.realClock.now(),
        aiStatus: 'queued',
        aiAttempts: 0,
        aiNextAttemptAt: w.realClock.now(),
      })
      .run();

    const token = (await loginAs(app, 'ada')).token;
    const res = await app.request('/api/account/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ password: DEV_SEED_PASSWORD, confirm: true }),
    });
    expect(res.status).toBe(200);

    const after = w.db.select().from(t.bottles).where(eq(t.bottles.id, atSea)).get()!;
    expect(after.state).toBe('cancelled');
    expect(after.senderNameSnapshot).toBe('Deleted account');
    expect(w.db.select().from(t.letters).where(eq(t.letters.id, letterId)).get()!.text).toBe('');
    // The reserved place at the destination harbour is given back.
    const reservation = w.db
      .select()
      .from(t.capacityReservations)
      .where(eq(t.capacityReservations.bottleId, atSea))
      .get();
    expect(reservation?.status).toBe('released');
    // The evidence copy on the open case is untouched.
    const kase = w.db
      .select()
      .from(t.moderationCases)
      .where(eq(t.moderationCases.id, caseId))
      .get()!;
    expect(kase.evidenceText).toBe('the evidence copy');
    expect(kase.senderId).toBe(ada.id);
  });

  it('is idempotent at the service level', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const dee = await loginAs(app, 'dee');
    const { deleteAccount } = await import('../services/deletion.js');
    const first = deleteAccount(w.ctx, dee.id);
    expect(first.alreadyDeleted).toBe(false);
    const username = w.db.select().from(t.users).where(eq(t.users.id, dee.id)).get()!.username;
    w.realClock.advance(5000);
    const second = deleteAccount(w.ctx, dee.id);
    expect(second.alreadyDeleted).toBe(true);
    expect(second.deletedAt).toBe(first.deletedAt);
    // Nothing was renamed or changed a second time.
    expect(w.db.select().from(t.users).where(eq(t.users.id, dee.id)).get()!.username).toBe(
      username,
    );
  });

  it('registration is possible again afterwards and the freed username is not reused by accident', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const ada = await loginAs(app, 'ada');
    const { deleteAccount } = await import('../services/deletion.js');
    deleteAccount(w.ctx, ada.id);
    // The old username is released, so somebody may take it; it is a different account.
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'ada',
        email: 'ada-new@example.test',
        password: 'a long enough password',
        policies: acceptCurrent(),
      }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { user: { id: string } }).user.id).not.toBe(ada.id);
  });
});
