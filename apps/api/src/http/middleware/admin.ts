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

// DEV simulation controls need *both* the developer role and a non-production environment.
//
// Two independent conditions on purpose. The role keeps ordinary members and administrators
// out — an administrator does not get simulation controls merely for being an administrator,
// because deciding real reports and fabricating test events are different jobs. The
// environment check keeps the controls out of production even for a developer-role account,
// so a role granted for a staging database cannot move time or sink a stranger's bottle in
// the live one. Neither check can be satisfied by anything a client sends.
export const requireDeveloper = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get('ctx').config.devMode)
    throw forbidden('development controls are not available in this environment');
  if (c.get('user').role !== 'developer') throw forbidden('developer access required');
  await next();
});

// A suspended or banned account may sign in, read its standing, appeal and sign out — and
// nothing else. Everything behind this middleware answers 403 for it.
export const requireGoodStanding = createMiddleware<AppEnv>(async (c, next) => {
  assertNotRestricted(c.get('ctx'), c.get('user'));
  await next();
});
