// The whole surface by which a role is ever granted or taken away.
//
// Roles live on the users row and are read from it on every request. Registration never sets
// one, no request body, header or query is ever consulted for one, and nothing in application
// code decides a role from an e-mail address or any other attribute of the account. This file
// is it.
//
// The pattern is lookup-then-confirm, so the destructive step always names the stable id the
// operator has just read with their own eyes:
//
//   admin:grant     -- --email someone@example.com              prints the account; changes nothing
//   admin:grant     -- --username someone                       the same, by name
//   admin:grant     -- --email someone@example.com --confirm usr_…   grants, if the id matches
//   admin:grant     -- --revoke usr_…                           back to an ordinary member
//
//   developer:grant -- …                                        the same four forms
//
// `admin` and `developer` are disjoint: granting one replaces the other rather than adding to
// it, and the tool says so before it does it.
import os from 'node:os';
import { eq } from 'drizzle-orm';
import { normalizeEmail, normalizeUsername } from '@mib/shared';
import { loadEnvFiles } from '../lib/env.js';
import { loadConfig } from '../config.js';
import { createDb, runMigrations } from '../db/client.js';
import * as t from '../db/schema.js';

export type GrantableRole = 'admin' | 'developer';

const DESCRIPTION: Record<GrantableRole, string> = {
  admin: 'review and decide reports and appeals. It does NOT grant the DEV simulation controls.',
  developer:
    'use the DEV simulation panel, and only outside production. It grants NO moderation\n' +
    '  authority whatsoever: admin routes answer 403 for it.',
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function runGrantCli(role: GrantableRole): void {
  const script = `${role === 'admin' ? 'admin' : 'developer'}:grant`;
  loadEnvFiles();
  const config = loadConfig();
  const { db } = createDb(config.databasePath);
  runMigrations(db);

  const email = arg('email');
  const username = arg('username');
  const confirm = arg('confirm');
  const revoke = arg('revoke');
  const by = `cli:${os.userInfo().username}@${os.hostname()}`;
  const now = Date.now();

  if (revoke) {
    const row = db.select().from(t.users).where(eq(t.users.id, revoke)).get();
    if (!row) fail(`No account with id ${revoke}.`);
    if (row.role !== role) {
      console.log(
        `${row.username} (${row.id}) is ${row.role === 'member' ? 'an ordinary member' : `a ${row.role}`}, not a ${role}. Nothing was changed.`,
      );
      process.exit(0);
    }
    db.update(t.users)
      .set({ role: 'member', roleGrantedAt: now, roleGrantedBy: by })
      .where(eq(t.users.id, revoke))
      .run();
    console.log(`The ${role} role was revoked from ${row.username} (${row.id}) by ${by}.`);
    process.exit(0);
  }

  if (!email && !username)
    fail(
      `Usage: ${script} -- (--email <address> | --username <name>) [--confirm <user id>] | --revoke <user id>`,
    );
  const normalized = email ? normalizeEmail(email) : normalizeUsername(username!);
  const user = email
    ? db.select().from(t.users).where(eq(t.users.email, normalized)).get()
    : db.select().from(t.users).where(eq(t.users.username, normalized)).get();
  if (!user) {
    console.error(
      email
        ? `No account is registered with ${normalized}. Nothing was changed.`
        : `No account has the username ${normalized}. Nothing was changed.`,
    );
    if (email)
      console.error(
        'If the account was registered under another address, look it up by name instead:\n' +
          `  ${script} -- --username <name>`,
      );
    process.exit(1);
  }
  const lookedUpBy = email ? normalized : `username ${normalized}`;
  console.log(`Account for ${lookedUpBy}:`);
  console.log(`  id          ${user.id}`);
  console.log(`  username    ${user.username}`);
  console.log(`  display     ${user.displayName}`);
  console.log(`  created     ${new Date(user.createdAt).toISOString()}`);
  console.log(`  status      ${user.status}`);
  console.log(`  role        ${user.role}`);
  if (!confirm) {
    console.log(`\nThe ${role} role lets an account ${DESCRIPTION[role]}`);
    if (user.role !== 'member' && user.role !== role)
      console.log(
        `\nNote: this account is currently a ${user.role}. Granting ${role} REPLACES that role;\n` +
          '  an account holds one role at a time.',
      );
    console.log(
      `\nTo grant ${role} to this account, run again with:  ${
        email ? `--email ${normalized}` : `--username ${normalized}`
      } --confirm ${user.id}`,
    );
    process.exit(0);
  }
  if (confirm !== user.id)
    fail(`--confirm ${confirm} does not match this account's id ${user.id}. Nothing was changed.`);
  if (user.status !== 'active') fail('This account is not active. Nothing was changed.');
  if (user.role === role) {
    console.log(`\nThis account already has the ${role} role. Nothing was changed.`);
    process.exit(0);
  }
  const replaced = user.role !== 'member' ? ` (replacing ${user.role})` : '';
  db.update(t.users)
    .set({ role, roleGrantedAt: now, roleGrantedBy: by })
    .where(eq(t.users.id, user.id))
    .run();
  console.log(
    `\nThe ${role} role was granted to ${user.username} (${user.id})${replaced} by ${by}.`,
  );
}
