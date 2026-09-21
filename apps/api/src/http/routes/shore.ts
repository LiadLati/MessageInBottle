import { Hono } from 'hono';
import {
  getMyShore,
  listReceivedLetters,
  openBottle,
  readOpenedLetter,
} from '../../services/bottles.js';
import type { AppEnv } from '../app.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePolicies } from '../middleware/policies.js';

export function shoreRoutes() {
  const r = new Hono<AppEnv>();
  r.use('*', requireAuth, requirePolicies);
  r.get('/', (c) => c.json(getMyShore(c.get('ctx'), c.get('user'))));
  r.get('/received', (c) => c.json({ letters: listReceivedLetters(c.get('ctx'), c.get('user')) }));
  r.post('/bottles/:id/open', (c) =>
    c.json(openBottle(c.get('ctx'), c.get('user'), c.req.param('id'))),
  );
  r.get('/bottles/:id/letter', (c) =>
    c.json(readOpenedLetter(c.get('ctx'), c.get('user'), c.req.param('id'))),
  );
  return r;
}
