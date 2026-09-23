// Online, consistent backup of the SeaYou database, and verification of a backup file.
//
//   pnpm --filter @mib/api db:backup  -- --to /backups/seayou-2026-09-24.sqlite
//   node dist/backup.js               -- --to /backups/seayou-2026-09-24.sqlite     (production)
//   node dist/backup.js               -- --verify /backups/seayou-2026-09-24.sqlite
//
// A plain file copy of a live SQLite database in WAL mode can be torn: the newest pages live in
// the -wal file until a checkpoint. This uses SQLite's online backup API instead, which is safe
// while the API is running and writing, then re-opens the copy read-only and checks it
// (integrity check, migration count, row counts) before reporting success. It never overwrites
// an existing file and never writes to the source database.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadEnvFiles } from '../lib/env.js';
import { loadConfig } from '../config.js';

export interface BackupReport {
  file: string;
  bytes: number;
  integrity: string;
  migrations: number;
  counts: Record<string, number>;
}

const COUNTED = ['users', 'bottles', 'letters', 'moderation_cases', 'policy_acceptances'] as const;

export function inspectBackup(file: string): BackupReport {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = (db.pragma('integrity_check', { simple: true }) as string) ?? 'unknown';
    const migrations = (
      db.prepare('select count(*) as n from __drizzle_migrations').get() as { n: number }
    ).n;
    const counts: Record<string, number> = {};
    for (const table of COUNTED)
      counts[table] = (db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
    return { file, bytes: fs.statSync(file).size, integrity, migrations, counts };
  } finally {
    db.close();
  }
}

export async function backupDatabase(source: string, destination: string): Promise<BackupReport> {
  if (!fs.existsSync(source)) throw new Error(`No database at ${source}.`);
  if (fs.existsSync(destination))
    throw new Error(`${destination} already exists; a backup never overwrites a file.`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destination);
  } finally {
    db.close();
  }
  const report = inspectBackup(destination);
  if (report.integrity !== 'ok')
    throw new Error(`The backup failed its integrity check: ${report.integrity}`);
  return report;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const to = arg('to');
  const verify = arg('verify');
  if (!to && !verify) {
    console.error('Usage: backup -- --to <new file>   |   backup -- --verify <backup file>');
    process.exit(1);
  }
  if (verify) {
    const report = inspectBackup(path.resolve(verify));
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.integrity === 'ok' ? 0 : 1);
  }
  loadEnvFiles();
  const config = loadConfig();
  const report = await backupDatabase(config.databasePath, path.resolve(to!));
  console.log(`Backed up ${config.databasePath}`);
  console.log(JSON.stringify(report, null, 2));
}

// Run only as a script, never on import (the build bundles each entry separately, and tests
// import the functions above).
if (process.argv[1] && /backup\.(ts|js)$/.test(process.argv[1]))
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
