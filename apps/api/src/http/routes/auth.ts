import { Hono } from 'hono';
import { DevLoginRequestSchema } from '@mib/shared';
import { devLogin, logout } from '../../services/auth.js';
import type { AppEnv } from '../app.js';
import { requireAuth } from '../middleware/auth.js';
import { jsonBody } from '../validate.js';

export function authRoutes() {
  const r = new Hono<AppEnv>();
  r.post('/dev-login', jsonBody(DevLoginRequestSchema), (c) => {
    const { username } = c.req.valid('json');
    return c.json(devLogin(c.get('ctx'), username), 200);
  });
  r.get('/me', requireAuth, (c) => c.json(c.get('user')));
  r.post('/logout', requireAuth, (c) => {
    logout(c.get('ctx'), c.get('token'));
    return c.body(null, 204);
  });
  return r;
}
