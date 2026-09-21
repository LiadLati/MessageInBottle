import { createMiddleware } from 'hono/factory';
import { forbidden } from '../../lib/errors.js';
import { assertNotRestricted } from '../../services/moderation.js';
import type { AppEnv } from '../app.js';

// Admin authorisation is enforced here, on every admin endpoint, from the role the users row
// carries — never from anything a client sends. Runs after requireAuth.
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('user').role !== 'admin') throw forbidden('admin access required');
  await next();
});

// A suspended or banned account may sign in, read its standing, appeal and sign out — and
// nothing else. Everything behind this middleware answers 403 for it.
export const requireGoodStanding = createMiddleware<AppEnv>(async (c, next) => {
  assertNotRestricted(c.get('ctx'), c.get('user'));
  await next();
});
