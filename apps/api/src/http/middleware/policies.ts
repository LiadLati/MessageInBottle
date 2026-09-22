import { createMiddleware } from 'hono/factory';
import { assertPoliciesAccepted } from '../../services/policies.js';
import type { AppEnv } from '../app.js';

// Once the documents are released, an account that has not accepted the current versions may
// sign in, read the documents, accept them and sign out — and nothing else. Runs after
// requireAuth. While the set is a draft this never refuses anyone: nothing final exists yet to
// be asked about, and existing accounts are not nagged about unfinished text.
export const requirePolicies = createMiddleware<AppEnv>(async (c, next) => {
  assertPoliciesAccepted(c.get('ctx'), c.get('user').id);
  await next();
});
