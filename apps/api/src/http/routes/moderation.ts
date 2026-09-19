import { Hono } from 'hono';
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { AppealRequestSchema, ReportRequestSchema } from '@mib/shared';
import { tooManyRequests } from '../../lib/errors.js';
import { RateLimiter, type RateLimitRule } from '../../lib/rate-limit.js';
import {
  accountStanding,
  acknowledgeWarning,
  reportLetter,
  submitAppeal,
} from '../../services/moderation.js';
import type { AppEnv } from '../app.js';
import { requireAuth } from '../middleware/auth.js';
import { requireGoodStanding } from '../middleware/admin.js';
import { jsonBody } from '../validate.js';

// Per-address budgets on top of the per-account ones in the moderation service. The account
// budget is the real limit (it is durable and survives new sessions); this one bounds a single
// machine driving many accounts, so it is a multiple of the per-account budget.
export const REPORTS_PER_ADDRESS: RateLimitRule = { limit: 40, windowMs: 60 * 60 * 1000 };
export const APPEALS_PER_ADDRESS: RateLimitRule = { limit: 20, windowMs: 60 * 60 * 1000 };

// The reader's and the sender's side of moderation. Reporting needs an account in good
// standing; reading one's standing, acknowledging a warning and appealing must work while
// suspended or banned, so those are not behind the standing check — nor behind a budget that
// could lock a banned person out of their only remaining action.
export function moderationRoutes(limiter = new RateLimiter()) {
  const r = new Hono<AppEnv>();
  r.use('*', requireAuth);

  const clientKey = (c: Context<AppEnv>): string => {
    if (c.get('ctx').config.trustProxy) {
      const first = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
      if (first) return first;
    }
    try {
      return getConnInfo(c).remote.address ?? 'local';
    } catch {
      return 'local';
    }
  };
  const enforce = (key: string, rule: RateLimitRule) => {
    const d = limiter.hit(key, rule);
    if (!d.allowed) throw tooManyRequests(d.retryAfterMs);
  };

  r.post('/reports', requireGoodStanding, jsonBody(ReportRequestSchema), (c) => {
    enforce(`report:addr:${clientKey(c)}`, REPORTS_PER_ADDRESS);
    return c.json(reportLetter(c.get('ctx'), c.get('user'), c.req.valid('json')), 201);
  });
  r.get('/standing', (c) => c.json(accountStanding(c.get('ctx'), c.get('user').id)));
  r.post('/violations/:id/acknowledge', (c) => {
    acknowledgeWarning(c.get('ctx'), c.get('user'), c.req.param('id'));
    return c.body(null, 204);
  });
  r.post('/appeals', jsonBody(AppealRequestSchema), (c) => {
    enforce(`appeal:addr:${clientKey(c)}`, APPEALS_PER_ADDRESS);
    return c.json(submitAppeal(c.get('ctx'), c.get('user'), c.req.valid('json')), 201);
  });
  return r;
}
