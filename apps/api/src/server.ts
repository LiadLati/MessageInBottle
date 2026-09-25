import type { AppContext } from './services/context.js';

// The API is one half of `pnpm dev`. When it dies, the web dev server keeps serving the app
// happily and every /api request becomes the proxy's empty 500, which reads in the UI as a
// broken sign-in rather than a backend that never started. So the whole boot — module loading
// included — runs inside a handler that says plainly what failed and what to do about it.
// That is why the imports below are dynamic: a failure to load a native module or a missing
// dependency is reported here instead of as a bare stack trace from Node's loader.
async function main(): Promise<void> {
  // Before anything reads configuration: a .env file is how the README tells people to supply
  // SMTP credentials, so it has to be in process.env by the time loadConfig runs.
  const { loadEnvFiles } = await import('./lib/env.js');
  const loadedEnv = loadEnvFiles();
  const { loadConfig, PRODUCTION_BUILD } = await import('./config.js');
  const { createDb } = await import('./db/client.js');
  const { prepareDatabase } = await import('./db/seed.js');
  const { createApp } = await import('./http/app.js');
  const { DevClock, SystemClock } = await import('./lib/clock.js');
  const { createMailer } = await import('./lib/mail.js');
  const { runJourneyTick } = await import('./services/journey.js');
  const { activatePublicListings } = await import('./services/risk.js');
  const { policyActivatedAt } = await import('./services/weather.js');
  const { createOllamaReviewer, releaseStaleAiClaims, runAiReviewTick } =
    await import('./services/ai-review.js');
  const { applyRetention } = await import('./services/retention.js');
  const { pruneExpiredRecords } = await import('./services/housekeeping.js');
  const { serve } = await import('@hono/node-server');
  const { assertPolicySetServeable } = await import('./services/policies.js');

  const config = loadConfig();
  // A released document set that still carries an unresolved field must never be served.
  assertPolicySetServeable();
  const { acquireProcessLock } = await import('./lib/process-lock.js');
  const releaseLock = acquireProcessLock(config.databasePath);
  process.once('exit', releaseLock);
  const { db, sqlite } = createDb(config.databasePath);
  prepareDatabase(db, config, Date.now());
  // One API process per database: any review still marked running was interrupted by the last
  // stop, whether or not AI review is enabled now.
  const interrupted = releaseStaleAiClaims(db, Date.now(), 0);
  if (interrupted > 0)
    console.log(`Returned ${interrupted} interrupted AI review(s) to the queue.`);

  const ctx: AppContext = {
    db,
    clock: config.devMode ? new DevClock(db) : new SystemClock(),
    realClock: new SystemClock(),
    config,
    mailer: createMailer(config.mail),
  };
  // Adrift bottles listed before the 72-hour rule existed get a full 72 hours from now.
  const activated = activatePublicListings(ctx);
  // Risk policy v4 takes over from this boot on (recorded once; later boots keep the first).
  policyActivatedAt(ctx);
  if (activated > 0) console.log(`Public listing deadline set for ${activated} legacy bottle(s).`);
  const app = createApp(ctx);

  // In-process journey worker. Deterministic catch-up means a missed tick is harmless.
  const worker = setInterval(() => {
    try {
      runJourneyTick(ctx);
    } catch (err) {
      console.error('journey tick failed', err);
    }
  }, config.journeyTickMs);
  worker.unref();

  // The AI review queue: reported letters go to the local model when it is reachable, and wait
  // when it is not. Nothing but a queued case ever leaves the server, and nothing the model
  // says is acted on before the backend has validated it.
  const reviewer = createOllamaReviewer(config.ai);
  let reviewing = false;
  const aiWorker = setInterval(() => {
    if (reviewing || !config.ai.enabled) return;
    reviewing = true;
    runAiReviewTick(ctx, reviewer)
      .catch((err) => console.error('AI review tick failed', err))
      .finally(() => {
        reviewing = false;
      });
  }, config.ai.tickMs);
  aiWorker.unref();

  // Evidence retention. The published policy says content evidence goes seven days after a case
  // becomes final, so something has to actually remove it: a plan nobody runs is not a policy.
  // The pass is idempotent and re-checks every case inside its own transaction, so an hourly
  // tick that overlaps a decision, an appeal or a hold does the right thing.
  const retentionWorker = setInterval(() => {
    try {
      pruneExpiredRecords(db, Date.now());
    } catch (err) {
      console.error('housekeeping tick failed', err);
    }
    if (!config.retention.enabled) return;
    try {
      const result = applyRetention(db, Date.now(), config.retention);
      if (result.redacted.length > 0)
        console.log(
          `Evidence retention: redacted ${result.redacted.length} case(s) decided more than ` +
            `${config.retention.afterDecisionMs / 86_400_000} days ago.`,
        );
    } catch (err) {
      console.error('retention tick failed', err);
    }
  }, config.retentionTickMs);
  retentionWorker.unref();

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    for (const file of loadedEnv) console.log(`Loaded environment from ${file}`);
    console.log(
      `SeaYou API listening on http://localhost:${info.port} (devMode=${config.devMode}, mail=${config.mail.provider})`,
    );
    console.log(
      config.ai.enabled
        ? `  AI review: ${config.ai.model} at ${config.ai.endpoint} (recommendations only); reports queue while it is offline.`
        : '  AI review is OFF: reports wait for an admin.',
    );
    if (!config.devMode && !PRODUCTION_BUILD && process.env.NODE_ENV !== 'production')
      console.log(
        '  Development mode is OFF (the default). For local development with seeded accounts, the\n' +
          '  dev clock and the dev bar, set MIB_DEV_MODE=true in apps/api/.env or the root .env.',
      );
    if (config.mail.provider !== 'smtp') {
      console.log(
        config.mail.provider === 'outbox'
          ? '  Mail is CAPTURED, not delivered: a signed-in developer account reads it in the app’s dev bar.'
          : '  Mail is DISABLED: nothing is delivered. Set MIB_MAIL_PROVIDER=smtp with MIB_SMTP_* to send.',
      );
    }
  });
  server.on('error', (err) => fatal(err, config.port));

  // A stop request from a process manager or Ctrl-C: stop accepting requests, stop the workers,
  // and close SQLite so the WAL is checkpointed rather than left for the next start to recover.
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}; stopping.`);
    clearInterval(worker);
    clearInterval(aiWorker);
    clearInterval(retentionWorker);
    server.close(() => {
      sqlite.close();
      process.exit(0);
    });
    // Idle keep-alive connections would otherwise hold close() open.
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

// Turns a startup failure into an explanation. The common ones have a one-line remedy, because
// the usual context is a two-process dev terminal where the web half keeps printing normally.
function fatal(err: unknown, port?: number): never {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code;
  const rule = '='.repeat(72);
  console.error(`\n${rule}\nSeaYou API failed to start.\n\n  ${message}\n`);
  if ((err as { name?: string } | null)?.name === 'ProcessLockError') {
    console.error(
      '  Stop the other process first. This API keeps its workers and limits in memory.',
    );
  } else if ((err as { name?: string } | null)?.name === 'ConfigError') {
    console.error('  The configuration is invalid, so nothing was started. See .env.example.');
  } else if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/i.test(message)) {
    console.error('  A dependency is missing. After pulling changes, run:  pnpm install');
  } else if (/NODE_MODULE_VERSION|was compiled against|better[-_]sqlite3|\.node\b/i.test(message)) {
    console.error(
      '  The SQLite native module does not match this Node version.\n' +
        '  Run:  pnpm rebuild better-sqlite3    (or delete node_modules and run pnpm install)',
    );
  } else if (code === 'EADDRINUSE') {
    console.error(
      `  Port ${port ?? '(configured)'} is already in use — another API is still running.\n` +
        '  Stop it, or start this one with a different MIB_PORT.',
    );
  }
  console.error(
    '\n  Until this is fixed the web app cannot reach the API: every request fails and\n' +
      '  sign-in reports that the server cannot be reached.\n' +
      `${rule}\n`,
  );
  process.exit(1);
}

main().catch((err: unknown) => fatal(err));
