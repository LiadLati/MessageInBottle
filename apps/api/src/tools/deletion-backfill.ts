// Applies today's account-deletion rules to accounts deleted before they existed.
//
//   pnpm --filter @mib/api deletion:backfill               dry run: reports, changes nothing
//   pnpm --filter @mib/api deletion:backfill -- --apply    applies, in one transaction
//
// Accounts deleted before the ARCH-002 / ARCH-014 / SEC-012 fixes may still have adrift letters
// listed in the public ocean, lost letters with their text, harbour places held by letters that
// can never be opened, and moderation cases whose evidence can never become final. Whether to
// apply this to existing data is an operator decision (docs/REMEDIATION.md); the tool never
// runs on its own. The dry run performs the exact same work inside a transaction and rolls it
// back, so its counts are what --apply would do. It never runs migrations.
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { loadEnvFiles } from '../lib/env.js';
import { loadConfig } from '../config.js';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { sweepDeletedAccount, type DeletionSweep } from '../services/deletion.js';

export interface BackfillReport {
  applied: boolean;
  accounts: number;
  totals: DeletionSweep;
}

class Rollback extends Error {}

export function backfillDeletedAccounts(db: Db, now: number, apply: boolean): BackfillReport {
  const totals: DeletionSweep = {
    adriftWithdrawn: 0,
    lostLettersCleared: 0,
    inboundJourneysEnded: 0,
    harbourPlacesReleased: 0,
    appealsClosed: 0,
  };
  const deleted = db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.status, 'deleted'))
    .all();
  try {
    db.transaction((tx) => {
      for (const { id } of deleted) {
        const r = sweepDeletedAccount(tx, id, now);
        for (const k of Object.keys(totals) as (keyof DeletionSweep)[]) totals[k] += r[k];
      }
      if (!apply) throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return { applied: apply, accounts: deleted.length, totals };
}

function main(): void {
  loadEnvFiles();
  const config = loadConfig();
  const apply = process.argv.includes('--apply');
  let sqlite: Database.Database;
  try {
    sqlite = new Database(config.databasePath, { fileMustExist: true });
  } catch {
    console.error(`No database file at ${config.databasePath}. Nothing was changed.`);
    process.exit(1);
  }
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const report = backfillDeletedAccounts(drizzle(sqlite, { schema }), Date.now(), apply);
  sqlite.close();
  console.log(`Database: ${config.databasePath}`);
  console.log(JSON.stringify(report, null, 2));
  if (!apply) console.log('\nDry run: nothing was changed. Run again with --apply to apply it.');
}

if (process.argv[1] && /deletion-backfill\.(ts|js)$/.test(process.argv[1])) main();
