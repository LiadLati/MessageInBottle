// pnpm db:seed — development tooling, run from source with tsx; it is not part of the built
// artefact. Kept apart from seed.ts so that importing the seed functions never runs it.
import { loadEnvFiles } from '../lib/env.js';
import { loadConfig } from '../config.js';
import { createDb, runMigrations } from './client.js';
import { seedChart, seedUsers } from './seed.js';

loadEnvFiles();
const config = loadConfig();
const { db } = createDb(config.databasePath);
runMigrations(db);
const now = Date.now();
seedChart(db, config.defaultShoreCapacity, now);
if (config.devMode) {
  seedUsers(db, now);
  console.log(`Seeded chart and development users into ${config.databasePath}`);
} else {
  console.log(`Seeded chart into ${config.databasePath} (no users outside dev mode)`);
}
