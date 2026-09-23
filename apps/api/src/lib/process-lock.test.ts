import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessLockError, acquireProcessLock } from './process-lock.js';

const dirs: string[] = [];
const dbPath = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'seayou-lock-'));
  dirs.push(d);
  return path.join(d, 'seayou.sqlite');
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('one API process per database (ARCH-004)', () => {
  it('refuses a second live process on the same file', () => {
    const db = dbPath();
    const release = acquireProcessLock(db);
    // Another live process: this test runner's parent is alive for the whole run.
    expect(() => acquireProcessLock(db, process.ppid)).toThrow(ProcessLockError);
    release();
    expect(fs.existsSync(`${db}.lock`)).toBe(false);
    acquireProcessLock(db, process.ppid)();
  });

  it('takes over a lock left by a process that died', () => {
    const db = dbPath();
    fs.writeFileSync(`${db}.lock`, '999999999');
    const release = acquireProcessLock(db);
    expect(fs.readFileSync(`${db}.lock`, 'utf8')).toBe(String(process.pid));
    release();
  });

  it('never locks an in-memory database', () => {
    expect(() => {
      acquireProcessLock(':memory:');
      acquireProcessLock(':memory:');
    }).not.toThrow();
  });
});
