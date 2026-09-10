import { eq } from 'drizzle-orm';
import type { AppConfig } from '../config.js';
import { createDb, runMigrations, type Db } from '../db/client.js';
import * as t from '../db/schema.js';
import { seedChart, seedUsers } from '../db/seed.js';
import type { Clock } from '../lib/clock.js';
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
    ...overrides,
  };
}

export interface TestWorld {
  ctx: AppContext;
  db: Db;
  clock: ManualClock;
  user(username: string): AuthUser;
}

export function createTestWorld(overrides: Partial<AppConfig> = {}): TestWorld {
  const config = testConfig(overrides);
  const { db } = createDb(':memory:');
  runMigrations(db);
  seedChart(db, config.defaultShoreCapacity, T0);
  seedUsers(db, T0);
  const clock = new ManualClock(T0);
  const ctx: AppContext = { db, clock, config };
  return {
    ctx,
    db,
    clock,
    user(username) {
      const row = db.select().from(t.users).where(eq(t.users.username, username)).get();
      if (!row) throw new Error(`no seeded user ${username}`);
      return {
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        shoreId: row.shoreId,
      };
    },
  };
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
