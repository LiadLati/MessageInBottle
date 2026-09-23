import fs from 'node:fs';
import { loadEnvFiles } from '../lib/env.js';
import { loadConfig } from '../config.js';
import { createDb, runMigrations } from './client.js';
import { seedChart, seedUsers } from './seed.js';

// The same .env files the API reads, so MIB_DEV_MODE and MIB_DATABASE_PATH mean the same here.
loadEnvFiles();
const config = loadConfig();
if (!config.devMode) {
  console.error(
    'db:reset deletes the database, so it runs only with MIB_DEV_MODE=true (set in apps/api/.env or the root .env) and never in production.',
  );
  process.exit(1);
}
for (const suffix of ['', '-wal', '-shm', '-journal']) {
  fs.rmSync(config.databasePath + suffix, { force: true });
}
const { db } = createDb(config.databasePath);
runMigrations(db);
const now = Date.now();
seedChart(db, config.defaultShoreCapacity, now);
seedUsers(db, now);
console.log(`Reset and seeded ${config.databasePath}`);
