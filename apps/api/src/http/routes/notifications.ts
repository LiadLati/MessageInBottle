import { Hono } from 'hono';
import { listNotifications, markAllRead } from '../../services/notifications.js';
import type { AppEnv } from '../app.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePolicies } from '../middleware/policies.js';

export function notificationRoutes() {
  const r = new Hono<AppEnv>();
  r.use('*', requireAuth, requirePolicies);
  r.get('/', (c) => c.json({ notifications: listNotifications(c.get('ctx'), c.get('user').id) }));
  r.post('/read-all', (c) => {
    markAllRead(c.get('ctx'), c.get('user').id);
    return c.body(null, 204);
  });
  return r;
}
