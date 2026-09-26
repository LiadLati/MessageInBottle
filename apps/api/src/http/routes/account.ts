import { Hono } from 'hono';
import { DeleteAccountRequestSchema } from '@mib/shared';
import { tooManyRequests } from '../../lib/errors.js';
import { RateLimiter, type RateLimitRule } from '../../lib/rate-limit.js';
import { deleteAccount, verifyAccountPassword } from '../../services/deletion.js';
import type { AppEnv } from '../app.js';
import { clientAddress } from '../client-address.js';
import { requireAuth } from '../middleware/auth.js';
import { jsonBody } from '../validate.js';

// Account actions that must stay reachable whatever else is blocking the account: a suspended,
// banned or not-yet-accepted-the-terms account can still delete itself. Only `requireAuth`
// guards this, deliberately — deletion is never something a person should have to argue for.
//
// Confirming deletion checks the password, which takes a slot in the bounded password-hashing
// queue that every sign-in, registration and reset also waits in. Attempts are therefore counted
// before the password is checked, per signed-in account and per client address (the same
// trusted-proxy rules as sign-in), and refused with 429 past either budget (audit SEC-R-001).
// Each budget belongs to one account or one address, so exhausting it blocks only that caller,
// and the answer to a counted attempt never depends on whether the password was right.
export const DELETE_PER_ACCOUNT: RateLimitRule = { limit: 5, windowMs: 15 * 60 * 1000 };
export const DELETE_PER_ADDRESS: RateLimitRule = { limit: 10, windowMs: 15 * 60 * 1000 };

export function accountRoutes(limiter = new RateLimiter()) {
  const r = new Hono<AppEnv>();
  r.use('*', requireAuth);
  r.post('/delete', jsonBody(DeleteAccountRequestSchema), async (c) => {
    const ctx = c.get('ctx');
    const user = c.get('user');
    // The account's own budget first: an attempt it refuses costs its neighbours on a shared
    // address nothing.
    const byAccount = limiter.hit(`account-delete:user:${user.id}`, DELETE_PER_ACCOUNT);
    if (!byAccount.allowed) throw tooManyRequests(byAccount.retryAfterMs);
    const byAddress = limiter.hit(`account-delete:addr:${clientAddress(c)}`, DELETE_PER_ADDRESS);
    if (!byAddress.allowed) throw tooManyRequests(byAddress.retryAfterMs);
    await verifyAccountPassword(ctx, user.id, c.req.valid('json').password);
    const summary = deleteAccount(ctx, user.id);
    return c.json({ deletedAt: summary.deletedAt, alreadyDeleted: summary.alreadyDeleted });
  });
  return r;
}
