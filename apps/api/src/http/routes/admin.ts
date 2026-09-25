import { Hono } from 'hono';
import {
  CaseDecisionRequestSchema,
  CriticalDecisionRequestSchema,
  DecisionRequestSchema,
  HoldRequestSchema,
} from '@mib/shared';
import {
  decideAppeal,
  decideCase,
  decideCaseCritical,
  getAppeal,
  getCase,
  listAppeals,
  listCases,
  placeHold,
  releaseHold,
} from '../../services/admin.js';
import { readAudit } from '../../services/audit.js';
import { badRequest } from '../../lib/errors.js';
import type { AppEnv } from '../app.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin, requireGoodStanding } from '../middleware/admin.js';
import { jsonBody } from '../validate.js';

const STATUSES = new Set(['pending', 'accepted', 'rejected', 'all']);
type Status = 'pending' | 'accepted' | 'rejected' | 'all';
const statusOf = (raw: string | undefined): Status =>
  raw && STATUSES.has(raw) ? (raw as Status) : 'pending';

// Every accept and reject, of a report or of an appeal, records the administrator's reason
// (product decision 1): decisions are final outside the appeal, so the record must say why.
function requireReason(reason: string | null | undefined, what: string): string {
  const trimmed = reason?.trim();
  if (!trimmed) throw badRequest('reason_required', `${what} requires a reason for the record.`);
  return trimmed;
}

// Every route here is behind requireAuth, requireAdmin and requireGoodStanding: the role on the
// users row opens this door, and a suspended or banned account keeps no moderation authority
// whatever its role (audit SEC-009) — banning a compromised or abusive administrator contains it.
export function adminRoutes() {
  const r = new Hono<AppEnv>();
  r.use('*', requireAuth, requireAdmin, requireGoodStanding);
  r.get('/reports', (c) =>
    c.json({ cases: listCases(c.get('ctx'), statusOf(c.req.query('status'))) }),
  );
  r.get('/reports/:id', (c) =>
    c.json({ case: getCase(c.get('ctx'), c.req.param('id'), c.get('user')) }),
  );
  r.post('/reports/:id/accept', jsonBody(CaseDecisionRequestSchema), (c) => {
    const ctx = c.get('ctx');
    const body = c.req.valid('json');
    const reason = requireReason(body.reason, 'Upholding a report');
    const changed = decideCase(
      ctx,
      c.get('user'),
      c.req.param('id'),
      'accepted',
      reason,
      body.evidenceDigest,
    );
    return c.json({ case: getCase(ctx, c.req.param('id'), c.get('user')), changed });
  });
  r.post('/reports/:id/reject', jsonBody(CaseDecisionRequestSchema), (c) => {
    const ctx = c.get('ctx');
    const body = c.req.valid('json');
    const reason = requireReason(body.reason, 'Rejecting a report');
    const changed = decideCase(
      ctx,
      c.get('user'),
      c.req.param('id'),
      'rejected',
      reason,
      body.evidenceDigest,
    );
    return c.json({ case: getCase(ctx, c.req.param('id'), c.get('user')), changed });
  });
  // A confirmed critical child-safety violation: an immediate permanent ban, with a mandatory
  // administrator reason. Only reachable with the admin role, and never by the review model.
  r.post('/reports/:id/critical', jsonBody(CriticalDecisionRequestSchema), (c) =>
    c.json({
      case: decideCaseCritical(
        c.get('ctx'),
        c.get('user'),
        c.req.param('id'),
        c.req.valid('json').reason,
        c.req.valid('json').evidenceDigest,
      ),
    }),
  );
  // Documented legal or immediate child-safety holds on the evidence.
  r.post('/reports/:id/hold', jsonBody(HoldRequestSchema), (c) => {
    const { reason, note } = c.req.valid('json');
    return c.json({
      case: placeHold(c.get('ctx'), c.get('user'), c.req.param('id'), reason, note),
    });
  });
  r.post('/reports/:id/hold/release', (c) =>
    c.json({ case: releaseHold(c.get('ctx'), c.get('user'), c.req.param('id')) }),
  );
  // The audit trail, by the person it concerns or by case. At least one filter is required: the
  // trail is read to answer a question, not browsed.
  r.get('/audit', (c) => {
    const subjectUserId = c.req.query('subject') || undefined;
    const caseId = c.req.query('case') || undefined;
    if (!subjectUserId && !caseId)
      throw badRequest('filter_required', 'give ?subject=<user id> or ?case=<case id>');
    return c.json({ entries: readAudit(c.get('ctx').db, { subjectUserId, caseId }) });
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
      requireReason(c.req.valid('json').reason, 'Accepting an appeal'),
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
      requireReason(c.req.valid('json').reason, 'Rejecting an appeal'),
    );
    return c.json({ appeal: getAppeal(ctx, c.req.param('id')), changed });
  });
  return r;
}
