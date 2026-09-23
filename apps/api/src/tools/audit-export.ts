// Exports the moderation audit trail about one account, for answering a data-subject request
// (Privacy Policy §2 and §9: "an audit record of each moderation action taken on it, which
// administrator took it and when"). Read-only; prints JSON to stdout.
//
//   pnpm --filter @mib/api audit:export -- --user usr_…
//   node dist/audit-export.js -- --user usr_…                         (production)
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { loadEnvFiles } from '../lib/env.js';
import { loadConfig } from '../config.js';
import * as schema from '../db/schema.js';
import { readAudit } from '../services/audit.js';

const i = process.argv.indexOf('--user');
const userId = i >= 0 ? process.argv[i + 1] : undefined;
if (!userId || !/^usr_[a-z0-9]+$/.test(userId)) {
  console.error('Usage: audit:export -- --user <user id>');
  process.exit(1);
}
loadEnvFiles();
const config = loadConfig();
let sqlite: Database.Database;
try {
  sqlite = new Database(config.databasePath, { readonly: true, fileMustExist: true });
} catch {
  console.error(`No database file at ${config.databasePath}.`);
  process.exit(1);
}
const entries = readAudit(drizzle(sqlite, { schema }), { subjectUserId: userId }, 100_000);
sqlite.close();
console.log(JSON.stringify({ userId, exportedAt: new Date().toISOString(), entries }, null, 2));
