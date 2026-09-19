// Grants (or revokes) the admin role — the only way it is ever set.
//
//   pnpm --filter @mib/api admin:grant -- --email someone@example.com
//       looks the account up by its normalised e-mail and prints its stable id; changes nothing
//   pnpm --filter @mib/api admin:grant -- --email someone@example.com --confirm usr_…
//       grants admin to that account, and only if the id printed above matches
//   pnpm --filter @mib/api admin:grant -- --revoke usr_…
//       takes the role away again
//
// Runs on the server against the configured database (MIB_DATABASE_PATH). Registration never
// sets a role and no request ever carries one, so this file is the whole grant surface.
import os from 'node:os';
import { eq } from 'drizzle-orm';
import { normalizeEmail } from '@mib/shared';
import { loadEnvFiles } from '../lib/env.js';
import { loadConfig } from '../config.js';
import { createDb, runMigrations } from '../db/client.js';
import * as t from '../db/schema.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

loadEnvFiles();
const config = loadConfig();
const { db } = createDb(config.databasePath);
runMigrations(db);

const email = arg('email');
const confirm = arg('confirm');
const revoke = arg('revoke');
const by = `cli:${os.userInfo().username}@${os.hostname()}`;
const now = Date.now();

if (revoke) {
  const row = db.select().from(t.users).where(eq(t.users.id, revoke)).get();
  if (!row) fail(`No account with id ${revoke}.`);
  db.update(t.users)
    .set({ role: 'member', roleGrantedAt: now, roleGrantedBy: by })
    .where(eq(t.users.id, revoke))
    .run();
  console.log(`Admin role revoked from ${row.username} (${row.id}).`);
  process.exit(0);
}

if (!email)
  fail('Usage: admin:grant -- --email <address> [--confirm <user id>] | --revoke <user id>');
const normalized = normalizeEmail(email);
const user = db.select().from(t.users).where(eq(t.users.email, normalized)).get();
if (!user) fail(`No account is registered with ${normalized}. Nothing was changed.`);
console.log(`Account for ${normalized}:`);
console.log(`  id          ${user.id}`);
console.log(`  username    ${user.username}`);
console.log(`  display     ${user.displayName}`);
console.log(`  created     ${new Date(user.createdAt).toISOString()}`);
console.log(`  status      ${user.status}`);
console.log(`  role        ${user.role}`);
if (!confirm) {
  console.log(
    `\nTo grant admin to this account, run again with:  --email ${normalized} --confirm ${user.id}`,
  );
  process.exit(0);
}
if (confirm !== user.id) {
  fail(`--confirm ${confirm} does not match this account's id ${user.id}. Nothing was changed.`);
}
if (user.status !== 'active') fail('This account is not active. Nothing was changed.');
if (user.role === 'admin') {
  console.log('\nThis account is already an admin. Nothing was changed.');
  process.exit(0);
}
db.update(t.users)
  .set({ role: 'admin', roleGrantedAt: now, roleGrantedBy: by })
  .where(eq(t.users.id, user.id))
  .run();
console.log(`\nAdmin role granted to ${user.username} (${user.id}) by ${by}.`);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
