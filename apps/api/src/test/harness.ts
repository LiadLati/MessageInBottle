import { eq } from 'drizzle-orm';
import {
  POLICY_DOCUMENTS,
  SUPPORT_EMAIL,
  RISK_POLICY_VERSION,
  currentPolicyVersions,
  policySetStatus,
} from '@mib/shared';
import type { AppConfig } from '../config.js';
import { createDb, runMigrations, type Db } from '../db/client.js';
import * as t from '../db/schema.js';
import { DEV_SEED_PASSWORD } from '../db/seed-data.js';
import { newId, newSecretToken, sha256 } from '../lib/ids.js';
import { hashPassword, setPasswordHashCost } from '../lib/password.js';
import { seedChart, seedUsers } from '../db/seed.js';
import type { Clock } from '../lib/clock.js';
import { OutboxMailer } from '../lib/mail.js';
import type { createApp } from '../http/app.js';
import type { AppContext, AuthUser } from '../services/context.js';
import { RETENTION_DEFAULT } from '../services/retention.js';

// Tests hash and verify thousands of passwords; they run at Node's old default cost (2^14)
// rather than the production 2^16. Nothing a test asserts depends on the cost itself, except
// the re-hash test, which sets its own.
setPasswordHashCost(2 ** 14);

export class ManualClock implements Clock {
  constructor(private current: number) {}
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  set(ms: number): void {
    this.current = ms;
  }
}

export const T0 = Date.parse('2026-09-06T12:00:00.000Z');

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    databasePath: ':memory:',
    devMode: true,
    logRequests: false,
    msPerChartUnit: 60 * 60 * 1000,
    minJourneyMs: 6 * 60 * 60 * 1000,
    defaultShoreCapacity: 5,
    // Small by default so tests reach "full" quickly; a test that sets defaultShoreCapacity to
    // make room gets the same room per recipient.
    shoreCapacity: overrides.defaultShoreCapacity ?? 5,
    journeyTickMs: 1000,
    sessionTtlMs: 60 * 60 * 1000,
    corsOrigin: '*',
    trustProxy: true,
    trustedProxyHops: 1,
    appUrl: 'http://app.test',
    supportEmail: SUPPORT_EMAIL,
    mail: {
      provider: 'outbox',
      from: 'test <no-reply@test>',
      smtp: { host: '', port: 587, secure: false, user: '', pass: '' },
    },
    riskPolicyVersion: RISK_POLICY_VERSION,
    // The same status production runs with: the shipped documents decide it.
    policies: { status: policySetStatus(POLICY_DOCUMENTS) },
    ai: {
      enabled: true,
      endpoint: 'http://ai.test',
      model: 'test-model',
      timeoutMs: 1000,
      tickMs: 1000,
    },
    retention: RETENTION_DEFAULT,
    retentionTickMs: 60 * 60 * 1000,
    ...overrides,
  };
}

export interface TestWorld {
  ctx: AppContext;
  db: Db;
  clock: ManualClock;
  realClock: ManualClock;
  outbox: OutboxMailer;
  user(username: string): AuthUser;
}

export function createTestWorld(overrides: Partial<AppConfig> = {}): TestWorld {
  const config = testConfig(overrides);
  const { db } = createDb(':memory:');
  runMigrations(db);
  seedChart(db, config.defaultShoreCapacity, T0);
  seedUsers(db, T0);
  const clock = new ManualClock(T0);
  const outbox = new OutboxMailer(() => clock.now());
  // Tests get a separate real clock so advancing `clock` (journeys, weather) never touches
  // session lifetimes — exactly the production split.
  const realClock = new ManualClock(T0);
  const ctx: AppContext = { db, clock, realClock, config, mailer: outbox };
  return {
    ctx,
    db,
    clock,
    realClock,
    outbox,
    user(username) {
      const row = db.select().from(t.users).where(eq(t.users.username, username)).get();
      if (!row) throw new Error(`no seeded user ${username}`);
      return {
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        shoreId: row.shoreId,
        email: row.email,
        timeZone: row.timeZone,
        role: row.role,
      };
    },
  };
}

// Signs a seeded development account in through the real HTTP surface.
export async function loginAs(
  app: ReturnType<typeof createApp>,
  username: string,
  password = DEV_SEED_PASSWORD,
): Promise<{ token: string; id: string }> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status}`);
  const body = (await res.json()) as { token: string; user: { id: string } };
  return { token: body.token, id: body.user.id };
}

// Grants a seeded account the developer role, which is what the DEV simulation controls
// require. A test that drives /api/dev/* has to do this, exactly as a person would have to be
// granted the role by CLI: the controls are not open to ordinary members or to administrators.
export function makeDeveloper(w: TestWorld, username: string): void {
  w.db
    .update(t.users)
    .set({ role: 'developer', roleGrantedAt: w.clock.now(), roleGrantedBy: 'test' })
    .where(eq(t.users.id, w.user(username).id))
    .run();
}

export const SAMPLE_TEXT = 'Dear friend,\nthe tide was gentle this morning. — A';

export function releaseInput(recipientId: string, key = 'key-0000000001') {
  return {
    recipientId,
    text: SAMPLE_TEXT,
    font: 'handwriting' as const,
    disclosureAcknowledged: true as const,
    idempotencyKey: key,
  };
}

// The registration payload's acceptance block for the current documents.
export function acceptCurrent() {
  return {
    acceptTerms: true as const,
    acceptGuidelines: true as const,
    acknowledgePrivacy: true as const,
    versions: currentPolicyVersions(),
  };
}

// An account that existed before the documents did: a users row with no acceptance rows at
// all, which is exactly what every account looks like after the migration. Returns a usable
// session so the policy gate can be exercised the way a real person would meet it.
export function legacyAccount(
  w: TestWorld,
  username = 'legacy_one',
): { id: string; token: string } {
  const id = newId('usr');
  w.db
    .insert(t.users)
    .values({
      id,
      username,
      displayName: username,
      shoreId: 'shore_lantern_cove',
      createdAt: w.clock.now(),
      passwordHash: hashPassword(DEV_SEED_PASSWORD),
      passwordUpdatedAt: w.clock.now(),
      email: `${username}@example.test`,
    })
    .run();
  const token = newSecretToken();
  w.db
    .insert(t.sessions)
    .values({
      tokenHash: sha256(token),
      userId: id,
      createdAt: w.realClock.now(),
      expiresAt: w.realClock.now() + w.ctx.config.sessionTtlMs,
    })
    .run();
  return { id, token };
}

// The evidence digest an administrator's screen would echo back when deciding a case (the
// stale-decision guard in services/admin.ts).
export function evidenceDigest(w: TestWorld, caseId: string): string {
  const c = w.db.select().from(t.moderationCases).where(eq(t.moderationCases.id, caseId)).get();
  if (!c) throw new Error(`no case ${caseId}`);
  return sha256(c.evidenceText);
}
