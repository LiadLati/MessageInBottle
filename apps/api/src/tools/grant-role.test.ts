import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, runMigrations, type Db } from '../db/client.js';
import * as t from '../db/schema.js';
import { newId } from '../lib/ids.js';

// The grant tools are the entire surface by which a role is ever given. They are run here as
// real processes against a real database file, because what matters is what the command does
// when somebody types it — including the cases where it must refuse and change nothing.

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let dir: string;
let dbPath: string;
let db: Db;
const ids: Record<string, string> = {};

function run(script: 'grant-admin' | 'grant-developer', args: string[]) {
  try {
    const stdout = execFileSync(
      path.join(API_ROOT, 'node_modules', '.bin', 'tsx'),
      [path.join(API_ROOT, 'src', 'tools', `${script}.ts`), ...args],
      { cwd: API_ROOT, env: { ...process.env, MIB_DATABASE_PATH: dbPath }, encoding: 'utf8' },
    );
    return { code: 0, out: stdout };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}
const roleOf = (username: string) =>
  db.select().from(t.users).where(eq(t.users.username, username)).get()!.role;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mib-grant-'));
  dbPath = path.join(dir, 'grant.sqlite');
  const created = createDb(dbPath);
  db = created.db;
  runMigrations(db);
  for (const [username, email] of [
    ['rosa', 'rosa@example.test'],
    ['sam', 'sam@example.test'],
    ['gone', 'gone@example.test'],
  ]) {
    const id = newId('usr');
    ids[username!] = id;
    db.insert(t.users)
      .values({
        id,
        username: username!,
        displayName: username!,
        email: email!,
        createdAt: Date.now(),
        passwordHash: 'x',
      })
      .run();
  }
  db.update(t.users).set({ status: 'deleted' }).where(eq(t.users.id, ids.gone!)).run();
}, 60_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('granting a role', () => {
  it('only reports the account when asked to look it up, and changes nothing', () => {
    const res = run('grant-admin', ['--email', 'rosa@example.test']);
    expect(res.code).toBe(0);
    expect(res.out).toContain(ids.rosa!);
    expect(res.out).toContain('--confirm');
    expect(roleOf('rosa')).toBe('member');
  });

  it('grants only when the confirmed id matches the account looked up', () => {
    const wrong = run('grant-admin', ['--email', 'rosa@example.test', '--confirm', ids.sam!]);
    expect(wrong.code).toBe(1);
    expect(wrong.out).toMatch(/does not match/);
    expect(roleOf('rosa')).toBe('member');

    const right = run('grant-admin', ['--email', 'rosa@example.test', '--confirm', ids.rosa!]);
    expect(right.code).toBe(0);
    expect(roleOf('rosa')).toBe('admin');
    // It records who did it and when, not just that it happened.
    const row = db.select().from(t.users).where(eq(t.users.id, ids.rosa!)).get()!;
    expect(row.roleGrantedBy).toMatch(/^cli:/);
    expect(row.roleGrantedAt).not.toBeNull();
  });

  it('grants the developer role through its own command, and keeps the roles disjoint', () => {
    expect(run('grant-developer', ['--username', 'sam', '--confirm', ids.sam!]).code).toBe(0);
    expect(roleOf('sam')).toBe('developer');

    // Granting the other role replaces it rather than adding to it, and says so first.
    const preview = run('grant-admin', ['--username', 'sam']);
    expect(preview.out).toMatch(/REPLACES that role/);
    expect(roleOf('sam')).toBe('developer');
    expect(run('grant-admin', ['--username', 'sam', '--confirm', ids.sam!]).code).toBe(0);
    expect(roleOf('sam')).toBe('admin');
  });

  it('refuses an account that does not exist, and one that is not active', () => {
    const missing = run('grant-admin', ['--email', 'nobody@example.test']);
    expect(missing.code).toBe(1);
    expect(missing.out).toMatch(/Nothing was changed/);

    const deleted = run('grant-admin', ['--username', 'gone', '--confirm', ids.gone!]);
    expect(deleted.code).toBe(1);
    expect(deleted.out).toMatch(/not active/);
    expect(roleOf('gone')).toBe('member');
  });

  it('refuses to guess when told nothing to look up', () => {
    const res = run('grant-admin', []);
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/Usage/);
  });

  it('revokes only the role it was asked about', () => {
    // sam is an admin at this point; the developer command must not touch that.
    const wrongTool = run('grant-developer', ['--revoke', ids.sam!]);
    expect(wrongTool.code).toBe(0);
    expect(wrongTool.out).toMatch(/not a developer/);
    expect(roleOf('sam')).toBe('admin');

    expect(run('grant-admin', ['--revoke', ids.sam!]).code).toBe(0);
    expect(roleOf('sam')).toBe('member');
  });

  it('is a no-op when the account already holds the role', () => {
    const res = run('grant-admin', ['--username', 'rosa', '--confirm', ids.rosa!]);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/already has the admin role/);
    expect(roleOf('rosa')).toBe('admin');
  });
});
