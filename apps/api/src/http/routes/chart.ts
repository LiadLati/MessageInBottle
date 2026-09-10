import { Hono } from 'hono';
import { SetShoreRequestSchema } from '@mib/shared';
import { getChart, setUserShore } from '../../services/chart.js';
import type { AppEnv } from '../app.js';
import { requireAuth } from '../middleware/auth.js';
import { jsonBody } from '../validate.js';

export function chartRoutes() {
  const r = new Hono<AppEnv>();
  r.get('/', requireAuth, (c) => c.json(getChart(c.get('ctx'))));
  r.put('/my-shore', requireAuth, jsonBody(SetShoreRequestSchema), (c) => {
    setUserShore(c.get('ctx'), c.get('user').id, c.req.valid('json').shoreId);
    return c.body(null, 204);
  });
  return r;
}
