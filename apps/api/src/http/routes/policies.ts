import { Hono } from 'hono';
import { POLICY_DOCUMENTS, PolicyAcceptanceRequestSchema } from '@mib/shared';
import {
  acceptCurrentPolicies,
  accountPolicies,
  policyDocumentOrThrow,
  policyStatus,
} from '../../services/policies.js';
import type { AppEnv } from '../app.js';
import { requireAuth } from '../middleware/auth.js';
import { jsonBody } from '../validate.js';

// The documents are public — a person reads them before deciding to register — and carry their
// status so the client can show a draft for what it is. Acceptance needs a signed-in account
// but never good standing or prior acceptance: it is the way out of the gate.
export function policyRoutes() {
  const r = new Hono<AppEnv>();
  r.get('/', (c) =>
    c.json({
      status: policyStatus(c.get('ctx')),
      documents: POLICY_DOCUMENTS.map((d) => ({
        id: d.id,
        title: d.title,
        titleHe: d.titleHe,
        version: d.version,
        effectiveAt: d.effectiveAt,
      })),
    }),
  );
  r.get('/:id', (c) => c.json(policyDocumentOrThrow(c.req.param('id'))));
  r.get('/me/standing', requireAuth, (c) =>
    c.json(accountPolicies(c.get('ctx'), c.get('user').id)),
  );
  r.post('/accept', requireAuth, jsonBody(PolicyAcceptanceRequestSchema), (c) =>
    c.json(acceptCurrentPolicies(c.get('ctx'), c.get('user').id, c.req.valid('json'))),
  );
  return r;
}
