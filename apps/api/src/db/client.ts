import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';
import { assertSchemaComplete, reconcileRenumberedMigrations } from './compat.js';
import { API_ROOT } from '../config.js';

export type Db = ReturnType<typeof createDb>['db'];
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export function createDb(databasePath: string) {
  if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const sqlite = new Database(databasePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

export const MIGRATIONS_FOLDER = path.join(API_ROOT, 'drizzle');

// The one way migrations are ever applied: `pnpm db:migrate`, the API at startup, the seed
// and every tool come through here, so a database that needs the compatibility step gets it
// whichever of them a person happens to run.
export function runMigrations(db: Db, migrationsFolder = MIGRATIONS_FOLDER) {
  const sqlite = (db as unknown as { $client: Database.Database }).$client;
  // Before anything is applied: release the bookkeeping of the migration that was renumbered,
  // but only after proving the table it created is the one still there (see compat.ts).
  const outcome = reconcileRenumberedMigrations(sqlite);
  if (outcome.action === 'released') {
    console.log(
      `Upgrading a database from before the policy-acceptance migration was renumbered: ` +
        `${outcome.rowsPreserved} acceptance row(s) kept, nothing recreated.`,
    );
  }
  migrate(db, { migrationsFolder });
  // And afterwards: nothing the journal promises may be missing.
  if (migrationsFolder === MIGRATIONS_FOLDER) assertSchemaComplete(sqlite);
}
