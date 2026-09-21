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
  const { loadConfig } = await import('./config.js');
  const { createDb, runMigrations } = await import('./db/client.js');
  const { seedChart, seedUsers } = await import('./db/seed.js');
  const { createApp } = await import('./http/app.js');
  const { DevClock, SystemClock } = await import('./lib/clock.js');
  const { createMailer } = await import('./lib/mail.js');
  const { runJourneyTick } = await import('./services/journey.js');
  const { activatePublicListings } = await import('./services/risk.js');
  const { serve } = await import('@hono/node-server');
  const { assertPolicySetServeable } = await import('./services/policies.js');

  const config = loadConfig();
  // A released document set that still carries an unresolved field must never be served.
  assertPolicySetServeable();
  const { db } = createDb(config.databasePath);
  runMigrations(db);
  seedChart(db, config.defaultShoreCapacity, Date.now());
  if (config.devMode) seedUsers(db, Date.now());

  const ctx: AppContext = {
    db,
    clock: config.devMode ? new DevClock(db) : new SystemClock(),
    realClock: new SystemClock(),
    config,
    mailer: createMailer(config.mail),
  };
  // Adrift bottles listed before the 72-hour rule existed get a full 72 hours from now.
  const activated = activatePublicListings(ctx);
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

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    for (const file of loadedEnv) console.log(`Loaded environment from ${file}`);
    console.log(
      `Message in a Bottle API listening on http://localhost:${info.port} (devMode=${config.devMode}, mail=${config.mail.provider})`,
    );
    if (config.mail.provider !== 'smtp') {
      console.log(
        config.mail.provider === 'outbox'
          ? '  Mail is CAPTURED, not delivered: read it at GET /api/dev/outbox or in the app’s dev bar.'
          : '  Mail is DISABLED: nothing is delivered. Set MIB_MAIL_PROVIDER=smtp with MIB_SMTP_* to send.',
      );
    }
  });
  server.on('error', (err) => fatal(err, config.port));
}

// Turns a startup failure into an explanation. The common ones have a one-line remedy, because
// the usual context is a two-process dev terminal where the web half keeps printing normally.
function fatal(err: unknown, port?: number): never {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code;
  const rule = '='.repeat(72);
  console.error(`\n${rule}\nMessage in a Bottle API failed to start.\n\n  ${message}\n`);
  if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/i.test(message)) {
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
