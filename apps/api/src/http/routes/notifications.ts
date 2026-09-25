import { Hono } from 'hono';
import { markAllRead, notificationPage } from '../../services/notifications.js';
import type { AppEnv } from '../app.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePolicies } from '../middleware/policies.js';
import { requireGoodStanding } from '../middleware/admin.js';

export function notificationRoutes() {
  const r = new Hono<AppEnv>();
  // A suspended or banned account has no ordinary inbox (product decision 14): its standing
  // screen carries the decision instead. The history itself is untouched and comes back when a
  // suspension ends.
  r.use('*', requireAuth, requirePolicies, requireGoodStanding);
  r.get('/', (c) => {
    const limit = Number(c.req.query('limit'));
    return c.json(
      notificationPage(c.get('ctx'), c.get('user').id, {
        before: c.req.query('before') ?? null,
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      }),
    );
  });
  r.post('/read-all', (c) => {
    markAllRead(c.get('ctx'), c.get('user').id);
    return c.body(null, 204);
  });
  return r;
}
