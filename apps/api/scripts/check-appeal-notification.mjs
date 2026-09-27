#!/usr/bin/env node
// Read-only check: did an accepted (or rejected) appeal leave its result notification, for the
// right account, and where does that entry sit in the person's history?
//
//   node apps/api/scripts/check-appeal-notification.mjs --username <appellant username> [--db <path>]
//
// It never opens the real database. It copies the database file (and its -wal and -shm files, if
// present) into a fresh temporary folder, queries the copy read-only, then deletes the copy. It
// prints stable ids, kinds, dedupe keys, statuses and timestamps only: no message text, letter
// text, appeal text, decision reason, email, password hash, session or token, and nothing about
// any account other than the ids it needs to show who owns and who decided each appeal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'package.json'));
const Database = require('better-sqlite3');

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
};
const username = arg('username');
const source = path.resolve(arg('db') ?? path.join(here, '..', 'data', 'mib.sqlite'));
if (!username) {
  console.error('usage: --username <appellant username> [--db <path to mib.sqlite>]');
  process.exit(2);
}
if (!fs.existsSync(source)) {
  console.error(`no database at ${source}`);
  process.exit(2);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appeal-check-'));
const copy = path.join(dir, 'copy.sqlite');
const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
try {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, copy + suffix);
  }
  const db = new Database(copy, { readonly: true, fileMustExist: true });
  const user = db.prepare('select id, role from users where username = ?').get(username);
  if (!user) {
    console.log(`no account with username ${JSON.stringify(username)}`);
    process.exit(1);
  }
  console.log(`appellant: ${user.id} (role ${user.role})`);
  const appeals = db
    .prepare(
      `select id, user_id, status, created_at, decided_at, decided_by_user_id
         from appeals where user_id = ? order by created_at`,
    )
    .all(user.id);
  if (appeals.length === 0) console.log('no appeals owned by this account');
  const byKey = db.prepare(
    `select rowid, id, user_id, kind, dedupe_key, created_at, read_at
       from notifications where dedupe_key = ?`,
  );
  // Where the entry sat in the history: newest-written first (this fix) and newest-stamped first
  // (before it). Only counts of this account's own rows.
  const aboveByRowid = db.prepare(
    'select count(*) n from notifications where user_id = ? and rowid > ?',
  );
  const aboveByCreatedAt = db.prepare(
    'select count(*) n from notifications where user_id = ? and (created_at > ? or (created_at = ? and rowid > ?))',
  );
  const total = db.prepare('select count(*) n from notifications where user_id = ?').get(user.id).n;
  for (const a of appeals) {
    console.log(`\nappeal ${a.id}`);
    console.log(`  owner ${a.user_id}${a.user_id === user.id ? ' (this account)' : ''}`);
    console.log(
      `  status ${a.status}, submitted ${iso(a.created_at)}, decided ${iso(a.decided_at)}`,
    );
    console.log(`  decided by ${a.decided_by_user_id ?? '-'}`);
    if (a.status === 'pending') continue;
    const key = `appeal_${a.status}:${a.id}`;
    const n = byKey.get(key);
    if (!n) {
      console.log(`  notification ${key}: NOT FOUND`);
      continue;
    }
    console.log(`  notification ${n.id}`);
    console.log(
      `    user_id ${n.user_id}${n.user_id === a.user_id ? ' (matches the appellant)' : ' (DOES NOT match the appellant)'}`,
    );
    console.log(`    kind ${n.kind}, dedupe_key ${n.dedupe_key}`);
    console.log(`    created_at ${iso(n.created_at)}, read_at ${iso(n.read_at)}`);
    const rowidRank = aboveByRowid.get(n.user_id, n.rowid).n;
    const stampRank = aboveByCreatedAt.get(n.user_id, n.created_at, n.created_at, n.rowid).n;
    console.log(
      `    entries above it: ${rowidRank} of ${total} now; ${stampRank} under the old createdAt order`,
    );
    console.log(
      `    one-time popup: ${n.read_at === null ? 'still due (unread)' : 'already consumed (read)'}`,
    );
  }
  db.close();
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
