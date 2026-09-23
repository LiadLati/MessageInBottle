import { Hono } from 'hono';
import { ReleasePreviewRequestSchema, ReleaseRequestSchema } from '@mib/shared';
import { getSentBottle, listSentBottles, readOwnLetter } from '../../services/bottles.js';
import { acknowledgeOutcome, markOutcomeSeen } from '../../services/outcomes.js';
import { previewRelease, releaseBottle } from '../../services/release.js';
import { createMiddleware } from 'hono/factory';
import { tooManyRequests } from '../../lib/errors.js';
import { RateLimiter, type RateLimitRule } from '../../lib/rate-limit.js';
import type { AppEnv } from '../app.js';
import { requireAuth } from '../middleware/auth.js';
import { requireGoodStanding } from '../middleware/admin.js';
import { requirePolicies } from '../middleware/policies.js';
import { jsonBody } from '../validate.js';

// Planning a route is the most expensive thing a request can ask for (audit ARCH-012). Routes
// are cached per graph, but one account asking for previews and releases in a loop is still
// bounded: generous for a person choosing a recipient, small for a script.
export const PLAN_PER_ACCOUNT: RateLimitRule = { limit: 120, windowMs: 15 * 60 * 1000 };

export function bottleRoutes(limiter = new RateLimiter()) {
  const r = new Hono<AppEnv>();
  r.use('*', requireAuth, requirePolicies, requireGoodStanding);
  const plan = createMiddleware<AppEnv>(async (c, next) => {
    const d = limiter.hit(`plan:${c.get('user').id}`, PLAN_PER_ACCOUNT);
    if (!d.allowed) throw tooManyRequests(d.retryAfterMs);
    await next();
  });
  r.get('/sent', (c) => c.json({ bottles: listSentBottles(c.get('ctx'), c.get('user')) }));
  r.get('/sent/:id', (c) =>
    c.json({ bottle: getSentBottle(c.get('ctx'), c.get('user'), c.req.param('id')) }),
  );
  // The sender reading their own letter: a pure read, at any time, however often. It never
  // claims the bottle and never takes it off the public map.
  r.get('/sent/:id/letter', (c) =>
    c.json(readOwnLetter(c.get('ctx'), c.get('user'), c.req.param('id'))),
  );
  // Private-map visibility of a terminal marker (sender only; see services/outcomes.ts).
  r.post('/sent/:id/seen', (c) =>
    c.json({ visibility: markOutcomeSeen(c.get('ctx'), c.get('user'), c.req.param('id')) }),
  );
  r.post('/sent/:id/acknowledge', (c) =>
    c.json({ visibility: acknowledgeOutcome(c.get('ctx'), c.get('user'), c.req.param('id')) }),
  );
  r.post('/preview', plan, jsonBody(ReleasePreviewRequestSchema), (c) =>
    c.json(previewRelease(c.get('ctx'), c.get('user'), c.req.valid('json').recipientId)),
  );
  r.post('/release', plan, jsonBody(ReleaseRequestSchema), (c) => {
    const ctx = c.get('ctx');
    const user = c.get('user');
    const outcome = releaseBottle(ctx, user, c.req.valid('json'));
    const bottle = getSentBottle(ctx, user, outcome.bottleId);
    return c.json({ bottle, replayed: outcome.replayed }, outcome.replayed ? 200 : 201);
  });
  return r;
}
