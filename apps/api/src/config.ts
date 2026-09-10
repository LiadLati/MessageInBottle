import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const API_ROOT = path.resolve(here, '..');

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

export interface AppConfig {
  port: number;
  databasePath: string;
  devMode: boolean;
  logRequests: boolean;
  // D01 is open: travel duration is derived from route length with this configurable rate.
  msPerChartUnit: number;
  minJourneyMs: number;
  // D06 is open: default per-shore slot count for the slice.
  defaultShoreCapacity: number;
  journeyTickMs: number;
  sessionTtlMs: number;
  corsOrigin: string;
}

export function loadConfig(): AppConfig {
  return {
    port: envInt('MIB_PORT', 3001),
    databasePath: process.env.MIB_DATABASE_PATH ?? path.join(API_ROOT, 'data', 'mib.sqlite'),
    devMode: (process.env.MIB_DEV_MODE ?? 'true') === 'true',
    logRequests: (process.env.MIB_LOG_REQUESTS ?? 'true') === 'true',
    msPerChartUnit: envInt('MIB_MS_PER_CHART_UNIT', 60 * 60 * 1000),
    minJourneyMs: envInt('MIB_MIN_JOURNEY_MS', 6 * 60 * 60 * 1000),
    defaultShoreCapacity: envInt('MIB_DEFAULT_SHORE_CAPACITY', 5),
    journeyTickMs: envInt('MIB_JOURNEY_TICK_MS', 15_000),
    sessionTtlMs: envInt('MIB_SESSION_TTL_MS', 30 * 24 * 60 * 60 * 1000),
    corsOrigin: process.env.MIB_CORS_ORIGIN ?? 'http://localhost:5173',
  };
}

export const DISCLOSURE_VERSION = 1;
