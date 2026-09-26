import { describe, expect, it } from 'vitest';
import {
  PUBLISHED_DOCUMENTS,
  SUPPORT_CATEGORIES,
  SUPPORT_EMAIL,
  SUPPORT_NAME,
  supportMailto,
} from '@mib/shared';
import { createApp } from './app.js';
import { createTestWorld, legacyAccount, loginAs } from '../test/harness.js';
import { DEV_SEED_PASSWORD } from '../db/seed-data.js';

const get = (app: ReturnType<typeof createApp>, path: string, token?: string) =>
  app.request(path, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);

describe('the public support page', () => {
  it('is served without signing in, as responsive HTML that needs no JavaScript', async () => {
    const app = createApp(createTestWorld().ctx);
    const res = await get(app, '/support');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toContain('name="viewport"');
    // No script of any kind: every control on the page is a link.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/on(click|load|submit)=/i);
    expect(html).not.toMatch(/\.pdf/i);
  });

  it('shows the support identity and an address that can be copied by hand', async () => {
    const app = createApp(createTestWorld().ctx);
    const html = await (await get(app, '/support')).text();
    expect(html).toContain(SUPPORT_NAME);
    expect(html).toContain(SUPPORT_EMAIL);
    expect(html).toContain('>Contact Support</a>');
    // The address is selectable text, not only inside a mailto, for a device with no mail client.
    expect(html).toContain(`<code>${SUPPORT_EMAIL}</code>`);
    expect(html).toMatch(/cannot open an email client/i);
  });

  it('offers all five categories, each a mailto to the support address with an encoded subject', async () => {
    const app = createApp(createTestWorld().ctx);
    const html = await (await get(app, '/support')).text();
    const labels = [
      'Account help',
      'Privacy request',
      'Safety or abusive content',
      'Technical problem',
      'Other',
    ];
    expect(SUPPORT_CATEGORIES.map((c) => c.label)).toEqual(labels);
    const subjects = [
      'SeaYou Support — Account help',
      'SeaYou Support — Privacy request',
      'SeaYou Support — Safety report',
      'SeaYou Support — Technical problem',
      'SeaYou Support — Other',
    ];
    expect(SUPPORT_CATEGORIES.map((c) => c.subject)).toEqual(subjects);
    for (const [i, label] of labels.entries()) {
      expect(html, label).toContain(`>${label}</a>`);
      expect(html, label).toContain(supportMailto(SUPPORT_EMAIL, subjects[i]!));
    }
    // Every mailto on the page goes to the support address, and every one carries a subject.
    const links = [...html.matchAll(/href="(mailto:[^"]+)"/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThanOrEqual(6);
    for (const link of links) {
      expect(link.startsWith(`mailto:${SUPPORT_EMAIL}?subject=`), link).toBe(true);
      const subject = link.slice(`mailto:${SUPPORT_EMAIL}?subject=`.length);
      expect(subject, link).not.toContain(' ');
      expect(decodeURIComponent(subject).startsWith(SUPPORT_NAME), link).toBe(true);
    }
  });

  it('warns against sending credentials, and contains none itself', async () => {
    const app = createApp(createTestWorld().ctx);
    const html = await (await get(app, '/support')).text();
    for (const warning of [
      /password/i,
      /verification/i,
      /Gmail/i,
      /payment/i,
      /identity document/i,
    ]) {
      expect(html, String(warning)).toMatch(warning);
    }
    expect(html).toMatch(/never ask you for any of them/i);
    // Nothing that looks like a secret, and nothing left unfinished.
    for (const forbidden of [
      /app[- ]password/i,
      /oauth/i,
      /smtp/i,
      /client[_ ]secret/i,
      /api[_ ]key/i,
      /\bTBD\b/i,
      /\bTODO\b/i,
      /placeholder/i,
      /lorem ipsum/i,
      /\[\[/,
    ]) {
      expect(html, String(forbidden)).not.toMatch(forbidden);
    }
    // One address on the page, and it is the support address.
    const addresses = new Set(html.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? []);
    expect([...addresses]).toEqual([SUPPORT_EMAIL]);
  });

  it('links to every legal document and to account deletion', async () => {
    const app = createApp(createTestWorld().ctx);
    const html = await (await get(app, '/support')).text();
    for (const doc of PUBLISHED_DOCUMENTS) expect(html, doc.slug).toContain(`/legal/${doc.slug}`);
    expect(html).toContain('/legal/delete-account');
  });

  it('honours an overridden support address everywhere on the page', async () => {
    const app = createApp(createTestWorld({ supportEmail: 'other.support@example.test' }).ctx);
    const html = await (await get(app, '/support')).text();
    expect(html).toContain('other.support@example.test');
    expect(html).not.toContain(SUPPORT_EMAIL);
    for (const link of [...html.matchAll(/href="(mailto:[^"]+)"/g)].map((m) => m[1]!))
      expect(link.startsWith('mailto:other.support@example.test?subject=')).toBe(true);
  });
});

describe('an unknown legal address (FE-018)', () => {
  it('is an HTML page with a way back, not an API error body', async () => {
    const res = await get(createApp(createTestWorld().ctx), '/legal/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('<html lang="en"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('href="/legal"');
    expect(html).toContain('noindex');
    expect(html).not.toContain('not_found');
  });
});

describe('support stays reachable', () => {
  it('from every public legal page', async () => {
    const app = createApp(createTestWorld().ctx);
    for (const path of [
      '/legal',
      '/legal/terms',
      '/legal/community-rules',
      '/legal/privacy',
      '/legal/child-safety',
      '/legal/delete-account',
    ]) {
      const html = await (await get(app, path)).text();
      expect(html, path).toContain('href="/support"');
    }
  });

  it('while signed out, gated by a new policy version, suspended, or deleting the account', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    // Signed out.
    expect((await get(app, '/support')).status).toBe(200);
    // An account that must accept the current documents: every ordinary route is closed to it,
    // and support is not one of them.
    const legacy = legacyAccount(w);
    expect((await get(app, '/api/chart', legacy.token)).status).toBe(403);
    expect((await get(app, '/support', legacy.token)).status).toBe(200);
    // A signed-in account in good standing.
    const ada = await loginAs(app, 'ada');
    expect((await get(app, '/support', ada.token)).status).toBe(200);
    // And after the account is gone.
    const res = await app.request('/api/account/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ada.token}` },
      body: JSON.stringify({ password: DEV_SEED_PASSWORD, confirm: true }),
    });
    expect(res.status).toBe(200);
    expect((await get(app, '/support')).status).toBe(200);
  });
});
