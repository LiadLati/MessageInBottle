import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

// Compatibility for a development database that applied the policy-acceptance migration while
// it was briefly numbered 0010, before the moderation branch was merged and it was renumbered
// to 0012.
//
// Why it breaks. Drizzle records every applied migration in `__drizzle_migrations` as a content
// hash and the journal timestamp (`when`) it carried. On every run it reads only the single
// newest row and applies every journal entry whose `when` is greater than that. The old
// policy-acceptance entry carried `when` 1789859116404, which is *later* than the moderation
// branch's own entries, so on such a database:
//
//   • 0012 is re-applied — `CREATE TABLE policy_acceptances` fails, the whole migration
//     transaction rolls back, and `db:migrate` and the API both refuse to start; and
//   • 0010_reporting_and_moderation (1789845840434) and 0011_evidence_retention
//     (1789848786378) are *silently skipped*, because their timestamps are older than the
//     newest recorded row. Even a database that got past the crash would be missing every
//     moderation table.
//
// The fix has two halves, and both are needed:
//
//   1. 0012 is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`), so
//      replaying it over an existing, correct table is a no-op rather than an error.
//   2. This module removes the one stale bookkeeping row — and nothing else. With it gone the
//      newest recorded migration is whatever genuinely ran last, so Drizzle replays the
//      moderation migrations it would otherwise skip, then harmlessly re-runs 0012.
//
// Nothing is dropped, cleared or recreated: `policy_acceptances` and every row in it are left
// exactly as they are, and the row count is checked before and after to prove it. The stale
// row is only removed once the existing table has been shown to match the schema that
// migration created, column for column, key for key and index for index. If it does not match,
// nothing is touched and the mismatch is reported.

// The journal timestamp and content hash the renumbered migration was recorded under. Both are
// historical constants: they identify that one entry and can never legitimately mean anything
// else. (The hash is SHA-256 of the migration file exactly as it was then; the current 0012
// file differs, because it is now idempotent.)
export const LEGACY_POLICY_WHEN = 1789859116404;
export const LEGACY_POLICY_HASH =
  '66bde2c3bdf52af960c712c9988c15fd601f26406beb850fd5272bc80330286a';

const MIGRATIONS_TABLE = '__drizzle_migrations';
const POLICY_TABLE = 'policy_acceptances';
const POLICY_INDEX = 'policy_acceptances_user_idx';

// The shape `0010_policy_acceptances.sql` created, which `0012_policy_acceptances.sql` still
// creates. A legacy table is accepted only if it matches this exactly.
interface ExpectedColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
}
const EXPECTED_COLUMNS: ExpectedColumn[] = [
  { name: 'id', type: 'TEXT', notNull: true, primaryKey: true },
  { name: 'user_id', type: 'TEXT', notNull: true, primaryKey: false },
  { name: 'document', type: 'TEXT', notNull: true, primaryKey: false },
  { name: 'version', type: 'TEXT', notNull: true, primaryKey: false },
  { name: 'action', type: 'TEXT', notNull: true, primaryKey: false },
  { name: 'source', type: 'TEXT', notNull: true, primaryKey: false },
  { name: 'accepted_at', type: 'INTEGER', notNull: true, primaryKey: false },
];
const EXPECTED_FOREIGN_KEY = { table: 'users', from: 'user_id', to: 'id' };
const EXPECTED_INDEX_COLUMNS = ['user_id', 'document', 'accepted_at'];

function tableExists(sqlite: Database.Database, name: string): boolean {
  return (
    sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
    undefined
  );
}

// Every way the existing table could differ from the one the migration created. An empty list
// means it is the same table, and replaying the migration over it is genuinely a no-op.
export function policyTableMismatches(sqlite: Database.Database): string[] {
  const problems: string[] = [];
  const columns = sqlite.prepare(`PRAGMA table_info(${POLICY_TABLE})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>;
  const byName = new Map(columns.map((c) => [c.name, c]));
  for (const want of EXPECTED_COLUMNS) {
    const got = byName.get(want.name);
    if (!got) {
      problems.push(`column "${want.name}" is missing`);
      continue;
    }
    if (got.type.toUpperCase() !== want.type)
      problems.push(`column "${want.name}" is ${got.type || 'untyped'}, expected ${want.type}`);
    if ((got.notnull === 1) !== want.notNull)
      problems.push(
        `column "${want.name}" is ${got.notnull === 1 ? 'NOT NULL' : 'nullable'}, expected ${
          want.notNull ? 'NOT NULL' : 'nullable'
        }`,
      );
    if (got.pk > 0 !== want.primaryKey)
      problems.push(
        `column "${want.name}" is ${got.pk > 0 ? 'part of the primary key' : 'not a key'}, expected the opposite`,
      );
  }
  const extra = columns.filter((c) => !EXPECTED_COLUMNS.some((e) => e.name === c.name));
  for (const c of extra) problems.push(`unexpected column "${c.name}"`);

  const keys = sqlite.prepare(`PRAGMA foreign_key_list(${POLICY_TABLE})`).all() as Array<{
    table: string;
    from: string;
    to: string;
  }>;
  const hasKey = keys.some(
    (k) =>
      k.table === EXPECTED_FOREIGN_KEY.table &&
      k.from === EXPECTED_FOREIGN_KEY.from &&
      k.to === EXPECTED_FOREIGN_KEY.to,
  );
  if (!hasKey)
    problems.push(
      `foreign key ${EXPECTED_FOREIGN_KEY.from} -> ${EXPECTED_FOREIGN_KEY.table}(${EXPECTED_FOREIGN_KEY.to}) is missing`,
    );
  if (keys.length !== 1) problems.push(`expected exactly one foreign key, found ${keys.length}`);

  const indexes = sqlite.prepare(`PRAGMA index_list(${POLICY_TABLE})`).all() as Array<{
    name: string;
    unique: number;
  }>;
  const index = indexes.find((i) => i.name === POLICY_INDEX);
  if (!index) problems.push(`index "${POLICY_INDEX}" is missing`);
  else {
    if (index.unique === 1) problems.push(`index "${POLICY_INDEX}" is unique, expected non-unique`);
    const cols = (
      sqlite.prepare(`PRAGMA index_info(${POLICY_INDEX})`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    if (cols.join(',') !== EXPECTED_INDEX_COLUMNS.join(','))
      problems.push(
        `index "${POLICY_INDEX}" covers (${cols.join(', ')}), expected (${EXPECTED_INDEX_COLUMNS.join(', ')})`,
      );
  }
  return problems;
}

export type ReconcileOutcome =
  | { action: 'no-bookkeeping' }
  | { action: 'not-legacy' }
  | { action: 'released'; rowsPreserved: number; tableExisted: boolean };

export class LegacyMigrationError extends Error {}

// Removes the stale bookkeeping row of the renumbered migration, and only that, so the
// remaining migrations replay correctly. Safe to call on any database and safe to call twice:
// once the row is gone there is nothing left to do.
export function reconcileRenumberedMigrations(sqlite: Database.Database): ReconcileOutcome {
  if (!tableExists(sqlite, MIGRATIONS_TABLE)) return { action: 'no-bookkeeping' };

  const stale = sqlite
    .prepare(`SELECT rowid, hash, created_at FROM ${MIGRATIONS_TABLE} WHERE created_at = ?`)
    .all(LEGACY_POLICY_WHEN) as Array<{ rowid: number; hash: string; created_at: number }>;
  if (stale.length === 0) return { action: 'not-legacy' };

  // The timestamp belongs to one migration and one only. Anything else recorded under it is
  // not a database this code knows how to reason about, so it is left untouched.
  const unknown = stale.filter((r) => r.hash !== LEGACY_POLICY_HASH);
  if (unknown.length > 0 || stale.length !== 1) {
    throw new LegacyMigrationError(
      [
        `Cannot upgrade this database automatically.`,
        ``,
        `${MIGRATIONS_TABLE} has ${stale.length} row(s) recorded at ${LEGACY_POLICY_WHEN}, the`,
        `timestamp of the policy-acceptance migration before it was renumbered, and`,
        `${unknown.length} of them do not carry its content hash.`,
        ``,
        `Nothing was changed. Please share the contents of ${MIGRATIONS_TABLE} rather than`,
        `editing it by hand.`,
      ].join('\n'),
    );
  }

  const tableExisted = tableExists(sqlite, POLICY_TABLE);
  if (tableExisted) {
    const problems = policyTableMismatches(sqlite);
    if (problems.length > 0) {
      throw new LegacyMigrationError(
        [
          `Cannot upgrade this database automatically.`,
          ``,
          `A table named "${POLICY_TABLE}" already exists, but it is not the table the`,
          `policy-acceptance migration creates:`,
          ...problems.map((p) => `  • ${p}`),
          ``,
          `Nothing was changed, and no data was touched. Resolve the difference before`,
          `migrating again: the upgrade will not adopt a table it cannot recognise.`,
        ].join('\n'),
      );
    }
  }

  const before = tableExisted ? countPolicyRows(sqlite) : 0;
  const apply = sqlite.transaction(() => {
    const removed = sqlite
      .prepare(`DELETE FROM ${MIGRATIONS_TABLE} WHERE created_at = ? AND hash = ?`)
      .run(LEGACY_POLICY_WHEN, LEGACY_POLICY_HASH).changes;
    if (removed !== 1)
      throw new LegacyMigrationError(
        `Expected to release exactly one stale migration record, released ${removed}.`,
      );
  });
  apply();

  // The table and its contents are untouched by design; prove it rather than assume it.
  const after = tableExisted ? countPolicyRows(sqlite) : 0;
  if (after !== before)
    throw new LegacyMigrationError(
      `Acceptance rows changed during the upgrade (${before} before, ${after} after). This is a bug.`,
    );
  return { action: 'released', rowsPreserved: before, tableExisted };
}

function countPolicyRows(sqlite: Database.Database): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${POLICY_TABLE}`).get() as { n: number }).n;
}

// After migrating: every table and column the journal's migrations create must be present. It
// catches the failure mode that made this module necessary — a migration skipped in silence
// because the bookkeeping said the database was newer than it was — instead of leaving it to
// surface as a confusing runtime error much later.
const REQUIRED_TABLES = [
  'users',
  'sessions',
  'letters',
  'bottles',
  'policy_acceptances',
  'moderation_cases',
  'letter_reports',
  'violations',
  'appeals',
  'risk_decisions',
  'public_openings',
];
const REQUIRED_COLUMNS: Array<[table: string, column: string]> = [
  ['users', 'time_zone'],
  ['users', 'role'],
  ['users', 'deleted_at'],
  ['moderation_cases', 'evidence_redacted_at'],
  ['bottles', 'public_deadline_at'],
];

export function assertSchemaComplete(sqlite: Database.Database): void {
  const missingTables = REQUIRED_TABLES.filter((t) => !tableExists(sqlite, t));
  const missingColumns = REQUIRED_COLUMNS.filter(([table, column]) => {
    if (missingTables.includes(table) || !tableExists(sqlite, table)) return false;
    const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return !columns.some((c) => c.name === column);
  });
  if (missingTables.length === 0 && missingColumns.length === 0) return;
  throw new LegacyMigrationError(
    [
      `The database is missing objects the migrations should have created:`,
      ...missingTables.map((t) => `  • table "${t}"`),
      ...missingColumns.map(([t, c]) => `  • column "${t}.${c}"`),
      ``,
      `This usually means a migration was recorded as applied without running. No data was`,
      `changed. Please report this with the contents of ${MIGRATIONS_TABLE}.`,
    ].join('\n'),
  );
}

// Reads the journal so tests and tools can talk about migrations by tag.
export function journalEntries(
  migrationsFolder: string,
): Array<{ tag: string; when: number; hash: string }> {
  const journal = JSON.parse(
    fs.readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ tag: string; when: number }> };
  return journal.entries.map((e) => ({
    tag: e.tag,
    when: e.when,
    hash: crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(migrationsFolder, `${e.tag}.sql`), 'utf8'))
      .digest('hex'),
  }));
}
