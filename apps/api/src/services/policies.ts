import { and, desc, eq } from 'drizzle-orm';
import {
  POLICY_ACTION,
  POLICY_DOCUMENTS,
  POLICY_IDS,
  PUBLISHED_DOCUMENTS,
  currentPolicyVersions,
  policyDocument,
  policySetStatus,
  validatePolicySet,
  type AccountPoliciesDto,
  type PolicyAcceptanceRequest,
  type PolicyId,
  type PolicyStatus,
} from '@mib/shared';
import type { DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';
import { AppError, badRequest, conflict } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { AppContext } from './context.js';

// Terms, guidelines and privacy: what the server does with them. The documents themselves live
// in @mib/shared (one source for the API and the web). This module answers three questions:
//
//   1. Which versions are current, and is the published set complete?
//   2. What has this account accepted, and must it be asked again?
//   3. May this deployment collect acceptances at all?
//
// The last one is the release gate: a build whose documents are not all released cannot take
// acceptances in production, so nobody is ever asked to agree to unfinished legal text.

export interface PoliciesConfig {
  // The status of the documents as shipped, read from the documents themselves.
  status: PolicyStatus;
}

// Called at boot: a released set that still carries an open field is refused outright.
export function assertPolicySetServeable(): void {
  const problems = validatePolicySet(POLICY_DOCUMENTS);
  if (problems.length)
    throw new Error(`policy documents are not serveable:\n  ${problems.join('\n  ')}`);
}

export function policyStatus(ctx: AppContext): PolicyStatus {
  return ctx.config.policies.status;
}

// May this deployment take acceptances? Development: always (drafts included, so the flow can
// be built and tested). Production: only a released set.
export function assertAcceptancesAllowed(ctx: AppContext): void {
  if (ctx.config.devMode) return;
  if (policySetStatus(POLICY_DOCUMENTS) !== 'released' || policyStatus(ctx) !== 'released')
    throw new AppError(
      503,
      'policies_not_released',
      'registration is closed until the terms of use and privacy policy are published',
    );
}

// The versions the person says they saw must be the ones that are current: a form left open
// across a release cannot accept the old text.
export function assertVersionsCurrent(input: PolicyAcceptanceRequest): void {
  const current = currentPolicyVersions();
  const stale = POLICY_IDS.filter((id) => input.versions[id] !== current[id]);
  if (stale.length)
    throw conflict('policy_version_stale', 'the documents have changed; please read them again', {
      current,
    });
}

// Writes one row per document inside the caller's transaction. Idempotent by construction: the
// same person accepting the same version twice leaves two dated rows, both true.
export function recordAcceptances(
  tx: DbOrTx,
  userId: string,
  input: PolicyAcceptanceRequest,
  source: 'registration' | 'update',
  now: number,
): void {
  assertVersionsCurrent(input);
  for (const id of POLICY_IDS) {
    tx.insert(t.policyAcceptances)
      .values({
        id: newId('pol'),
        userId,
        document: id,
        version: input.versions[id],
        action: POLICY_ACTION[id],
        source,
        acceptedAt: now,
      })
      .run();
  }
}

function latestAcceptance(db: DbOrTx, userId: string, id: PolicyId) {
  return db
    .select()
    .from(t.policyAcceptances)
    .where(and(eq(t.policyAcceptances.userId, userId), eq(t.policyAcceptances.document, id)))
    .orderBy(desc(t.policyAcceptances.acceptedAt), desc(t.policyAcceptances.id))
    .get();
}

// The account's standing against the current documents. `required` is what gates the app: it
// is true only for a released set, and then for any document whose latest accepted version is
// not the current one — never accepted included.
export function accountPolicies(ctx: AppContext, userId: string): AccountPoliciesDto {
  const status = policyStatus(ctx);
  const current = currentPolicyVersions();
  const documents = POLICY_IDS.map((id) => {
    const latest = latestAcceptance(ctx.db, userId, id);
    return {
      id,
      title: policyDocument(id).title,
      currentVersion: current[id],
      action: POLICY_ACTION[id],
      acceptedVersion: latest?.version ?? null,
      acceptedAt: latest ? new Date(latest.acceptedAt).toISOString() : null,
    };
  });
  const required =
    status === 'released' && documents.some((d) => d.acceptedVersion !== d.currentVersion);
  return { status, required, documents };
}

// An existing account accepting the current versions from the "updated terms" screen.
export function acceptCurrentPolicies(
  ctx: AppContext,
  userId: string,
  input: PolicyAcceptanceRequest,
): AccountPoliciesDto {
  assertAcceptancesAllowed(ctx);
  const now = ctx.realClock.now();
  ctx.db.transaction((tx) => recordAcceptances(tx, userId, input, 'update', now));
  return accountPolicies(ctx, userId);
}

// Behind every ordinary route once the set is released: an account that has not accepted the
// current versions gets 403 with a code the client turns into the acceptance screen. Auth,
// the documents themselves, acceptance and sign-out stay open, so the person can always act.
export function assertPoliciesAccepted(ctx: AppContext, userId: string): void {
  const p = accountPolicies(ctx, userId);
  if (p.required)
    throw new AppError(
      403,
      'policies_required',
      'please accept the current terms of use and privacy policy to continue',
    );
}

// The signed-in user as the client sees them: the account plus its policy standing.
export function withPolicies<U extends { id: string }>(
  ctx: AppContext,
  user: U,
): U & { policies: AccountPoliciesDto } {
  return { ...user, policies: accountPolicies(ctx, user.id) };
}

// Any published document — the three that are accepted at registration and the Child Safety
// Standards, which GET /api/policies lists too (audit ARCH-023: it used to answer 400 for it).
export function policyDocumentOrThrow(id: string) {
  const doc = PUBLISHED_DOCUMENTS.find((d) => d.id === id);
  if (!doc) throw badRequest('unknown_document', 'no such document');
  return doc;
}
