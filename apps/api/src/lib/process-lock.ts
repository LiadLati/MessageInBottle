import Database from 'better-sqlite3';

// One API process per database file (audit ARCH-004, re-audit ARCH-R-003). The journey,
// AI-review and retention workers run inside the API, and rate limits live in its memory; a
// second process on the same file would run every worker twice and double every limit.
//
// The lock is an exclusive SQLite lock on a small companion file, `<database>.process-lock`,
// held open for the life of the process. The operating system holds it, not a PID written in a
// file, so:
//   • it is released the moment the holding process exits or is killed, with nothing stale to
//     clean up;
//   • it is honoured between containers that mount the same volume on one host, where PIDs are
//     meaningless (two containers can both be PID 1), which the earlier PID file was not;
//   • it is honoured between two openings in the same process too (SQLite tracks its own locks
//     per file), which is what the tests rely on.
// Like SQLite itself it relies on working file locks, so the database must not be on a network
// file system; docs/DEPLOYMENT.md requires a local volume and one replica.
//
// Command-line tools (grants, backups, retention) do not take it: they are safe alongside the
// server through SQLite's own locking on the database file.
export class ProcessLockError extends Error {
  override readonly name = 'ProcessLockError';
}

export function processLockPath(databasePath: string): string {
  return `${databasePath}.process-lock`;
}

export function acquireProcessLock(databasePath: string): () => void {
  if (databasePath === ':memory:') return () => {};
  const file = processLockPath(databasePath);
  const lock = new Database(file, { timeout: 0 });
  try {
    lock.pragma('journal_mode = DELETE');
    lock.pragma('locking_mode = EXCLUSIVE');
    // Takes the exclusive file lock now and keeps it: the transaction is never committed.
    lock.exec('BEGIN EXCLUSIVE');
  } catch (err) {
    lock.close();
    if ((err as { code?: string }).code?.startsWith('SQLITE_BUSY'))
      throw new ProcessLockError(
        `Another SeaYou API process is already running on ${databasePath}. ` +
          'Run exactly one API process per database file.',
      );
    throw err;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      lock.exec('ROLLBACK');
    } catch {
      /* nothing open */
    }
    lock.close();
  };
}
