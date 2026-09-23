import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, createDb, runMigrations } from './client.js';
import { LegacyMigrationError, assertSchemaComplete } from './compat.js';

// Audit QA-021 / QA-024 "partial migration failure": a migration that fails partway must leave
// the database refusing to boot, never half-upgraded and running.

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

// A copy of the real migrations folder, cut at `upTo` (inclusive), optionally with the last
// migration's final statement replaced by one that fails.
function folder(upTo: string, breakLast = false): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mib-partial-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'meta'));
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ tag: string }> };
  const cut = journal.entries.findIndex((e) => e.tag.startsWith(upTo));
  expect(cut).toBeGreaterThan(0);
  const entries = journal.entries.slice(0, cut + 1);
  fs.writeFileSync(
    path.join(dir, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries }),
  );
  for (const [i, e] of entries.entries()) {
    let sql = fs.readFileSync(path.join(MIGRATIONS_FOLDER, `${e.tag}.sql`), 'utf8');
    if (breakLast && i === entries.length - 1) {
      const parts = sql.split('--> statement-breakpoint');
      parts[parts.length - 1] = '\nALTER TABLE `no_such_table` ADD `x` integer;';
      sql = parts.join('--> statement-breakpoint');
    }
    fs.writeFileSync(path.join(dir, `${e.tag}.sql`), sql);
  }
  return dir;
}

const sqliteOf = (db: ReturnType<typeof createDb>['db']) =>
  (db as unknown as { $client: Database.Database }).$client;
const hasTable = (sqlite: Database.Database, name: string) =>
  sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
  undefined;
const columns = (sqlite: Database.Database, table: string) =>
  (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );

describe('a migration that fails partway', () => {
  it('rolls back as a whole, leaves the schema check refusing to boot, and recovers on a good run', () => {
    const { db } = createDb(':memory:');
    const sqlite = sqliteOf(db);
    runMigrations(db, folder('0013'));
    const appliedBefore = sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get();

    // 0014 creates moderation_audit, then fails on its last statement.
    expect(() => runMigrations(db, folder('0014', true))).toThrow();
    // Nothing of 0014 survived: no table, none of its earlier ALTERs, no bookkeeping row.
    expect(hasTable(sqlite, 'moderation_audit')).toBe(false);
    expect(columns(sqlite, 'moderation_cases')).not.toContain('hold_reason');
    expect(sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual(
      appliedBefore,
    );

    // The boot-time check names what is missing instead of letting the API start.
    let message = '';
    try {
      assertSchemaComplete(sqlite);
    } catch (err) {
      expect(err).toBeInstanceOf(LegacyMigrationError);
      message = (err as Error).message;
    }
    expect(message).toContain('table "moderation_audit"');
    expect(message).toContain('column "violations.severity"');

    // A good run afterwards applies 0014 in full, and the check passes.
    runMigrations(db);
    expect(hasTable(sqlite, 'moderation_audit')).toBe(true);
    expect(() => assertSchemaComplete(sqlite)).not.toThrow();
  });

  it('refuses to boot when a migration is recorded as applied but its objects are missing', () => {
    const { db } = createDb(':memory:');
    const sqlite = sqliteOf(db);
    runMigrations(db);
    // The bookkeeping says 0014 ran; the database disagrees.
    sqlite.exec('DROP TABLE moderation_audit');
    expect(() => runMigrations(db)).toThrow(LegacyMigrationError);
    expect(() => runMigrations(db)).toThrow(/table "moderation_audit"/);
  });
});
