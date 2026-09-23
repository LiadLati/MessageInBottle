import { loadEnvFiles } from '../lib/env.js';
import { loadConfig } from '../config.js';
import { createDb, runMigrations } from './client.js';

// The same .env files the API reads, so MIB_DEV_MODE and MIB_DATABASE_PATH mean the same here.
loadEnvFiles();
const config = loadConfig();
const { db } = createDb(config.databasePath);
runMigrations(db);
console.log(`Migrations applied to ${config.databasePath}`);
