import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  POLICY_DOCUMENTS,
  SHORE_CAPACITY,
  RISK_POLICY_VERSION,
  SUPPORT_EMAIL,
  policySetStatus,
} from '@mib/shared';
import type { PoliciesConfig } from './services/policies.js';
import { THIRTY_DAYS_MS, type RetentionPolicy } from './services/retention.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/config.ts in development, dist/<entry>.js in the built artefact: both sit one directory
// below the API root, so the migrations folder and the default .env resolve identically from
// either. Nothing here depends on the current working directory.
export const API_ROOT = path.resolve(here, '..');

// Replaced with `true` by the production build (scripts/build.mjs). Running from source under
// tsx it is undeclared, so it reads as false. The compiled artefact is therefore production by
// construction: it cannot be talked into development mode by an environment variable.
declare const __MIB_PRODUCTION_BUILD__: boolean | undefined;
export const PRODUCTION_BUILD: boolean =
  typeof __MIB_PRODUCTION_BUILD__ !== 'undefined' && __MIB_PRODUCTION_BUILD__ === true;

export type Env = Record<string, string | undefined>;

// A configuration mistake the server refuses to start with. The message is the whole report:
// it names the variable and the remedy, and never echoes a value that could be a secret.
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

// Booleans are exactly `true` or `false`. Anything else — `1`, `yes`, `TRUE `, a typo — is a
// configuration error rather than a silent guess, because a guess in either direction can be
// the dangerous one (a mistyped MIB_DEV_MODE, or a mistyped MIB_RETENTION_ENABLED).
export function envBool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ConfigError(`${name} must be exactly "true" or "false"`);
}

// Production is the compiled artefact, or NODE_ENV=production for anything run from source.
export function isProductionRuntime(env: Env, productionBuild = PRODUCTION_BUILD): boolean {
  return productionBuild || env.NODE_ENV === 'production';
}

function envDays(env: Env, name: string): number | null {
  const raw = env[name];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0)
    throw new ConfigError(`${name} must be a non-negative number of days`);
  return n * 24 * 60 * 60 * 1000;
}

// The published policy is 30 days after the decision (or until a timely appeal is decided),
// and it runs by default. MIB_RETENTION_ENABLED=false stops it removing anything (the dry-run
// plan still works), and MIB_RETENTION_DAYS shortens or lengthens the window for a staging
// environment. Neither is needed in an ordinary deployment.
function loadRetentionPolicy(env: Env): RetentionPolicy {
  return {
    enabled: envBool(env, 'MIB_RETENTION_ENABLED', true),
    afterDecisionMs: envDays(env, 'MIB_RETENTION_DAYS') ?? THIRTY_DAYS_MS,
  };
}

function envInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ConfigError(`${name} must be a number`);
  return n;
}

function envPositiveInt(env: Env, name: string, fallback: number): number {
  const n = envInt(env, name, fallback);
  if (!Number.isInteger(n) || n < 1)
    throw new ConfigError(`${name} must be a whole number of at least 1`);
  return n;
}

// 0 (no automatic outcomes for new journeys) or the one policy the worker implements. Any other
// number was silently stamped on bottles and never applied (audit ARCH-019).
function riskPolicyVersionOf(env: Env): number {
  const v = envInt(env, 'MIB_RISK_POLICY_VERSION', RISK_POLICY_VERSION);
  if (v !== 0 && v !== RISK_POLICY_VERSION)
    throw new ConfigError(`MIB_RISK_POLICY_VERSION must be 0 or ${RISK_POLICY_VERSION}`);
  return v;
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
  // Bottles one account's shore holds at once (product decision 8). Enforced per recipient.
  shoreCapacity: number;
  journeyTickMs: number;
  sessionTtlMs: number;
  corsOrigin: string;
  // Only behind a reverse proxy that sets X-Forwarded-For: otherwise clients could pick their
  // own rate-limit bucket by sending the header themselves.
  trustProxy: boolean;
  // How many trusted proxies append to X-Forwarded-For in front of the API (default 1). The
  // client address is read that many entries from the right (http/client-address.ts).
  trustedProxyHops: number;
  // Public URL of the web app, used to build links in e-mails.
  appUrl: string;
  // The published support address shown on /support and in the legal documents. A public
  // contact point, never a credential: nothing in SeaYou holds a password or token for it.
  supportEmail: string;
  mail: MailConfig;
  // Journey risk policy version applied to *new* journeys: 0 disables automatic outcomes,
  // RISK_POLICY_VERSION (3) enables the approved policy. Existing journeys keep the version
  // they were released under.
  riskPolicyVersion: number;
  // Terms, guidelines and privacy (services/policies.ts): whether the shipped set counts as
  // released. Read from the documents themselves; overridable to 'released' in development only.
  policies: PoliciesConfig;
  // Local AI review of reported letters (spec §16). The model is reached over HTTP at an
  // Ollama-compatible endpoint; nothing here is a paid API. Reports queue while it is away.
  ai: AiConfig;
  // How long moderation evidence is kept, and how often the server checks. See retention.ts.
  retention: RetentionPolicy;
  retentionTickMs: number;
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
  // There is no automatic-decision setting: the model's answer is only ever a recommendation
  // shown to an administrator (product decision 2), and MIB_AI_AUTO_DECIDE=true is refused.
}

export type MailProvider = 'outbox' | 'smtp' | 'disabled';
export interface MailConfig {
  // outbox: development-only captured messages (never allowed outside dev mode).
  // smtp: any SMTP provider. disabled: nothing is sent (request-reset still answers normally).
  provider: MailProvider;
  from: string;
  smtp: { host: string; port: number; secure: boolean; user: string; pass: string };
}

// Reads and validates the whole configuration before anything listens. Development mode is off
// unless MIB_DEV_MODE is exactly `true`, and it is refused outright in production: a forgotten
// variable must never be what turns on seeded accounts, the dev clock or /api/dev.
export function loadConfig(
  env: Env = process.env,
  options: { productionBuild?: boolean } = {},
): AppConfig {
  const production = isProductionRuntime(env, options.productionBuild ?? PRODUCTION_BUILD);
  const devMode = envBool(env, 'MIB_DEV_MODE', false);
  if (production && devMode)
    throw new ConfigError(
      'MIB_DEV_MODE=true is refused in production. Development mode enables seeded accounts ' +
        'with a published password, a movable clock and the /api/dev routes; unset it or set ' +
        'MIB_DEV_MODE=false.',
    );
  const databasePath = env.MIB_DATABASE_PATH;
  // The default path lives inside the application directory, which a redeploy replaces. A
  // production server must be told explicitly where its data lives.
  if (production && (!databasePath || !path.isAbsolute(databasePath)))
    throw new ConfigError(
      'MIB_DATABASE_PATH must be set to an absolute path in production (a file on persistent ' +
        'storage outside the application directory).',
    );
  const appUrl = env.MIB_APP_URL ?? 'http://localhost:5173';
  // Password-reset links are built from this URL, and the Privacy Policy says a production
  // deployment requires HTTPS; a production server with an http:// public URL would mail
  // plain-text links to its users (SEC-014).
  if (production && !/^https:\/\//.test(appUrl))
    throw new ConfigError(
      'MIB_APP_URL must be the public https:// address of the web app in production.',
    );
  // Automated review is recommendation-only (product decision 2): there is no automatic
  // decision path left in the code, so the old switch is refused outright rather than
  // silently ignored.
  if (envBool(env, 'MIB_AI_AUTO_DECIDE', false))
    throw new ConfigError(
      'MIB_AI_AUTO_DECIDE=true is not supported: automated review only recommends, and every ' +
        'case is decided by a person. Remove the setting.',
    );
  return {
    port: envInt(env, 'MIB_PORT', 3001),
    databasePath: databasePath || path.join(API_ROOT, 'data', 'mib.sqlite'),
    devMode,
    logRequests: envBool(env, 'MIB_LOG_REQUESTS', true),
    msPerChartUnit: envInt(env, 'MIB_MS_PER_CHART_UNIT', 60 * 60 * 1000),
    minJourneyMs: envInt(env, 'MIB_MIN_JOURNEY_MS', 6 * 60 * 60 * 1000),
    defaultShoreCapacity: envInt(env, 'MIB_DEFAULT_SHORE_CAPACITY', 5),
    shoreCapacity: envInt(env, 'MIB_SHORE_CAPACITY', SHORE_CAPACITY),
    journeyTickMs: envInt(env, 'MIB_JOURNEY_TICK_MS', 15_000),
    sessionTtlMs: envInt(env, 'MIB_SESSION_TTL_MS', 30 * 24 * 60 * 60 * 1000),
    corsOrigin: env.MIB_CORS_ORIGIN ?? 'http://localhost:5173',
    trustProxy: envBool(env, 'MIB_TRUST_PROXY', false),
    trustedProxyHops: envPositiveInt(env, 'MIB_TRUSTED_PROXY_HOPS', 1),
    appUrl,
    supportEmail: env.MIB_SUPPORT_EMAIL ?? SUPPORT_EMAIL,
    mail: loadMailConfig(env, devMode),
    // The published set is the authority; there is no environment switch that can release
    // documents that are not released in code, or hold back ones that are.
    policies: { status: policySetStatus(POLICY_DOCUMENTS) },
    riskPolicyVersion: riskPolicyVersionOf(env),
    retention: loadRetentionPolicy(env),
    // Hourly. The pass is idempotent and the window is seven days, so the exact cadence only
    // decides how soon after the boundary the evidence actually goes.
    retentionTickMs: envInt(env, 'MIB_RETENTION_TICK_MS', 60 * 60 * 1000),
    ai: {
      enabled: envBool(env, 'MIB_AI_ENABLED', true),
      endpoint: (env.MIB_AI_ENDPOINT ?? 'http://127.0.0.1:11434').replace(/\/+$/, ''),
      model: env.MIB_AI_MODEL ?? 'qwen2.5:7b',
      timeoutMs: envInt(env, 'MIB_AI_TIMEOUT_MS', 60_000),
      tickMs: envInt(env, 'MIB_AI_TICK_MS', 10_000),
    },
  };
}

function loadMailConfig(env: Env, devMode: boolean): MailConfig {
  const raw = env.MIB_MAIL_PROVIDER ?? (devMode ? 'outbox' : 'disabled');
  if (raw !== 'outbox' && raw !== 'smtp' && raw !== 'disabled')
    throw new ConfigError('MIB_MAIL_PROVIDER must be outbox, smtp or disabled');
  if (raw === 'outbox' && !devMode)
    throw new ConfigError('MIB_MAIL_PROVIDER=outbox is development-only; use smtp or disabled');
  return {
    provider: raw,
    from: env.MIB_MAIL_FROM ?? 'SeaYou <no-reply@localhost>',
    smtp: {
      host: env.MIB_SMTP_HOST ?? '',
      port: envInt(env, 'MIB_SMTP_PORT', 587),
      secure: envBool(env, 'MIB_SMTP_SECURE', false),
      user: env.MIB_SMTP_USER ?? '',
      pass: env.MIB_SMTP_PASS ?? '',
    },
  };
}

export const DISCLOSURE_VERSION = 1;
