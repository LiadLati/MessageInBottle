import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { z, type ZodType } from 'zod';
import {
  AccountDeletedResponseSchema,
  AccountPoliciesSchema,
  AccountStandingSchema,
  AdminAppealSchema,
  AdminCaseDetailSchema,
  AdminCaseSummarySchema,
  AuditEntrySchema,
  ChartResponseSchema,
  DevStatusSchema,
  FriendsResponseSchema,
  MeResponseSchema,
  NotificationSchema,
  OpenedLetterSchema,
  OutcomeVisibilitySchema,
  PublicOceanResponseSchema,
  ReceivedLettersResponseSchema,
  ReleasePreviewResponseSchema,
  ReleaseResponseSchema,
  ReportResponseSchema,
  SentBottleSchema,
  SentBottleSummarySchema,
  SessionResponseSchema,
  ShoreResponseSchema,
  ViolationNoticeSchema,
} from '@mib/shared';
import * as t from '../db/schema.js';
import { createApp } from './app.js';
import { commitArrivalIfDue } from '../services/journey.js';
import { commitLoss } from '../services/outcomes.js';
import {
  acceptCurrent,
  createTestWorld,
  evidenceDigest,
  loginAs,
  makeDeveloper,
} from '../test/harness.js';

// Every response the web app reads, parsed with the same shared schema the web client now
// enforces at runtime (audit QA-007 / ARCH-021). A response that drifts from its schema fails
// here instead of turning into an "invalid response" error in front of a user.
const DAY = 24 * 60 * 60 * 1000;

describe('API responses match the shared schemas', () => {
  it('holds for the whole surface the web app uses', async () => {
    const w = createTestWorld({ defaultShoreCapacity: 80 });
    const app = createApp(w.ctx);
    w.db
      .update(t.users)
      .set({ role: 'admin' })
      .where(eq(t.users.id, w.user('cy').id))
      .run();
    makeDeveloper(w, 'dee');
    const ada = await loginAs(app, 'ada');
    const bo = await loginAs(app, 'bo');
    const cy = await loginAs(app, 'cy');
    const dee = await loginAs(app, 'dee');
    const seen: string[] = [];

    async function call<T>(
      schema: ZodType<T>,
      method: string,
      path: string,
      token: string | null,
      body?: unknown,
    ): Promise<T> {
      const res = await app.request(`/api${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const json: unknown = await res.json();
      expect(res.status, `${method} ${path}: ${JSON.stringify(json)}`).toBeLessThan(300);
      const parsed = schema.safeParse(json);
      expect(parsed.success, `${method} ${path}: ${JSON.stringify(parsed.error?.issues)}`).toBe(
        true,
      );
      seen.push(`${method} ${path.replace(/[a-z]{3}_[a-z0-9]+/g, ':id')}`);
      return parsed.data!;
    }

    // Account and chart
    await call(SessionResponseSchema, 'POST', '/auth/login', null, {
      username: 'ada',
      password: 'dev-password-2026',
    });
    await call(MeResponseSchema, 'GET', '/auth/me', ada.token);
    await call(MeResponseSchema, 'PUT', '/auth/time-zone', ada.token, {
      timeZone: 'Europe/Berlin',
    });
    await call(AccountPoliciesSchema, 'GET', '/policies/me/standing', ada.token);
    await call(AccountPoliciesSchema, 'POST', '/policies/accept', ada.token, acceptCurrent());
    await call(ChartResponseSchema, 'GET', '/chart', ada.token);
    await call(FriendsResponseSchema, 'GET', '/friends', ada.token);

    // A journey: preview, release, the sender's passport and own letter while at sea
    await call(ReleasePreviewResponseSchema, 'POST', '/bottles/preview', ada.token, {
      recipientId: bo.id,
    });
    const released = await call(ReleaseResponseSchema, 'POST', '/bottles/release', ada.token, {
      recipientId: bo.id,
      text: 'Dear Bo, the tide was gentle.',
      font: 'handwriting',
      disclosureAcknowledged: true,
      idempotencyKey: 'contract-key-000001',
    });
    const id = released.bottle.id;
    await call(
      z.object({ bottles: z.array(SentBottleSummarySchema) }),
      'GET',
      '/bottles/sent',
      ada.token,
    );
    await call(z.object({ bottle: SentBottleSchema }), 'GET', `/bottles/sent/${id}`, ada.token);
    const atSea = await call(OpenedLetterSchema, 'GET', `/bottles/sent/${id}/letter`, ada.token);
    expect(atSea.bottle.deliveredAt).toBeNull();
    expect(atSea.bottle.journeyDurationMs).toBeGreaterThanOrEqual(0);

    // Arrival, the recipient's shore, opening, the archive, notifications
    w.clock.advance(60 * DAY);
    commitArrivalIfDue(w.ctx, id, w.clock.now());
    await call(ShoreResponseSchema, 'GET', '/shore', bo.token);
    await call(OpenedLetterSchema, 'POST', `/shore/bottles/${id}/open`, bo.token);
    await call(OpenedLetterSchema, 'GET', `/shore/bottles/${id}/letter`, bo.token);
    await call(ReceivedLettersResponseSchema, 'GET', '/shore/received', bo.token);
    await call(
      z.object({ notifications: z.array(NotificationSchema) }),
      'GET',
      '/notifications',
      bo.token,
    );

    // A lost bottle: the sender's view, its visibility, the public ocean and a finder
    const lost = (
      await call(ReleaseResponseSchema, 'POST', '/bottles/release', ada.token, {
        recipientId: bo.id,
        text: 'A second letter.',
        font: 'handwriting',
        disclosureAcknowledged: true,
        idempotencyKey: 'contract-key-000002',
      })
    ).bottle.id;
    w.clock.advance(60 * 60 * 1000);
    expect(commitLoss(w.ctx, lost, 'adrift', w.clock.now()).committed).toBe(true);
    const own = await call(OpenedLetterSchema, 'GET', `/bottles/sent/${lost}/letter`, ada.token);
    expect(own.bottle.journeyDurationMs).toBeGreaterThanOrEqual(0);
    expect(own.bottle.deliveredAt).toBeNull();
    const vis = z.object({ visibility: OutcomeVisibilitySchema });
    await call(vis, 'POST', `/bottles/sent/${lost}/seen`, ada.token);
    await call(vis, 'POST', `/bottles/sent/${lost}/acknowledge`, ada.token);
    await call(PublicOceanResponseSchema, 'GET', '/ocean/public', cy.token);
    await call(OpenedLetterSchema, 'POST', `/ocean/public/${lost}/open`, cy.token);
    await call(
      z.object({ reading: OpenedLetterSchema.nullable() }),
      'GET',
      '/ocean/reading',
      cy.token,
    );

    // Moderation: report, admin console, decision, the sender's notice, appeal, admin appeals
    const report = await call(ReportResponseSchema, 'POST', '/moderation/reports', bo.token, {
      bottleId: id,
      reason: 'harassment',
      hide: false,
    });
    await call(
      z.object({ cases: z.array(AdminCaseSummarySchema) }),
      'GET',
      '/admin/reports?status=all',
      cy.token,
    );
    await call(
      z.object({ case: AdminCaseDetailSchema }),
      'GET',
      `/admin/reports/${report.caseId}`,
      cy.token,
    );
    await call(
      z.object({ case: AdminCaseDetailSchema, changed: z.boolean() }),
      'POST',
      `/admin/reports/${report.caseId}/accept`,
      cy.token,
      { reason: 'upheld', evidenceDigest: evidenceDigest(w, report.caseId) },
    );
    const standing = await call(AccountStandingSchema, 'GET', '/moderation/standing', ada.token);
    const violationId = standing.pendingDecision!.id;
    await call(
      ViolationNoticeSchema,
      'POST',
      `/moderation/violations/${violationId}/presented`,
      ada.token,
    );
    await call(ViolationNoticeSchema, 'POST', '/moderation/appeals', ada.token, {
      violationId,
      text: 'Please look again.',
    });
    const appeals = await call(
      z.object({ appeals: z.array(AdminAppealSchema) }),
      'GET',
      '/admin/appeals?status=all',
      cy.token,
    );
    await call(
      z.object({ appeal: AdminAppealSchema, changed: z.boolean() }),
      'POST',
      `/admin/appeals/${appeals.appeals[0]!.id}/reject`,
      cy.token,
      { reason: 'the decision stands' },
    );
    await call(
      z.object({ entries: z.array(AuditEntrySchema) }),
      'GET',
      `/admin/audit?subject=${ada.id}`,
      cy.token,
    );

    // Development controls, for a developer, in development mode
    await call(DevStatusSchema, 'GET', '/dev/status', dee.token);

    // Deleting an account
    await call(AccountDeletedResponseSchema, 'POST', '/account/delete', bo.token, {
      password: 'dev-password-2026',
      confirm: true,
    });

    expect(seen.length).toBeGreaterThanOrEqual(35);
  });
});
