import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { POLICY_DOCUMENTS, currentPolicyVersions } from '@mib/shared';
import { createDb } from '../db/client.js';
import { prepareDatabase } from '../db/seed.js';
import { createApp } from '../http/app.js';
import { OutboxMailer } from '../lib/mail.js';
import { SystemClock } from '../lib/clock.js';
import { testConfig } from '../test/harness.js';
import { backupDatabase, inspectBackup } from './backup.js';

// The restore drill the deployment contract relies on (ARCH-006): take a backup of a live
// database while it has writes that exist only in its -wal file, restore it to a new path, and
// run the application on the restored copy.
const dirs: string[] = [];
const tempDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'seayou-backup-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function appOn(file: string) {
  const { db, sqlite } = createDb(file);
  const config = testConfig({ databasePath: file, devMode: false });
  prepareDatabase(db, config, Date.now());
  const clock = new SystemClock();
  return {
    sqlite,
    app: createApp({
      db,
      clock,
      realClock: clock,
      config,
      mailer: new OutboxMailer(() => Date.now()),
    }),
  };
}

const register = (app: ReturnType<typeof createApp>, username: string) =>
  app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      email: `${username}@example.test`,
      password: 'a-long-enough-password',
      policies: {
        acceptTerms: true,
        acceptGuidelines: true,
        acknowledgePrivacy: true,
        versions: currentPolicyVersions(POLICY_DOCUMENTS),
      },
    }),
  });

describe('backup and restore drill', () => {
  it('captures writes still in the WAL, verifies the copy, and the app runs on it', async () => {
    const dir = tempDir();
    const live = path.join(dir, 'live.sqlite');
    const source = appOn(live);
    source.sqlite.pragma('wal_autocheckpoint = 0'); // keep every write in the -wal file
    for (const name of ['wren', 'ibis', 'tern'])
      expect((await register(source.app, name)).status).toBe(201);
    expect(fs.statSync(`${live}-wal`).size).toBeGreaterThan(0);

    const backupFile = path.join(dir, 'backups', 'seayou.sqlite');
    const report = await backupDatabase(live, backupFile);
    expect(report.integrity).toBe('ok');
    expect(report.counts.users).toBe(3);
    expect(report.migrations).toBeGreaterThan(0);

    // A plain copy of the main file alone would have missed those rows.
    const naive = path.join(dir, 'naive.sqlite');
    fs.copyFileSync(live, naive);
    expect(inspectBackup(naive).counts.users).toBe(0);

    // Restore: the backup file placed where a stopped server will open it.
    const restored = path.join(dir, 'restored', 'seayou.sqlite');
    fs.mkdirSync(path.dirname(restored));
    fs.copyFileSync(backupFile, restored);
    const target = appOn(restored);
    const login = await target.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ibis', password: 'a-long-enough-password' }),
    });
    expect(login.status).toBe(200);
    target.sqlite.close();
    source.sqlite.close();
  });

  it('never overwrites an existing file', async () => {
    const dir = tempDir();
    const live = path.join(dir, 'live.sqlite');
    appOn(live).sqlite.close();
    const existing = path.join(dir, 'existing.sqlite');
    fs.writeFileSync(existing, 'keep me');
    await expect(backupDatabase(live, existing)).rejects.toThrow(/never overwrites/);
    expect(fs.readFileSync(existing, 'utf8')).toBe('keep me');
  });
});
