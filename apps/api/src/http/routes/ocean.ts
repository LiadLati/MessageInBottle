import { Hono } from 'hono';
import { closeReading, listPublicOcean, openPublicBottle } from '../../services/outcomes.js';
import { blockFoundWriter } from '../../services/friends.js';
import { accountWeather } from '../../services/weather.js';
import type { AppEnv } from '../app.js';
import { requireAuth } from '../middleware/auth.js';
import { requireGoodStanding } from '../middleware/admin.js';
import { requirePolicies } from '../middleware/policies.js';

// The public ocean: bottles adrift, visible to every signed-in user through the strict public
// projection only (spec §10.3, D03/D11: authenticated access, no sender or recipient identity).
export function oceanRoutes() {
  const r = new Hono<AppEnv>();
  r.use('*', requireAuth, requirePolicies, requireGoodStanding);
  // The account's map clock and storm, the same for every device of the account (policy v4).
  r.get('/weather', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(accountWeather(c.get('ctx'), c.get('user').id));
  });
  r.get('/public', (c) => {
    const ctx = c.get('ctx');
    return c.json({
      bottles: listPublicOcean(ctx, c.get('user')),
      serverTime: new Date(ctx.clock.now()).toISOString(),
    });
  });
  // One atomic action: it serves the finder the letter, once, and removes the bottle from the
  // public map for everyone. A second open is a 409, for the finder and for everyone else.
  r.post('/public/:id/open', (c) => {
    // A one-time reading: never cached anywhere between the server and the finder's screen.
    c.header('Cache-Control', 'no-store');
    return c.json(openPublicBottle(c.get('ctx'), c.get('user'), c.req.param('id')));
  });
  // Finishing the one reading.
  r.post('/public/:id/close', (c) => {
    closeReading(c.get('ctx'), c.get('user'), c.req.param('id'));
    return c.body(null, 204);
  });
  // Blocking the writer from inside the reading, without ever learning who they are.
  r.post('/public/:id/block', (c) => {
    blockFoundWriter(c.get('ctx'), c.get('user').id, c.req.param('id'));
    return c.body(null, 204);
  });
  return r;
}
