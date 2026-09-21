import { eq } from 'drizzle-orm';
import { RISK_POLICY_VERSION, currentPolicyVersions } from '@mib/shared';
import type { AppConfig } from '../config.js';
import { createDb, runMigrations, type Db } from '../db/client.js';
import * as t from '../db/schema.js';
import { DEV_SEED_PASSWORD } from '../db/seed-data.js';
import { seedChart, seedUsers } from '../db/seed.js';
import type { Clock } from '../lib/clock.js';
import { OutboxMailer } from '../lib/mail.js';
import type { createApp } from '../http/app.js';
import type { AppContext, AuthUser } from '../services/context.js';

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
    journeyTickMs: 1000,
    sessionTtlMs: 60 * 60 * 1000,
    corsOrigin: '*',
    trustProxy: true,
    appUrl: 'http://app.test',
    mail: {
      provider: 'outbox',
      from: 'test <no-reply@test>',
      smtp: { host: '', port: 587, secure: false, user: '', pass: '' },
    },
    riskPolicyVersion: RISK_POLICY_VERSION,
    policies: { status: 'draft' },
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
