import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createDb, runMigrations } from './db/client.js';
import { seedChart, seedUsers } from './db/seed.js';
import { createApp } from './http/app.js';
import { DevClock, SystemClock } from './lib/clock.js';
import type { AppContext } from './services/context.js';
import { runJourneyTick } from './services/journey.js';

const config = loadConfig();
const { db } = createDb(config.databasePath);
runMigrations(db);
seedChart(db, config.defaultShoreCapacity, Date.now());
if (config.devMode) seedUsers(db, Date.now());

const ctx: AppContext = {
  db,
  clock: config.devMode ? new DevClock(db) : new SystemClock(),
  config,
};
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

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `Message in a Bottle API listening on http://localhost:${info.port} (devMode=${config.devMode})`,
  );
});
