import { loadConfig } from '../config.js';
import { createDb, runMigrations } from './client.js';

const config = loadConfig();
const { db } = createDb(config.databasePath);
runMigrations(db);
console.log(`Migrations applied to ${config.databasePath}`);
