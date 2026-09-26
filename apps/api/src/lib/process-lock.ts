import fs from 'node:fs';

// One API process per database file (audit ARCH-004). The journey, AI-review and retention
// workers run inside the API, and rate limits live in its memory; a second process on the same
// file would run every worker twice and double every limit. The server therefore takes an
// exclusive lock file beside the database and refuses to start while another live process holds
// it. A lock left by a process that died is recognised by its PID and taken over.
//
// Command-line tools (grants, backups, retention) do not take it: they are safe alongside the
// server through SQLite's own locking.
export class ProcessLockError extends Error {
  override readonly name = 'ProcessLockError';
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireProcessLock(databasePath: string, pid = process.pid): () => void {
  if (databasePath === ':memory:') return () => {};
  const file = `${databasePath}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(pid), { flag: 'wx' });
      return () => {
        try {
          if (fs.readFileSync(file, 'utf8').trim() === String(pid)) fs.rmSync(file);
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = Number(fs.readFileSync(file, 'utf8').trim());
      if (Number.isInteger(holder) && holder > 0 && holder !== pid && alive(holder))
        throw new ProcessLockError(
          `Another SeaYou API process (pid ${holder}) is already running on ${databasePath}. ` +
            'Run exactly one API process per database file.',
        );
      // Stale: the process that held it is gone. Remove it and try once more.
      fs.rmSync(file, { force: true });
    }
  }
  throw new ProcessLockError(`Could not take the process lock ${file}.`);
}
