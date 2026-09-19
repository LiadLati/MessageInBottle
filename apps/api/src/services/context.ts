import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import type { Clock } from '../lib/clock.js';
import type { Mailer } from '../lib/mail.js';

export interface AppContext {
  db: Db;
  // Journey clock. In development this is the dev clock, so time travel can land bottles and
  // move simulated weather. Never use it for anything security-sensitive.
  clock: Clock;
  // Real wall-clock time, always. Sessions, session expiry and password-reset tokens run on
  // this, so advancing the development clock can never sign a user out (spec §7).
  realClock: Clock;
  config: AppConfig;
  mailer: Mailer;
}

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  shoreId: string | null;
  email: string | null;
  // The zone the account's nights are counted in; null until a device has reported one.
  timeZone: string | null;
}
