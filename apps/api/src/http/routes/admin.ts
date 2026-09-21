import { Hono } from 'hono';
import { DecisionRequestSchema } from '@mib/shared';
import {
  decideAppeal,
  decideCase,
  getAppeal,
  getCase,
  listAppeals,
  listCases,
} from '../../services/admin.js';
import type { AppEnv } from '../app.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { jsonBody } from '../validate.js';

const STATUSES = new Set(['pending', 'accepted', 'rejected', 'all']);
type Status = 'pending' | 'accepted' | 'rejected' | 'all';
const statusOf = (raw: string | undefined): Status =>
  raw && STATUSES.has(raw) ? (raw as Status) : 'pending';

// Every route here is behind requireAuth *and* requireAdmin: the role on the users row is the
// only thing that opens this door.
export function adminRoutes() {
  const r = new Hono<AppEnv>();
  r.use('*', requireAuth, requireAdmin);
  r.get('/reports', (c) =>
    c.json({ cases: listCases(c.get('ctx'), statusOf(c.req.query('status'))) }),
  );
  r.get('/reports/:id', (c) => c.json({ case: getCase(c.get('ctx'), c.req.param('id')) }));
  r.post('/reports/:id/accept', jsonBody(DecisionRequestSchema), (c) => {
    const ctx = c.get('ctx');
    const changed = decideCase(
      ctx,
      c.get('user'),
      c.req.param('id'),
      'accepted',
      c.req.valid('json').reason,
    );
    return c.json({ case: getCase(ctx, c.req.param('id')), changed });
  });
  r.post('/reports/:id/reject', jsonBody(DecisionRequestSchema), (c) => {
    const ctx = c.get('ctx');
    const changed = decideCase(
      ctx,
      c.get('user'),
      c.req.param('id'),
      'rejected',
      c.req.valid('json').reason,
    );
    return c.json({ case: getCase(ctx, c.req.param('id')), changed });
  });
  r.get('/appeals', (c) =>
    c.json({ appeals: listAppeals(c.get('ctx'), statusOf(c.req.query('status'))) }),
  );
  r.get('/appeals/:id', (c) => c.json({ appeal: getAppeal(c.get('ctx'), c.req.param('id')) }));
  r.post('/appeals/:id/accept', jsonBody(DecisionRequestSchema), (c) => {
    const ctx = c.get('ctx');
    const changed = decideAppeal(
      ctx,
      c.get('user'),
      c.req.param('id'),
      'accepted',
      c.req.valid('json').reason,
    );
    return c.json({ appeal: getAppeal(ctx, c.req.param('id')), changed });
  });
  r.post('/appeals/:id/reject', jsonBody(DecisionRequestSchema), (c) => {
    const ctx = c.get('ctx');
    const changed = decideAppeal(
      ctx,
      c.get('user'),
      c.req.param('id'),
      'rejected',
      c.req.valid('json').reason,
    );
    return c.json({ appeal: getAppeal(ctx, c.req.param('id')), changed });
  });
  return r;
}
