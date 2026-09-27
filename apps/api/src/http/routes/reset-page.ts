import { Hono } from 'hono';
import type { Context } from 'hono';
import { ResetPasswordRequestSchema } from '@mib/shared';
import { clientAddress } from '../client-address.js';
import { AppError } from '../../lib/errors.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { resetPassword, resetTokenUsable } from '../../services/auth.js';
import type { AppEnv } from '../app.js';
import { resetLinkInvalidPage, resetPasswordDonePage, resetPasswordPage } from '../legal-pages.js';
import { RESET_PER_ADDRESS } from './auth.js';

// Where the link in a password-reset e-mail leads. SeaYou's interface is an Android app, so the
// link cannot open it as a web page; the server shows one plain form instead (no JavaScript,
// no sign-in) and applies exactly the reset the API route applies: same token rules, same
// password rules, same per-address budget, every session ended afterwards.
export function resetPageRoutes(limiter = new RateLimiter()) {
  const r = new Hono<AppEnv>();
  const noStore = { 'cache-control': 'no-store' };
  const shape = (token: string) => ResetPasswordRequestSchema.shape.token.safeParse(token).success;

  r.get('/', (c) => {
    const token = c.req.query('token') ?? '';
    if (!shape(token) || !resetTokenUsable(c.get('ctx'), token))
      return c.html(resetLinkInvalidPage(), 400, noStore);
    return c.html(resetPasswordPage({ token }), 200, noStore);
  });

  r.post('/', async (c: Context<AppEnv>) => {
    const form = await c.req.formData();
    const field = (name: string): string => {
      const value = form.get(name);
      return typeof value === 'string' ? value : '';
    };
    const token = field('token');
    const password = field('password');
    const back = (error: string) => c.html(resetPasswordPage({ token, error }), 400, noStore);

    if (!shape(token)) return c.html(resetLinkInvalidPage(), 400, noStore);
    if (!limiter.hit(`reset:addr:${clientAddress(c)}`, RESET_PER_ADDRESS).allowed)
      return back('Too many attempts from this device. Wait a few minutes and try again.');
    if (password !== field('confirm')) return back('The two passwords are not the same.');
    const request = ResetPasswordRequestSchema.safeParse({ token, password });
    if (!request.success) return back('Choose a password of 8 to 128 characters.');
    try {
      await resetPassword(c.get('ctx'), request.data);
    } catch (err) {
      if (err instanceof AppError && err.code === 'reset_invalid')
        return c.html(resetLinkInvalidPage(), 400, noStore);
      throw err;
    }
    return c.html(resetPasswordDonePage(), 200, noStore);
  });

  return r;
}
