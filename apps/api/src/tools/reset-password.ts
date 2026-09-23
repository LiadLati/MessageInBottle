// pnpm --filter @mib/api password:reset -- …
//
// Resets the password of ONE existing account, lookup-then-confirm, the same shape as the role
// tools (tools/grant-role.ts):
//
//   password:reset -- --username <name> --email <address> [--expect-role <role>]
//       Looks the account up by username and by e-mail independently and prints what each
//       finds. Changes nothing.
//
//   password:reset -- --username <name> --email <address> [--expect-role <role>] --confirm <id>
//       Asks for the new password twice at a masked prompt (never on the command line, so it
//       is not in shell history), then changes only the password hash, invalidates every
//       outstanding reset token and signs every session out — the same writes as the in-app
//       reset. Then re-reads the account and prints what was verified.
//
// It never runs migrations, never creates a database file, and never prints a password or a
// hash. It stops without changing anything if the username and the e-mail name different
// accounts, either is unknown, the account is not active, or the role is not the expected one.
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { loadEnvFiles } from '../lib/env.js';
import { loadConfig } from '../config.js';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { lookUpAccount, resetAccountPassword, verifyReset } from './password-reset.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(message: string): never {
  console.error(`\n${message}`);
  process.exit(1);
}

// Reads one line from the terminal without echoing it. Each typed character shows as `*`.
function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function')
    fail(
      'The new password must be typed at an interactive terminal, so it is never piped, stored ' +
        'or placed on a command line. Nothing was changed.',
    );
  return new Promise((resolve) => {
    let value = '';
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (result: string | null) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
      if (result === null) fail('Cancelled. Nothing was changed.');
      resolve(result);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(value);
        if (ch === '\u0003' || ch === '\u001b') return done(null); // Ctrl-C, Esc
        if (ch === '\u0008' || ch === '\u007f') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stderr.write('\b \b');
          }
          continue;
        }
        if (ch < ' ') continue; // other control characters
        value += ch;
        process.stderr.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

function openExisting(path: string): { db: Db; sqlite: Database.Database } {
  let sqlite: Database.Database;
  try {
    sqlite = new Database(path, { fileMustExist: true });
  } catch {
    fail(`No database file at ${path}. Nothing was changed (this tool never creates one).`);
  }
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  // No migrations here: refuse a schema that lacks what the reset writes.
  const columns = (table: string) =>
    new Set((sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name));
  const users = columns('users');
  const resets = columns('password_resets');
  const sessions = columns('sessions');
  const missing = [
    ...[
      'id',
      'username',
      'email',
      'role',
      'status',
      'deleted_at',
      'password_hash',
      'password_updated_at',
    ]
      .filter((c) => !users.has(c))
      .map((c) => `users.${c}`),
    ...['user_id', 'used_at', 'invalidated_at']
      .filter((c) => !resets.has(c))
      .map((c) => `password_resets.${c}`),
    ...(sessions.has('user_id') ? [] : ['sessions.user_id']),
  ];
  if (missing.length > 0)
    fail(
      `This database is missing ${missing.join(', ')}. Start the API once so it applies its ` +
        'migrations, then run this again. Nothing was changed.',
    );
  return { db: drizzle(sqlite, { schema }), sqlite };
}

async function main(): Promise<void> {
  const username = arg('username');
  const email = arg('email');
  const expectRole = arg('expect-role');
  const confirm = arg('confirm');
  if (!username || !email)
    fail(
      'Usage: password:reset -- --username <name> --email <address> [--expect-role <role>] ' +
        '[--confirm <user id>]',
    );

  loadEnvFiles();
  const config = loadConfig();
  const { db, sqlite } = openExisting(config.databasePath);
  console.log(`Database: ${config.databasePath}`);

  const found = lookUpAccount(db, { username, email, expectRole });
  const show = (label: string, a: typeof found.byUsername) =>
    console.log(
      a
        ? `  ${label.padEnd(24)} id ${a.id}   username ${a.username}   role ${a.role}   status ${a.status}`
        : `  ${label.padEnd(24)} no account`,
    );
  console.log('\nIndependent lookups:');
  show(`username "${found.username}"`, found.byUsername);
  show(`e-mail ${found.email}`, found.byEmail);
  if (!found.account) {
    sqlite.close();
    fail(`${found.problem} Nothing was changed.`);
  }
  const account = found.account;
  console.log(
    `\nBoth identify the same active account:\n` +
      `  stable id   ${account.id}\n  username    ${account.username}\n` +
      `  role        ${account.role}\n  status      ${account.status}`,
  );

  if (!confirm) {
    console.log(
      `\nTo set a new password for this account, run the same command again with:\n` +
        `  --confirm ${account.id}\n` +
        'You will be asked for the password twice; it is not shown and not saved anywhere.',
    );
    sqlite.close();
    return;
  }
  if (confirm !== account.id) {
    sqlite.close();
    fail(
      `--confirm ${confirm} does not match this account's id ${account.id}. Nothing was changed.`,
    );
  }

  const before = db.select().from(schema.users).where(eq(schema.users.id, account.id)).get()!;
  let password = await promptHidden('\nNew password: ');
  const again = await promptHidden('Repeat new password: ');
  if (password !== again) {
    sqlite.close();
    fail('The two passwords do not match. Nothing was changed.');
  }

  let outcome;
  try {
    outcome = resetAccountPassword(db, { userId: account.id, password, now: Date.now() });
  } catch (err) {
    sqlite.close();
    fail(err instanceof Error ? err.message : String(err));
  }
  const v = verifyReset(db, before, password);
  password = '';
  sqlite.close();

  const line = (ok: boolean, text: string) => console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${text}`);
  console.log(`\nPassword changed for ${account.username} (${account.id}).`);
  console.log(
    `  sessions signed out: ${outcome.sessionsRevoked}; ` +
      `outstanding reset links invalidated: ${outcome.resetTokensInvalidated}`,
  );
  console.log('\nVerification:');
  line(v.sameId && v.sameUsername && v.sameEmail, 'stable id, username and e-mail unchanged');
  line(v.active, 'status is still active');
  line(v.sameRole, `role is still ${before.role}`);
  line(v.hashChanged, 'the stored password hash changed');
  line(v.newPasswordVerifies, 'the new password verifies against the stored hash');
  line(v.sessionsRemaining === 0, `no sessions remain (${v.sessionsRemaining})`);
  line(
    v.outstandingResetTokens === 0,
    `no outstanding reset links remain (${v.outstandingResetTokens})`,
  );
  const allOk =
    v.sameId &&
    v.sameUsername &&
    v.sameEmail &&
    v.active &&
    v.sameRole &&
    v.hashChanged &&
    v.newPasswordVerifies &&
    v.sessionsRemaining === 0 &&
    v.outstandingResetTokens === 0;
  if (!allOk) process.exit(1);
  console.log('\nSign in again with the new password; every earlier session has ended.');
}

void main();
