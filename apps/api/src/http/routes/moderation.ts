import { Hono } from 'hono';
import { AppealRequestSchema, ReportRequestSchema } from '@mib/shared';
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

// The reader's and the sender's side of moderation. Reporting needs an account in good
// standing; reading one's standing, acknowledging a warning and appealing must work while
// suspended or banned, so those are not behind the standing check.
export function moderationRoutes() {
  const r = new Hono<AppEnv>();
  r.use('*', requireAuth);
  r.post('/reports', requireGoodStanding, jsonBody(ReportRequestSchema), (c) =>
    c.json(reportLetter(c.get('ctx'), c.get('user'), c.req.valid('json')), 201),
  );
  r.get('/standing', (c) => c.json(accountStanding(c.get('ctx'), c.get('user').id)));
  r.post('/violations/:id/acknowledge', (c) => {
    acknowledgeWarning(c.get('ctx'), c.get('user'), c.req.param('id'));
    return c.body(null, 204);
  });
  r.post('/appeals', jsonBody(AppealRequestSchema), (c) =>
    c.json(submitAppeal(c.get('ctx'), c.get('user'), c.req.valid('json')), 201),
  );
  return r;
}
