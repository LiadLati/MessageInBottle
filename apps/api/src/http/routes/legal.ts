import { Hono } from 'hono';
import type { Context } from 'hono';
import { clientAddress } from '../client-address.js';
import { chargeSignIn, clearSignIn } from './auth.js';
import {
  PUBLISHED_DOCUMENTS,
  SUPPORT_NAME,
  normalizeUsername,
  publishedDocumentBySlug,
} from '@mib/shared';
import { AppError } from '../../lib/errors.js';
import { RateLimiter, type RateLimitRule } from '../../lib/rate-limit.js';
import { login } from '../../services/auth.js';
import { deleteAccount, verifyAccountPassword } from '../../services/deletion.js';
import type { AppEnv } from '../app.js';
import {
  documentPage,
  deletionDonePage,
  deletionPage,
  notFoundPage,
  page,
} from '../legal-pages.js';

// The public legal surface: unauthenticated HTML at stable URLs, suitable for a store listing.
// Nothing here needs a session, JavaScript or a PDF reader, and the deletion form below is a
// plain form post so it works in any browser.
export const DELETE_PER_ADDRESS: RateLimitRule = { limit: 10, windowMs: 15 * 60 * 1000 };

export function legalRoutes(limiter = new RateLimiter()) {
  const r = new Hono<AppEnv>();
  const html = (c: Context<AppEnv>, body: string, status = 200) =>
    c.html(body, status as 200, { 'cache-control': 'public, max-age=300' });

  // An index, so one link covers everything a reviewer needs to find.
  r.get('/', (c) =>
    html(
      c,
      page({
        title: 'Legal and safety',
        description:
          'Terms of Use, Community Rules, Privacy Policy, Child Safety Standards and account deletion for SeaYou.',
        slug: '',
        body: `<h1>Legal and safety</h1>
<p>These documents apply to everyone who uses SeaYou. They are published here so they can be read before creating an account, and at any time afterwards.</p>
<ul>${PUBLISHED_DOCUMENTS.map(
          (d) => `<li><a href="/legal/${d.slug}">${d.title}</a> — ${d.summary}</li>`,
        ).join('')}
<li><a href="/legal/delete-account">Delete your account</a> — remove your account and its associated data without reinstalling SeaYou.</li>
<li><a href="/support">Support</a> — how to reach ${SUPPORT_NAME} about your account, your privacy, safety or a technical problem.</li></ul>`,
      }),
    ),
  );

  // The deletion page is declared before the catch-all document route so its slug wins.
  r.get('/delete-account', (c) => html(c, deletionPage({})));

  r.post('/delete-account', async (c) => {
    const form = await c.req.formData();
    // A form field is a string or a File; only a string is ever a credential here.
    const field = (name: string): string => {
      const value = form.get(name);
      return typeof value === 'string' ? value : '';
    };
    const username = field('username').trim();
    const password = field('password');
    const confirmed = form.get('confirm') !== null;
    const back = (error: string) =>
      c.html(deletionPage({ error, username }), 400, { 'cache-control': 'no-store' });

    if (!username || !password) return back('Enter the username and password of the account.');
    if (!confirmed) return back('Tick the box to confirm that deletion is permanent.');

    // One address cannot sit here guessing credentials, and this form spends the same
    // per-account sign-in budget as the sign-in endpoint: it is not a side door (ARCH-009).
    const key = clientAddress(c);
    if (!limiter.hit(`legal-delete:${key}`, DELETE_PER_ADDRESS).allowed)
      return back('Too many attempts from this device. Wait a few minutes and try again.');
    if (!chargeSignIn(limiter, username, key).allowed)
      return back('Too many attempts for this account. Wait a few minutes and try again.');

    const ctx = c.get('ctx');
    let userId: string;
    try {
      // Signing in proves the account exists and the password is right; the second check keeps
      // the in-app path and this one on exactly the same rule.
      const session = await login(ctx, { username: normalizeUsername(username), password });
      userId = session.user.id;
      await verifyAccountPassword(ctx, userId, password);
    } catch (err) {
      if (err instanceof AppError && (err.status === 401 || err.status === 404))
        return back('That username and password do not match an account.');
      throw err;
    }
    clearSignIn(limiter, username, key);
    deleteAccount(ctx, userId);
    return c.html(deletionDonePage(), 200, { 'cache-control': 'no-store' });
  });

  r.get('/:slug', (c) => {
    const doc = publishedDocumentBySlug(c.req.param('slug'));
    if (!doc) return c.html(notFoundPage(), 404, { 'cache-control': 'no-store' });
    return html(c, documentPage(doc));
  });

  return r;
}
