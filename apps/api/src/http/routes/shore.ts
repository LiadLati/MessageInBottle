import { Hono } from 'hono';
import { getMyShore, openBottle, readOpenedLetter } from '../../services/bottles.js';
import type { AppEnv } from '../app.js';
import { requireAuth } from '../middleware/auth.js';

export function shoreRoutes() {
  const r = new Hono<AppEnv>();
  r.use('*', requireAuth);
  r.get('/', (c) => c.json(getMyShore(c.get('ctx'), c.get('user'))));
  r.post('/bottles/:id/open', (c) =>
    c.json(openBottle(c.get('ctx'), c.get('user'), c.req.param('id'))),
  );
  r.get('/bottles/:id/letter', (c) =>
    c.json(readOpenedLetter(c.get('ctx'), c.get('user'), c.req.param('id'))),
  );
  return r;
}
