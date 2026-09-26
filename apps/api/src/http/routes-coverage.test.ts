import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { APPEALS_PER_ADDRESS, REPORTS_PER_ADDRESS } from './routes/moderation.js';
import * as t from '../db/schema.js';
import { DevClock } from '../lib/clock.js';
import { decideCase } from '../services/admin.js';
import type { AuthUser } from '../services/context.js';
import { commitArrivalIfDue } from '../services/journey.js';
import { reportLetter } from '../services/moderation.js';
import { commitLoss } from '../services/outcomes.js';
import { releaseBottle } from '../services/release.js';
import {
  SAMPLE_TEXT,
  createTestWorld,
  loginAs,
  makeDeveloper,
  releaseInput,
  type TestWorld,
} from '../test/harness.js';

// Audit QA-014: one route-level test (status, response shape, authentication) for each route
// that had service coverage only, plus POST /api/dev/arrive, which had none at any level.
// Audit QA-024: the per-address report and appeal budgets of routes/moderation.ts.

const DAY = 24 * 60 * 60 * 1000;
const headers = (token?: string | null, extra: Record<string, string> = {}) => ({
  'content-type': 'application/json',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
  ...extra,
});
const get = (token?: string | null): RequestInit => ({ headers: headers(token) });
const post = (token?: string | null, body?: unknown, extra: Record<string, string> = {}) => ({
  method: 'POST',
  headers: headers(token, extra),
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;

// A letter from `from` that has arrived (not yet opened) on `to`'s shore.
function arrived(w: TestWorld, from: string, to: string, key: string): string {
  const id = releaseBottle(w.ctx, w.user(from), releaseInput(w.user(to).id, key)).bottleId;
  w.clock.advance(60 * DAY);
  expect(commitArrivalIfDue(w.ctx, id, w.clock.now())).toBe(true);
  return id;
}

async function world(overrides = {}) {
  const w = createTestWorld({ defaultShoreCapacity: 20, ...overrides });
  const app = createApp(w.ctx);
  return {
    w,
    app,
    ada: await loginAs(app, 'ada'),
    bo: await loginAs(app, 'bo'),
    cy: await loginAs(app, 'cy'),
  };
}

describe('route-level coverage (QA-014)', () => {
  it('POST /api/notifications/read-all marks only the caller’s notices read', async () => {
    const { w, app, ada, bo } = await world();
    arrived(w, 'ada', 'bo', 'rc-key-000000001');
    expect((await app.request('/api/notifications/read-all', post(null))).status).toBe(401);

    type Notices = { notifications: Array<{ readAt: string | null }> };
    const list = async (token: string) =>
      ((await (await app.request('/api/notifications', get(token))).json()) as Notices)
        .notifications;
    expect((await list(bo.token)).some((n) => n.readAt === null)).toBe(true);

    const res = await app.request('/api/notifications/read-all', post(bo.token));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    const after = await list(bo.token);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((n) => n.readAt === new Date(w.clock.now()).toISOString())).toBe(true);
    // Ada's own notice (sent_arrived) is untouched.
    expect((await list(ada.token)).some((n) => n.readAt === null)).toBe(true);
    // Idempotent.
    expect((await app.request('/api/notifications/read-all', post(bo.token))).status).toBe(204);
  });

  it('GET /api/shore/received and GET /api/shore/bottles/:id/letter serve only the recipient', async () => {
    const { w, app, ada, bo, cy } = await world();
    const id = arrived(w, 'ada', 'bo', 'rc-key-000000002');
    expect((await app.request('/api/shore/received')).status).toBe(401);
    expect((await app.request(`/api/shore/bottles/${id}/letter`)).status).toBe(401);

    // Arrived but sealed: not in the archive, and not readable here.
    const sealed = await app.request('/api/shore/received', get(bo.token));
    expect(sealed.status).toBe(200);
    expect(await sealed.json()).toEqual({ letters: [] });
    expect((await app.request(`/api/shore/bottles/${id}/letter`, get(bo.token))).status).toBe(404);

    expect((await app.request(`/api/shore/bottles/${id}/open`, post(bo.token))).status).toBe(200);
    const received = (await (await app.request('/api/shore/received', get(bo.token))).json()) as {
      letters: Array<Record<string, unknown>>;
    };
    expect(received.letters).toHaveLength(1);
    expect(received.letters[0]).toMatchObject({ id });
    // The archive entry carries no letter text.
    expect(JSON.stringify(received)).not.toContain('tide was gentle');

    const letter = await app.request(`/api/shore/bottles/${id}/letter`, get(bo.token));
    expect(letter.status).toBe(200);
    const body = (await letter.json()) as {
      bottle: { id: string };
      letter: { text: string; font: string; characters: number };
      aging: unknown;
    };
    expect(Object.keys(body).sort()).toEqual(['aging', 'bottle', 'letter']);
    expect(body.bottle.id).toBe(id);
    expect(body.letter.text).toBe(SAMPLE_TEXT);
    // Anyone else — the sender included — gets 404 here; an unknown id too.
    for (const token of [ada.token, cy.token]) {
      expect((await app.request(`/api/shore/bottles/${id}/letter`, get(token))).status).toBe(404);
      const other = (await (await app.request('/api/shore/received', get(token))).json()) as {
        letters: unknown[];
      };
      expect(other.letters).toEqual([]);
    }
    expect((await app.request('/api/shore/bottles/btl_nope/letter', get(bo.token))).status).toBe(
      404,
    );
  });

  it('POST /api/ocean/public/:id/open and /close: the finder’s one reading, served once', async () => {
    const { w, app, ada, cy } = await world();
    const id = releaseBottle(
      w.ctx,
      w.user('ada'),
      releaseInput(w.user('bo').id, 'rc-key-000000003'),
    ).bottleId;
    expect(commitLoss(w.ctx, id, 'adrift', w.clock.now()).committed).toBe(true);
    expect((await app.request(`/api/ocean/public/${id}/open`, post(null))).status).toBe(401);
    expect((await app.request(`/api/ocean/public/${id}/close`, post(null))).status).toBe(401);
    // There is no resumable reading any more.
    expect((await app.request('/api/ocean/reading', get(cy.token))).status).toBe(404);

    const open = await app.request(`/api/ocean/public/${id}/open`, post(cy.token));
    expect(open.status).toBe(200);
    expect(open.headers.get('cache-control')).toBe('no-store');
    const letter = (await open.json()) as { bottle: { id: string }; letter: { text: string } };
    expect(letter.bottle.id).toBe(id);
    expect(letter.letter.text).toBe(SAMPLE_TEXT);
    expect(Object.keys(letter)).not.toContain('readingExpiresAt');
    // A second open — a refresh — serves nothing.
    const again = await app.request(`/api/ocean/public/${id}/open`, post(cy.token));
    expect(again.status).toBe(409);
    expect(await again.text()).not.toContain(SAMPLE_TEXT);

    // Someone else "finishing" it changes nothing; the finder finishing it is idempotent.
    expect((await app.request(`/api/ocean/public/${id}/close`, post(ada.token))).status).toBe(204);
    const close = await app.request(`/api/ocean/public/${id}/close`, post(cy.token));
    expect(close.status).toBe(204);
    expect(await close.text()).toBe('');
    expect((await app.request(`/api/ocean/public/${id}/close`, post(cy.token))).status).toBe(204);
  });

  it('POST /api/bottles/sent/:id/acknowledge: sender only, lost bottles only, seen before acknowledged', async () => {
    const { w, app, ada, bo } = await world();
    const lost = releaseBottle(
      w.ctx,
      w.user('ada'),
      releaseInput(w.user('bo').id, 'rc-key-000000004'),
    ).bottleId;
    const atSea = releaseBottle(
      w.ctx,
      w.user('ada'),
      releaseInput(w.user('bo').id, 'rc-key-000000005'),
    ).bottleId;
    expect(commitLoss(w.ctx, lost, 'sunk', w.clock.now()).committed).toBe(true);
    const ack = (id: string, token: string | null) =>
      app.request(`/api/bottles/sent/${id}/acknowledge`, post(token));

    expect((await ack(lost, null)).status).toBe(401);
    expect((await ack(lost, bo.token)).status).toBe(404);
    const notLost = await ack(atSea, ada.token);
    expect(notLost.status).toBe(400);
    expect(await errorCode(notLost)).toBe('not_lost');

    // Acknowledging a marker that was never seen records nothing.
    const early = await ack(lost, ada.token);
    expect(early.status).toBe(200);
    expect(await early.json()).toEqual({ visibility: { seenAt: null, acknowledgedAt: null } });

    expect((await app.request(`/api/bottles/sent/${lost}/seen`, post(ada.token))).status).toBe(200);
    w.clock.advance(1000);
    const res = await ack(lost, ada.token);
    expect(res.status).toBe(200);
    const { visibility } = (await res.json()) as {
      visibility: { seenAt: string; acknowledgedAt: string };
    };
    expect(Object.keys(visibility).sort()).toEqual(['acknowledgedAt', 'seenAt']);
    expect(Date.parse(visibility.acknowledgedAt)).toBe(w.clock.now());
    // First acknowledgement wins.
    w.clock.advance(1000);
    const again = (await (await ack(lost, ada.token)).json()) as {
      visibility: { acknowledgedAt: string };
    };
    expect(again.visibility.acknowledgedAt).toBe(visibility.acknowledgedAt);
  });

  it('POST /api/moderation/violations/:id/acknowledge: the sanctioned account only, idempotent', async () => {
    const { w, app, ada, bo } = await world();
    w.db
      .update(t.users)
      .set({ role: 'admin' })
      .where(eq(t.users.id, w.user('cy').id))
      .run();
    const id = arrived(w, 'ada', 'bo', 'rc-key-000000006');
    expect((await app.request(`/api/shore/bottles/${id}/open`, post(bo.token))).status).toBe(200);
    const caseId = reportLetter(w.ctx, w.user('bo'), {
      bottleId: id,
      reason: 'harassment',
      hide: false,
    }).caseId;
    const admin: AuthUser = { ...w.user('cy'), role: 'admin' };
    decideCase(w.ctx, admin, caseId, 'accepted', 'upheld');
    const violation = w.db
      .select()
      .from(t.violations)
      .where(eq(t.violations.caseId, caseId))
      .get()!;
    const url = `/api/moderation/violations/${violation.id}/acknowledge`;

    expect((await app.request(url, post(null))).status).toBe(401);
    expect((await app.request(url, post(bo.token))).status).toBe(404);
    expect(
      (await app.request('/api/moderation/violations/vio_nope/acknowledge', post(ada.token)))
        .status,
    ).toBe(404);

    const res = await app.request(url, post(ada.token));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    const stored = w.db.select().from(t.violations).where(eq(t.violations.id, violation.id)).get()!;
    expect(stored.acknowledgedAt).toBe(w.realClock.now());
    // Again: still 204, the first timestamp kept.
    w.realClock.advance(5000);
    expect((await app.request(url, post(ada.token))).status).toBe(204);
    expect(
      w.db.select().from(t.violations).where(eq(t.violations.id, violation.id)).get()!
        .acknowledgedAt,
    ).toBe(stored.acknowledgedAt);
    const standing = (await (
      await app.request('/api/moderation/standing', get(ada.token))
    ).json()) as {
      violations: Array<{ id: string; acknowledgedAt: string | null }>;
    };
    expect(standing.violations.find((v) => v.id === violation.id)?.acknowledgedAt).toBe(
      new Date(stored.acknowledgedAt!).toISOString(),
    );
  });

  it('POST /api/dev/arrive lands one of the developer’s own bottles through the worker', async () => {
    const w = createTestWorld({ devMode: true, defaultShoreCapacity: 20 });
    // The real dev server drives a persisted DevClock; /arrive refuses any other clock.
    const ctx = { ...w.ctx, clock: new DevClock(w.db) };
    const app = createApp(ctx);
    makeDeveloper(w, 'ada');
    makeDeveloper(w, 'bo');
    const ada = await loginAs(app, 'ada');
    const bo = await loginAs(app, 'bo');
    const cy = await loginAs(app, 'cy');
    const rel = await app.request(
      '/api/bottles/release',
      post(ada.token, releaseInput(bo.id, 'rc-key-000000007')),
    );
    expect(rel.status).toBe(201);
    const { bottle } = (await rel.json()) as {
      bottle: { id: string; plannedArrivalAt: string };
    };
    const arrive = (token: string | null, body: unknown = { bottleId: bottle.id }) =>
      app.request('/api/dev/arrive', post(token, body));

    expect((await arrive(null)).status).toBe(401);
    expect((await arrive(cy.token)).status).toBe(403); // a member, no developer role
    expect((await arrive(bo.token)).status).toBe(404); // a developer, but not their bottle
    expect((await arrive(ada.token, {})).status).toBe(400);
    expect((await arrive(ada.token, { bottleId: 'btl_nope' })).status).toBe(404);

    const res = await arrive(ada.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      devMode: boolean;
      serverTime: string;
      clockOffsetMs: number;
      msPerChartUnit: number;
      tick: { delivered: number; risk: unknown; expired: number };
    };
    expect(body.devMode).toBe(true);
    expect(body.clockOffsetMs).toBeGreaterThan(0);
    expect(body.msPerChartUnit).toBe(w.ctx.config.msPerChartUnit);
    expect(body.tick.delivered).toBe(1);
    // The dev clock keeps running in real time after the jump, so only a lower bound holds.
    expect(Date.parse(body.serverTime)).toBeGreaterThanOrEqual(Date.parse(bottle.plannedArrivalAt));
    const row = w.db.select().from(t.bottles).where(eq(t.bottles.id, bottle.id)).get()!;
    expect(row.state).toBe('delivered');
    expect(row.deliveredAt).toBe(Date.parse(bottle.plannedArrivalAt));
    // Bo's shore now holds it, through the normal path.
    const shore = (await (await app.request('/api/shore', get(bo.token))).json()) as {
      bottles: Array<{ id: string }>;
    };
    expect(shore.bottles.map((b) => b.id)).toContain(bottle.id);

    const twice = await arrive(ada.token);
    expect(twice.status).toBe(400);
    expect(await errorCode(twice)).toBe('not_at_sea');

    // With the harness's manual clock the route refuses rather than jumping time.
    const manual = await world({ devMode: true });
    makeDeveloper(manual.w, 'ada');
    const id = releaseBottle(
      manual.w.ctx,
      manual.w.user('ada'),
      releaseInput(manual.w.user('bo').id, 'rc-key-000000008'),
    ).bottleId;
    const refused = await manual.app.request(
      '/api/dev/arrive',
      post(manual.ada.token, { bottleId: id }),
    );
    expect(refused.status).toBe(400);
    expect(await errorCode(refused)).toBe('dev_only');
  });
});

describe('per-address moderation budgets (QA-024)', () => {
  const xff = (address: string) => ({ 'x-forwarded-for': address });

  it(`allows ${REPORTS_PER_ADDRESS.limit} reports per address per window, across accounts`, async () => {
    const { app, ada, bo, cy } = await world();
    const report = (token: string, address: string) =>
      app.request(
        '/api/moderation/reports',
        post(token, { bottleId: 'btl_missing', reason: 'spam', hide: false }, xff(address)),
      );
    // Each attempt spends the address budget before the letter is even looked up, so unknown
    // letters (404) count — without touching any account's durable report budget.
    for (let i = 0; i < REPORTS_PER_ADDRESS.limit; i++)
      expect((await report(i % 2 ? ada.token : bo.token, '203.0.113.9')).status).toBe(404);
    const limited = await report(cy.token, '203.0.113.9');
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as {
      error: { code: string; details: { retryAfterSeconds: number } };
    };
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.error.details.retryAfterSeconds).toBeLessThanOrEqual(
      REPORTS_PER_ADDRESS.windowMs / 1000,
    );
    // Another address is unaffected; appeals keep their own budget on the spent address.
    expect((await report(cy.token, '203.0.113.10')).status).toBe(404);
    expect(
      (
        await app.request(
          '/api/moderation/appeals',
          post(cy.token, { violationId: 'vio_missing', text: 'please' }, xff('203.0.113.9')),
        )
      ).status,
    ).toBe(404);
  });

  it(`allows ${APPEALS_PER_ADDRESS.limit} appeals per address per window, and never blocks reading one’s standing`, async () => {
    const { app, ada, bo } = await world();
    const appeal = (token: string, address: string) =>
      app.request(
        '/api/moderation/appeals',
        post(token, { violationId: 'vio_missing', text: 'please' }, xff(address)),
      );
    for (let i = 0; i < APPEALS_PER_ADDRESS.limit; i++)
      expect((await appeal(i % 2 ? ada.token : bo.token, '198.51.100.7')).status).toBe(404);
    const limited = await appeal(ada.token, '198.51.100.7');
    expect(limited.status).toBe(429);
    expect(await errorCode(limited)).toBe('rate_limited');
    expect((await appeal(ada.token, '198.51.100.8')).status).toBe(404);
    // Only the left-most, client-written entry differs: the same proxy-appended address is
    // the same bucket (trustedProxyHops = 1).
    expect((await appeal(ada.token, '10.0.0.1, 198.51.100.7')).status).toBe(429);
    // Standing and waiving are outside the budget.
    const standing = await app.request('/api/moderation/standing', {
      headers: headers(ada.token, xff('198.51.100.7')),
    });
    expect(standing.status).toBe(200);
  });
});
