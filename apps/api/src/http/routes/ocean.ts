import { Hono } from 'hono';
import { listPublicOcean } from '../../services/outcomes.js';
import type { AppEnv } from '../app.js';
import { requireAuth } from '../middleware/auth.js';

// The public ocean: bottles adrift, visible to every signed-in user through the strict public
// projection only (spec §10.3, D03/D11: authenticated access, no sender or recipient identity).
export function oceanRoutes() {
  const r = new Hono<AppEnv>();
  r.use('*', requireAuth);
  r.get('/public', (c) => {
    const ctx = c.get('ctx');
    return c.json({
      bottles: listPublicOcean(ctx, c.get('user')),
      serverTime: new Date(ctx.clock.now()).toISOString(),
    });
  });
  return r;
}
