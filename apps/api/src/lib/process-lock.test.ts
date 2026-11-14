import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessLockError, acquireProcessLock, processLockPath } from './process-lock.js';

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dirs: string[] = [];
const dbPath = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'seayou-lock-'));
  dirs.push(d);
  return path.join(d, 'seayou.sqlite');
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// A real second process holding the lock, as another API (or another container on the same
// volume) would. Resolves once it holds it.
function holderProcess(db: string) {
  const script = `
    import { acquireProcessLock } from ${JSON.stringify(path.join(API_ROOT, 'src', 'lib', 'process-lock.ts'))};
    acquireProcessLock(process.argv[1]);
    console.log('held');
    setInterval(() => {}, 1000);
  `;
  // Node itself (with tsx as a loader), not the tsx wrapper, so that killing the child kills
  // the process that holds the lock.
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script, db],
    { cwd: API_ROOT, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (d: Buffer) => {
      if (d.toString().includes('held')) resolve();
    });
    child.once('exit', (code) => reject(new Error(`holder exited early (${code})`)));
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return { child, ready, exited };
}

describe('one API process per database (ARCH-004, ARCH-R-003)', () => {
  it('refuses a second holder in the same process until the first releases', () => {
    const db = dbPath();
    const release = acquireProcessLock(db);
    expect(() => acquireProcessLock(db)).toThrow(ProcessLockError);
    release();
    release(); // idempotent
    acquireProcessLock(db)();
  });

  it('refuses while another live process holds it, and is free the moment that process is killed', async () => {
    const db = dbPath();
    const holder = holderProcess(db);
    try {
      await holder.ready;
      expect(() => acquireProcessLock(db)).toThrow(ProcessLockError);
      // Killed without any chance to clean up, as a crash or an OOM kill would.
      holder.child.kill('SIGKILL');
      await holder.exited;
      const release = acquireProcessLock(db);
      release();
    } finally {
      holder.child.kill('SIGKILL');
    }
  });

  it('ignores a leftover PID file from the earlier lock, whatever PID it names', () => {
    const db = dbPath();
    // The old scheme's file, naming a PID that is alive here (as PID 1 is in every container).
    fs.writeFileSync(`${db}.lock`, '1');
    const release = acquireProcessLock(db);
    expect(fs.existsSync(processLockPath(db))).toBe(true);
    release();
  });

  it('never locks an in-memory database', () => {
    expect(() => {
      acquireProcessLock(':memory:');
      acquireProcessLock(':memory:');
    }).not.toThrow();
  });
});
