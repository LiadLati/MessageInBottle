import { Hono } from 'hono';
import { SetShoreRequestSchema } from '@mib/shared';
import { getChart, setUserShore } from '../../services/chart.js';
import { harbourMovesMapClock } from '../../services/weather.js';
import { tooManyRequests } from '../../lib/errors.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { ZONE_CHANGES_PER_ACCOUNT } from './auth.js';
import type { AppEnv } from '../app.js';
import { requireAuth } from '../middleware/auth.js';
import { requireGoodStanding } from '../middleware/admin.js';
import { requirePolicies } from '../middleware/policies.js';
import { jsonBody } from '../validate.js';

export function chartRoutes(limiter = new RateLimiter()) {
  const r = new Hono<AppEnv>();
  r.get('/', requireAuth, requirePolicies, requireGoodStanding, (c) =>
    c.json(getChart(c.get('ctx'))),
  );
  r.put(
    '/my-shore',
    requireAuth,
    requirePolicies,
    requireGoodStanding,
    jsonBody(SetShoreRequestSchema),
    (c) => {
      const ctx = c.get('ctx');
      const userId = c.get('user').id;
      const { shoreId } = c.req.valid('json');
      // Before any device has reported a zone, the harbour sets the map clock, so changing it
      // spends the same daily budget as a device zone change (audit ARCH-R-010): flipping
      // harbours cannot flip the map between day and night more often than travel would.
      if (harbourMovesMapClock(ctx, userId, shoreId)) {
        const d = limiter.hit(`tz:${userId}`, ZONE_CHANGES_PER_ACCOUNT);
        if (!d.allowed) throw tooManyRequests(d.retryAfterMs);
      }
      setUserShore(ctx, userId, shoreId);
      return c.body(null, 204);
    },
  );
  return r;
}
