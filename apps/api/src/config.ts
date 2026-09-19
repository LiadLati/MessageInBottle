import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RISK_POLICY_VERSION } from '@mib/shared';

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
  // Only behind a reverse proxy that sets X-Forwarded-For: otherwise clients could pick their
  // own rate-limit bucket by sending the header themselves.
  trustProxy: boolean;
  // Public URL of the web app, used to build links in e-mails.
  appUrl: string;
  mail: MailConfig;
  // Journey risk policy version applied to *new* journeys: 0 disables automatic outcomes,
  // RISK_POLICY_VERSION (3) enables the approved policy. Existing journeys keep the version
  // they were released under.
  riskPolicyVersion: number;
  // Local AI review of reported letters (spec §16). The model is reached over HTTP at an
  // Ollama-compatible endpoint; nothing here is a paid API. Reports queue while it is away.
  ai: AiConfig;
}

export interface AiConfig {
  // false: reported cases are queued but never sent to a model; admins decide everything.
  enabled: boolean;
  // Ollama-compatible base URL (POST {endpoint}/api/chat). Local by default; a cloud host later
  // is a URL change, nothing else.
  endpoint: string;
  model: string;
  timeoutMs: number;
  // How often the worker looks for queued cases.
  tickMs: number;
  // false (default): the model's verdict is a recommendation shown to admins. true: a clear
  // `accept` or `reject` decides the case itself; `uncertain` always goes to an admin. Enable
  // only after running `pnpm --filter @mib/api ai:eval` against your own model.
  autoDecide: boolean;
}

export type MailProvider = 'outbox' | 'smtp' | 'disabled';
export interface MailConfig {
  // outbox: development-only captured messages (never allowed outside dev mode).
  // smtp: any SMTP provider. disabled: nothing is sent (request-reset still answers normally).
  provider: MailProvider;
  from: string;
  smtp: { host: string; port: number; secure: boolean; user: string; pass: string };
}

export function loadConfig(): AppConfig {
  const devMode = (process.env.MIB_DEV_MODE ?? 'true') === 'true';
  return {
    port: envInt('MIB_PORT', 3001),
    databasePath: process.env.MIB_DATABASE_PATH ?? path.join(API_ROOT, 'data', 'mib.sqlite'),
    devMode,
    logRequests: (process.env.MIB_LOG_REQUESTS ?? 'true') === 'true',
    msPerChartUnit: envInt('MIB_MS_PER_CHART_UNIT', 60 * 60 * 1000),
    minJourneyMs: envInt('MIB_MIN_JOURNEY_MS', 6 * 60 * 60 * 1000),
    defaultShoreCapacity: envInt('MIB_DEFAULT_SHORE_CAPACITY', 5),
    journeyTickMs: envInt('MIB_JOURNEY_TICK_MS', 15_000),
    sessionTtlMs: envInt('MIB_SESSION_TTL_MS', 30 * 24 * 60 * 60 * 1000),
    corsOrigin: process.env.MIB_CORS_ORIGIN ?? 'http://localhost:5173',
    trustProxy: (process.env.MIB_TRUST_PROXY ?? 'false') === 'true',
    appUrl: process.env.MIB_APP_URL ?? 'http://localhost:5173',
    mail: loadMailConfig(devMode),
    riskPolicyVersion: envInt('MIB_RISK_POLICY_VERSION', RISK_POLICY_VERSION),
    ai: {
      enabled: (process.env.MIB_AI_ENABLED ?? 'true') === 'true',
      endpoint: (process.env.MIB_AI_ENDPOINT ?? 'http://127.0.0.1:11434').replace(/\/+$/, ''),
      model: process.env.MIB_AI_MODEL ?? 'qwen2.5:7b',
      timeoutMs: envInt('MIB_AI_TIMEOUT_MS', 60_000),
      tickMs: envInt('MIB_AI_TICK_MS', 10_000),
      autoDecide: (process.env.MIB_AI_AUTO_DECIDE ?? 'false') === 'true',
    },
  };
}

function loadMailConfig(devMode: boolean): MailConfig {
  const raw = process.env.MIB_MAIL_PROVIDER ?? (devMode ? 'outbox' : 'disabled');
  if (raw !== 'outbox' && raw !== 'smtp' && raw !== 'disabled')
    throw new Error('MIB_MAIL_PROVIDER must be outbox, smtp or disabled');
  if (raw === 'outbox' && !devMode)
    throw new Error('MIB_MAIL_PROVIDER=outbox is development-only; use smtp or disabled');
  return {
    provider: raw,
    from: process.env.MIB_MAIL_FROM ?? 'Message in a Bottle <no-reply@localhost>',
    smtp: {
      host: process.env.MIB_SMTP_HOST ?? '',
      port: envInt('MIB_SMTP_PORT', 587),
      secure: (process.env.MIB_SMTP_SECURE ?? 'false') === 'true',
      user: process.env.MIB_SMTP_USER ?? '',
      pass: process.env.MIB_SMTP_PASS ?? '',
    },
  };
}

export const DISCLOSURE_VERSION = 1;
