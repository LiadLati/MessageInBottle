import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import type { Clock } from '../lib/clock.js';
import type { Mailer } from '../lib/mail.js';

export interface AppContext {
  db: Db;
  clock: Clock;
  config: AppConfig;
  mailer: Mailer;
}

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  shoreId: string | null;
  email: string | null;
}
