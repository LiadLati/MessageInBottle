import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { POLICY_IDS, currentPolicyVersions } from '@mib/shared';
import { createApp } from './app.js';
import * as t from '../db/schema.js';
import { acceptCurrent, createTestWorld, loginAs } from '../test/harness.js';

type App = ReturnType<typeof createApp>;
const post = (body: unknown, token?: string) => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});
const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const register = (app: App, username: string, policies: unknown) =>
  app.request(
    '/api/auth/register',
    post({
      username,
      email: `${username}@example.test`,
      password: 'a long enough password',
      policies,
    }),
  );
type Session = { token: string; user: { id: string; policies: Record<string, unknown> } };

describe('the documents', () => {
  it('are public, carry their status and versions, and render as structured content', async () => {
    const app = createApp(createTestWorld().ctx);
    const set = await app.request('/api/policies');
    expect(set.status).toBe(200);
    const body = (await set.json()) as {
      status: string;
      documents: Array<{ id: string; version: string; effectiveAt: string | null }>;
    };
    expect(body.status).toBe('draft');
    expect(body.documents.map((d) => d.id)).toEqual([...POLICY_IDS]);
    for (const d of body.documents) expect(d.effectiveAt).toBeNull();

    const terms = await app.request('/api/policies/terms');
    expect(terms.status).toBe(200);
    const doc = (await terms.json()) as { dir: string; lang: string; blocks: unknown[] };
    expect(doc.dir).toBe('rtl');
    expect(doc.lang).toBe('he');
    expect(doc.blocks.length).toBeGreaterThan(3);
    expect((await app.request('/api/policies/nope')).status).toBe(400);
  });
});

describe('registration', () => {
  it('refuses an account without every acceptance, and records all three with it', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const ok = acceptCurrent();

    // Missing block, missing flag, false flag, wrong type: all 400, no account created.
    expect((await register(app, 'no_block', undefined)).status).toBe(400);
    const noPrivacy: Record<string, unknown> = { ...ok };
    delete noPrivacy.acknowledgePrivacy;
    expect((await register(app, 'no_privacy', noPrivacy)).status).toBe(400);
    expect((await register(app, 'false_terms', { ...ok, acceptTerms: false })).status).toBe(400);
    expect((await register(app, 'str_guides', { ...ok, acceptGuidelines: 'yes' })).status).toBe(
      400,
    );
    expect(
      w.db.select().from(t.users).where(eq(t.users.username, 'no_privacy')).all(),
    ).toHaveLength(0);

    // A version the person was never shown: 409 naming the current versions.
    const stale = await register(app, 'stale_one', {
      ...ok,
      versions: { ...ok.versions, privacy: '0.0-draft' },
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
      'policy_version_stale',
    );

    const res = await register(app, 'fresh_one', ok);
    expect(res.status).toBe(201);
    const session = (await res.json()) as Session;
    const rows = w.db
      .select()
      .from(t.policyAcceptances)
      .where(eq(t.policyAcceptances.userId, session.user.id))
      .all();
    expect(rows.map((r) => [r.document, r.action, r.source, r.version]).sort()).toEqual(
      [
        ['guidelines', 'accepted', 'registration', ok.versions.guidelines],
        ['privacy', 'acknowledged', 'registration', ok.versions.privacy],
        ['terms', 'accepted', 'registration', ok.versions.terms],
      ].sort(),
    );
    for (const r of rows) expect(r.acceptedAt).toBe(w.realClock.now());

    // The session says what was accepted, and that nothing further is required.
    const me = (await (await app.request('/api/auth/me', bearer(session.token))).json()) as {
      policies: { required: boolean; status: string; documents: Array<Record<string, unknown>> };
    };
    expect(me.policies.status).toBe('draft');
    expect(me.policies.required).toBe(false);
    expect(me.policies.documents.map((d) => d.acceptedVersion)).toEqual([
      ok.versions.terms,
      ok.versions.guidelines,
      ok.versions.privacy,
    ]);
    expect(me.policies.documents.map((d) => d.action)).toEqual([
      'accepted',
      'accepted',
      'acknowledged',
    ]);
  });

  it('is closed in a production build while the documents are drafts', async () => {
    const w = createTestWorld({ devMode: false });
    const app = createApp(w.ctx);
    const res = await register(app, 'prod_user', acceptCurrent());
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'policies_not_released',
    );
    expect(w.db.select().from(t.users).where(eq(t.users.username, 'prod_user')).all()).toHaveLength(
      0,
    );
    // Reading the documents is still possible: that is how a person learns why.
    expect((await app.request('/api/policies/privacy')).status).toBe(200);
  });
});

describe('existing accounts', () => {
  it('are never treated as having accepted anything', async () => {
    const w = createTestWorld();
    const app = createApp(w.ctx);
    const ada = await loginAs(app, 'ada');
    expect(
      w.db.select().from(t.policyAcceptances).where(eq(t.policyAcceptances.userId, ada.id)).all(),
    ).toHaveLength(0);
    const me = (await (await app.request('/api/auth/me', bearer(ada.token))).json()) as {
      policies: { required: boolean; documents: Array<{ acceptedVersion: string | null }> };
    };
    for (const d of me.policies.documents) expect(d.acceptedVersion).toBeNull();
    // While the set is a draft nothing is required of them and the app works as before.
    expect(me.policies.required).toBe(false);
    expect((await app.request('/api/chart', bearer(ada.token))).status).toBe(200);
  });

  it('must accept a released set before using the app, and only through an explicit acceptance', async () => {
    const w = createTestWorld({ policies: { status: 'released' } });
    const app = createApp(w.ctx);
    const ada = await loginAs(app, 'ada');

    const me = (await (await app.request('/api/auth/me', bearer(ada.token))).json()) as {
      policies: { required: boolean };
    };
    expect(me.policies.required).toBe(true);
    // Every ordinary route is closed with the one code the client turns into the screen…
    for (const path of [
      '/api/chart',
      '/api/friends',
      '/api/shore',
      '/api/ocean/public',
      '/api/notifications',
    ]) {
      const res = await app.request(path, bearer(ada.token));
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code, path).toBe(
        'policies_required',
      );
    }
    // …while the way out stays open: the documents, the standing, acceptance and sign-out.
    expect((await app.request('/api/policies/terms')).status).toBe(200);
    expect((await app.request('/api/policies/me/standing', bearer(ada.token))).status).toBe(200);

    const bad = await app.request(
      '/api/policies/accept',
      post({ ...acceptCurrent(), acceptTerms: false }, ada.token),
    );
    expect(bad.status).toBe(400);
    expect((await app.request('/api/chart', bearer(ada.token))).status).toBe(403);

    w.realClock.advance(1000);
    const good = await app.request('/api/policies/accept', post(acceptCurrent(), ada.token));
    expect(good.status).toBe(200);
    const standing = (await good.json()) as {
      required: boolean;
      documents: Array<{ acceptedVersion: string; acceptedAt: string }>;
    };
    expect(standing.required).toBe(false);
    expect(standing.documents.map((d) => d.acceptedVersion)).toEqual(
      Object.values(currentPolicyVersions()),
    );
    expect(standing.documents[0]!.acceptedAt).toBe(new Date(w.realClock.now()).toISOString());
    expect((await app.request('/api/chart', bearer(ada.token))).status).toBe(200);
    const rows = w.db
      .select()
      .from(t.policyAcceptances)
      .where(eq(t.policyAcceptances.userId, ada.id))
      .all();
    expect(rows.map((r) => r.source)).toEqual(['update', 'update', 'update']);

    expect(
      (await app.request('/api/auth/logout', { method: 'POST', ...bearer(ada.token) })).status,
    ).toBe(204);
  });

  it('are asked again when a document changes, and the old acceptance is kept as history', async () => {
    const w = createTestWorld({ policies: { status: 'released' } });
    const app = createApp(w.ctx);
    const ada = await loginAs(app, 'ada');
    await app.request('/api/policies/accept', post(acceptCurrent(), ada.token));
    // Simulate an earlier acceptance of an older privacy policy by rewriting the row's version,
    // as an account that accepted 1.0 would look after 1.1 shipped.
    w.db
      .update(t.policyAcceptances)
      .set({ version: 'older' })
      .where(eq(t.policyAcceptances.document, 'privacy'))
      .run();
    const me = (await (await app.request('/api/auth/me', bearer(ada.token))).json()) as {
      policies: { required: boolean; documents: Array<{ id: string; acceptedVersion: string }> };
    };
    expect(me.policies.required).toBe(true);
    expect(me.policies.documents.find((d) => d.id === 'privacy')!.acceptedVersion).toBe('older');
    expect((await app.request('/api/chart', bearer(ada.token))).status).toBe(403);

    w.realClock.advance(5000);
    await app.request('/api/policies/accept', post(acceptCurrent(), ada.token));
    expect((await app.request('/api/chart', bearer(ada.token))).status).toBe(200);
    const privacyRows = w.db
      .select()
      .from(t.policyAcceptances)
      .where(eq(t.policyAcceptances.document, 'privacy'))
      .all();
    expect(privacyRows).toHaveLength(2);
  });
});
