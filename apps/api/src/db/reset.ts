import fs from 'node:fs';
import { loadConfig } from '../config.js';
import { createDb, runMigrations } from './client.js';
import { seedChart, seedUsers } from './seed.js';

const config = loadConfig();
if (!config.devMode) {
  console.error('db:reset is only available with MIB_DEV_MODE=true');
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
