import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import type { Clock } from '../lib/clock.js';

export interface AppContext {
  db: Db;
  clock: Clock;
  config: AppConfig;
}

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  shoreId: string | null;
}
