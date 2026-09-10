import { createMiddleware } from 'hono/factory';
import { unauthorized } from '../../lib/errors.js';
import { resolveSession } from '../../services/auth.js';
import type { AppEnv } from '../app.js';

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw unauthorized();
  const user = resolveSession(c.get('ctx'), token);
  if (!user) throw unauthorized();
  c.set('user', user);
  c.set('token', token);
  await next();
});
