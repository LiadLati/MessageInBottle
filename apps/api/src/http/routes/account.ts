import { Hono } from 'hono';
import { DeleteAccountRequestSchema } from '@mib/shared';
import { deleteAccount, verifyAccountPassword } from '../../services/deletion.js';
import type { AppEnv } from '../app.js';
import { requireAuth } from '../middleware/auth.js';
import { jsonBody } from '../validate.js';

// Account actions that must stay reachable whatever else is blocking the account: a suspended,
// banned or not-yet-accepted-the-terms account can still delete itself. Only `requireAuth`
// guards this, deliberately — deletion is never something a person should have to argue for.
export function accountRoutes() {
  const r = new Hono<AppEnv>();
  r.use('*', requireAuth);
  r.post('/delete', jsonBody(DeleteAccountRequestSchema), async (c) => {
    const ctx = c.get('ctx');
    const user = c.get('user');
    await verifyAccountPassword(ctx, user.id, c.req.valid('json').password);
    const summary = deleteAccount(ctx, user.id);
    return c.json({ deletedAt: summary.deletedAt, alreadyDeleted: summary.alreadyDeleted });
  });
  return r;
}
