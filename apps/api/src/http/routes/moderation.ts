import { Hono } from 'hono';
import { clientAddress } from '../client-address.js';
import { AppealRequestSchema, ReportRequestSchema, WaiveAppealRequestSchema } from '@mib/shared';
import { tooManyRequests } from '../../lib/errors.js';
import { RateLimiter, type RateLimitRule } from '../../lib/rate-limit.js';
import {
  accountStanding,
  acknowledgeWarning,
  presentDecisionNotice,
  reportLetter,
  submitAppeal,
  waiveAppeal,
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

  const clientKey = clientAddress;
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
  // The decision notice was shown. Recorded server-side so the appeal is opened by the server,
  // not asserted by the client, and so a notice nobody ever saw is never treated as declined.
  r.post('/violations/:id/presented', (c) =>
    c.json(presentDecisionNotice(c.get('ctx'), c.get('user'), c.req.param('id'))),
  );
  // "Skip appeal", after the second confirmation. Permanent, idempotent and audit logged; it
  // must stay reachable while suspended or banned, like every other action on this router.
  r.post('/appeals/waive', jsonBody(WaiveAppealRequestSchema), (c) =>
    c.json(waiveAppeal(c.get('ctx'), c.get('user'), c.req.valid('json').violationId)),
  );
  r.post('/appeals', jsonBody(AppealRequestSchema), (c) => {
    enforce(`appeal:addr:${clientKey(c)}`, APPEALS_PER_ADDRESS);
    return c.json(submitAppeal(c.get('ctx'), c.get('user'), c.req.valid('json')), 201);
  });
  return r;
}
