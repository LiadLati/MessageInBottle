import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, createDb, runMigrations } from './client.js';
import {
  LEGACY_POLICY_HASH,
  LEGACY_POLICY_WHEN,
  LegacyMigrationError,
  journalEntries,
  policyTableMismatches,
  reconcileRenumberedMigrations,
} from './compat.js';

// The exact SQL the policy-acceptance migration carried while it was numbered 0010, before the
// moderation branch was merged and renumbered it to 0012. Reproduced here so a legacy database
// can be built the way a real one was, rather than approximated.
const LEGACY_POLICY_SQL = `CREATE TABLE \`policy_acceptances\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`user_id\` text NOT NULL,
	\`document\` text NOT NULL,
	\`version\` text NOT NULL,
	\`action\` text NOT NULL,
	\`source\` text NOT NULL,
	\`accepted_at\` integer NOT NULL,
	FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX \`policy_acceptances_user_idx\` ON \`policy_acceptances\` (\`user_id\`,\`document\`,\`accepted_at\`);`;

const entries = journalEntries(MIGRATIONS_FOLDER);
const whenOf = (tag: string) => entries.find((e) => e.tag.startsWith(tag))!.when;
const tables = (sqlite: Database.Database) =>
  (
    sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
const applied = (sqlite: Database.Database) =>
  sqlite
    .prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at')
    .all() as Array<{ hash: string; created_at: number }>;

// Builds the folder a database was migrated from at a given point in history: the journal
// entries up to `upTo`, plus — when asked — the policy-acceptance migration under its old
// number and old timestamp, exactly as the real legacy databases recorded it.
function historicFolder(upTo: string, withLegacyPolicy: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mib-historic-'));
  fs.mkdirSync(path.join(dir, 'meta'));
  const kept = entries.slice(0, entries.findIndex((e) => e.tag.startsWith(upTo)) + 1);
  const journal: { version: string; dialect: string; entries: unknown[] } = {
    version: '7',
    dialect: 'sqlite',
    entries: kept.map((e, idx) => ({
      idx,
      version: '6',
      when: e.when,
      tag: e.tag,
      breakpoints: true,
    })),
  };
  for (const e of kept)
    fs.copyFileSync(path.join(MIGRATIONS_FOLDER, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  if (withLegacyPolicy) {
    fs.writeFileSync(path.join(dir, '0010_policy_acceptances.sql'), LEGACY_POLICY_SQL);
    journal.entries.push({
      idx: kept.length,
      version: '6',
      when: LEGACY_POLICY_WHEN,
      tag: '0010_policy_acceptances',
      breakpoints: true,
    });
  }
  fs.writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
  return dir;
}

function seedAcceptances(sqlite: Database.Database, userId = 'usr_legacy') {
  sqlite
    .prepare(
      'INSERT INTO users (id, username, display_name, status, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(userId, 'legacy_person', 'Legacy Person', 'active', 1_700_000_000_000);
  const rows = [
    ['pol_a', userId, 'terms', '1.0', 'accepted', 'registration', 1_700_000_000_001],
    ['pol_b', userId, 'guidelines', '1.0', 'accepted', 'registration', 1_700_000_000_002],
    ['pol_c', userId, 'privacy', '1.0', 'acknowledged', 'registration', 1_700_000_000_003],
  ];
  const insert = sqlite.prepare(
    'INSERT INTO policy_acceptances (id, user_id, document, version, action, source, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const r of rows) insert.run(...r);
  return rows;
}
const dumpAcceptances = (sqlite: Database.Database) =>
  sqlite.prepare('SELECT * FROM policy_acceptances ORDER BY id').all();

describe('the renumbered policy-acceptance migration', () => {
  it('is recognised by the timestamp and hash it was recorded under', () => {
    // The current 0012 carries the same table under a new timestamp and, now that it is
    // idempotent, a different hash. Both facts are what the compatibility step relies on.
    const current = entries.find((e) => e.tag === '0012_policy_acceptances')!;
    expect(current.when).not.toBe(LEGACY_POLICY_WHEN);
    expect(current.hash).not.toBe(LEGACY_POLICY_HASH);
    // The legacy timestamp really is newer than the moderation migrations, which is why they
    // were skipped rather than applied.
    expect(LEGACY_POLICY_WHEN).toBeGreaterThan(whenOf('0010_reporting'));
    expect(LEGACY_POLICY_WHEN).toBeGreaterThan(whenOf('0011_evidence'));
    expect(LEGACY_POLICY_WHEN).toBeLessThan(current.when);
  });

  it('migrates a completely fresh database from 0000 through 0013', () => {
    const { db, sqlite } = createDb(':memory:');
    runMigrations(db);
    expect(applied(sqlite)).toHaveLength(entries.length);
    expect(applied(sqlite).map((r) => r.created_at)).toEqual(entries.map((e) => e.when));
    for (const t of ['policy_acceptances', 'moderation_cases', 'violations', 'appeals'])
      expect(tables(sqlite), t).toContain(t);
    expect(dumpAcceptances(sqlite)).toEqual([]);
  });

  it('is a no-op on a database already upgraded through the current migrations', () => {
    const { db, sqlite } = createDb(':memory:');
    runMigrations(db);
    const before = applied(sqlite);
    seedAcceptances(sqlite);
    const rows = dumpAcceptances(sqlite);

    expect(reconcileRenumberedMigrations(sqlite).action).toBe('not-legacy');
    runMigrations(db);
    expect(applied(sqlite)).toEqual(before);
    expect(dumpAcceptances(sqlite)).toEqual(rows);
  });

  it('upgrades a legacy database, keeping its acceptance rows byte for byte', () => {
    // A database as it stood on the terms-and-privacy branch before the merge: migrations
    // 0000-0009 plus the policy-acceptance migration under its old number.
    const legacyFolder = historicFolder('0009_account_time_zone', true);
    const { db, sqlite } = createDb(':memory:');
    runMigrations(db, legacyFolder);
    const seeded = seedAcceptances(sqlite);
    const before = dumpAcceptances(sqlite);
    expect(before).toHaveLength(seeded.length);
    // It is exactly the broken state: the policy table exists, the moderation tables do not,
    // and the newest recorded migration is later than the moderation migrations.
    expect(tables(sqlite)).toContain('policy_acceptances');
    expect(tables(sqlite)).not.toContain('moderation_cases');
    expect(Math.max(...applied(sqlite).map((r) => r.created_at))).toBe(LEGACY_POLICY_WHEN);

    runMigrations(db);

    // Every acceptance row survives untouched…
    expect(dumpAcceptances(sqlite)).toEqual(before);
    // …the moderation migrations that would have been skipped are applied…
    for (const t of ['moderation_cases', 'letter_reports', 'violations', 'appeals'])
      expect(tables(sqlite), t).toContain(t);
    // …the later migrations too…
    const userColumns = (
      sqlite.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(userColumns).toContain('role');
    expect(userColumns).toContain('deleted_at');
    // …and the bookkeeping now reads exactly like a freshly migrated database.
    expect(applied(sqlite).map((r) => r.created_at)).toEqual(entries.map((e) => e.when));
    expect(applied(sqlite).some((r) => r.created_at === LEGACY_POLICY_WHEN)).toBe(false);
  });

  it('upgrades a legacy database that had also applied the moderation migrations', () => {
    // The other shape a real database could be in: the moderation branch ran first, then the
    // policy-acceptance migration under its old number.
    const folder = historicFolder('0011_evidence_retention', true);
    const { db, sqlite } = createDb(':memory:');
    runMigrations(db, folder);
    expect(tables(sqlite)).toContain('moderation_cases');
    const before = dumpAcceptances(seedAcceptancesAnd(sqlite));

    runMigrations(db);

    expect(dumpAcceptances(sqlite)).toEqual(before);
    expect(applied(sqlite).map((r) => r.created_at)).toEqual(entries.map((e) => e.when));
    // The moderation tables were not recreated: the rows put in them are still there.
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS n FROM moderation_cases').get() as { n: number }).n,
    ).toBe(0);
  });

  it('is safe to run twice', () => {
    const legacyFolder = historicFolder('0009_account_time_zone', true);
    const { db, sqlite } = createDb(':memory:');
    runMigrations(db, legacyFolder);
    seedAcceptances(sqlite);
    const before = dumpAcceptances(sqlite);

    runMigrations(db);
    const afterFirst = applied(sqlite);
    runMigrations(db);

    expect(applied(sqlite)).toEqual(afterFirst);
    expect(dumpAcceptances(sqlite)).toEqual(before);
    expect(reconcileRenumberedMigrations(sqlite).action).toBe('not-legacy');
  });

  it('refuses a table named policy_acceptances with the wrong schema, and changes nothing', () => {
    const legacyFolder = historicFolder('0009_account_time_zone', true);
    const { db, sqlite } = createDb(':memory:');
    runMigrations(db, legacyFolder);
    seedAcceptances(sqlite);
    // Someone's hand-rolled table: a column too few, a column too many, no index.
    sqlite.exec('DROP INDEX policy_acceptances_user_idx');
    sqlite.exec('ALTER TABLE policy_acceptances ADD COLUMN note text');
    const before = dumpAcceptances(sqlite);
    const bookkeeping = applied(sqlite);

    expect(policyTableMismatches(sqlite).length).toBeGreaterThan(0);
    expect(() => runMigrations(db)).toThrow(LegacyMigrationError);
    try {
      runMigrations(db);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/not the table the/i);
      expect(message).toMatch(/index "policy_acceptances_user_idx" is missing/);
      expect(message).toMatch(/unexpected column "note"/);
      expect(message).toMatch(/Nothing was changed/);
    }
    // Refusing means refusing: the data and the bookkeeping are exactly as they were.
    expect(dumpAcceptances(sqlite)).toEqual(before);
    expect(applied(sqlite)).toEqual(bookkeeping);
    expect(tables(sqlite)).not.toContain('moderation_cases');
  });

  it('refuses an unrecognised migration recorded at the legacy timestamp', () => {
    const { db, sqlite } = createDb(':memory:');
    runMigrations(db);
    sqlite
      .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run('a'.repeat(64), LEGACY_POLICY_WHEN);
    expect(() => reconcileRenumberedMigrations(sqlite)).toThrow(LegacyMigrationError);
    expect(() => reconcileRenumberedMigrations(sqlite)).toThrow(/do not carry its content hash/);
  });

  it('starts the API after the compatibility upgrade, with the acceptances intact', async () => {
    const legacyFolder = historicFolder('0009_account_time_zone', true);
    const { db, sqlite } = createDb(':memory:');
    runMigrations(db, legacyFolder);
    const seeded = seedAcceptances(sqlite);
    runMigrations(db);

    // Everything the API needs at boot, on the upgraded database.
    const { createApp } = await import('../http/app.js');
    const { seedChart } = await import('./seed.js');
    const { testConfig, T0, ManualClock } = await import('../test/harness.js');
    const { OutboxMailer } = await import('../lib/mail.js');
    const config = testConfig();
    seedChart(db, config.defaultShoreCapacity, T0);
    const clock = new ManualClock(T0);
    const app = createApp({
      db,
      clock,
      realClock: clock,
      config,
      mailer: new OutboxMailer(),
    });
    expect((await app.request('/api/health')).status).toBe(200);
    expect((await app.request('/support')).status).toBe(200);
    expect((await app.request('/legal/privacy')).status).toBe(200);
    // The rows that were there before the upgrade are still the rows the API reads.
    expect(dumpAcceptances(sqlite)).toHaveLength(seeded.length);
  });
});

// Seeds and returns the same handle, so a row dump can be taken inline.
function seedAcceptancesAnd(sqlite: Database.Database): Database.Database {
  seedAcceptances(sqlite);
  return sqlite;
}
