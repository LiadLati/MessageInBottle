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

// A whole number within a sensible range (audit ARCH-R-011). Every numeric setting goes through
// this: a negative tick, a zero session lifetime or a port of 70000 is a refused start, not a
// server that misbehaves later. The message names the range, never the value.
function envIntIn(env: Env, name: string, fallback: number, min: number, max: number): number {
  const n = envInt(env, name, fallback);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new ConfigError(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Where the API listens (audit ARCH-R-004). The deployment contract puts it behind a reverse
// proxy on the same host with MIB_TRUST_PROXY=true, so in production it listens on the loopback
// interface unless told otherwise: a directly reachable API would let any client choose its
// rate-limit address through X-Forwarded-For. A container deployment, where the proxy reaches
// the API over a container network, sets MIB_HOST=0.0.0.0 and must keep the port unpublished.
// Development keeps listening on every interface, so a phone or emulator on the LAN can reach it.
function hostOf(env: Env, production: boolean): string | undefined {
  const raw = env.MIB_HOST;
  if (raw === undefined || raw === '') return production ? '127.0.0.1' : undefined;
  if (!/^[A-Za-z0-9.:-]+$/.test(raw))
    throw new ConfigError('MIB_HOST must be a host name or an IP address such as 127.0.0.1');
  return raw;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// The review model receives the full text of reported letters. Over plain http it may only be
// reached on this machine; anything else must be https (audit SEC-R-015).
function aiEndpointOf(env: Env): string {
  const raw = (env.MIB_AI_ENDPOINT ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('MIB_AI_ENDPOINT must be an http(s) URL');
  }
  if (url.protocol === 'https:') return raw;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return raw;
  throw new ConfigError(
    'MIB_AI_ENDPOINT must use https://, or http:// only on this machine (localhost, 127.0.0.1 ' +
      'or ::1): reported letters are sent to it.',
  );
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
  // The interface the API listens on. Undefined: every interface (development only).
  host: string | undefined;
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
  // Origins allowed to call /api from a browser engine: the Android app's WebView origin
  // (https://localhost) in production, plus the Vite dev server in development. A list, from
  // MIB_CORS_ORIGIN separated by commas; '*' only outside production.
  corsOrigin: string | string[];
  // Only behind a reverse proxy that sets X-Forwarded-For: otherwise clients could pick their
  // own rate-limit bucket by sending the header themselves.
  trustProxy: boolean;
  // How many trusted proxies append to X-Forwarded-For in front of the API (default 1). The
  // client address is read that many entries from the right (http/client-address.ts).
  trustedProxyHops: number;
  // Public https:// origin of this server, used to build the password-reset link in e-mails,
  // which opens the server's own /reset-password page (the interface itself is in the app).
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
  // Whether MIB_AI_ENABLED was set at all (production requires it; see requireAiDecision).
  explicit: boolean;
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
  smtp: {
    host: string;
    port: number;
    // Implicit TLS from the first byte (port 465).
    secure: boolean;
    // Without implicit TLS, refuse to send unless the server upgrades with STARTTLS, so the
    // password and the reset links never cross the network in clear (audit SEC-R-011).
    requireTls: boolean;
    user: string;
    pass: string;
  };
}

// The origin Capacitor serves the bundled interface from inside the Android app.
export const ANDROID_APP_ORIGIN = 'https://localhost';

// MIB_CORS_ORIGIN: one origin or several separated by commas. Each must be an origin (scheme,
// host and optional port, nothing else). In production each must be https — the Android app's
// WebView origin, https://localhost, is — and '*' is refused, because a wildcard would let any
// web page script the API with a token it had obtained.
export function corsOriginsOf(raw: string, production: boolean): string | string[] {
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) throw new ConfigError('MIB_CORS_ORIGIN is empty.');
  if (items.includes('*')) {
    if (production || items.length > 1)
      throw new ConfigError("MIB_CORS_ORIGIN='*' is refused in production and cannot be combined.");
    return '*';
  }
  for (const item of items) {
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      throw new ConfigError(`MIB_CORS_ORIGIN entry is not an origin: ${item}`);
    }
    if (url.origin !== item.replace(/\/$/, ''))
      throw new ConfigError(`MIB_CORS_ORIGIN entry must be an origin only: ${item}`);
    if (production && url.protocol !== 'https:')
      throw new ConfigError(`MIB_CORS_ORIGIN must use https:// in production: ${item}`);
  }
  return items.map((i) => i.replace(/\/$/, ''));
}

// Reads and validates the whole configuration before anything listens. Development mode is off
// unless MIB_DEV_MODE is exactly `true`, and it is refused outright in production: a forgotten
// variable must never be what turns on seeded accounts, the dev clock or /api/dev.
//
// `forTool` is for the operator command-line tools (migrate, backup, grant, retention, audit
// export, deletion backfill). They build no links and send no mail, so they do not require the
// public MIB_APP_URL that only the server needs (audit ARCH-R-012); every other check applies.
export function loadConfig(
  env: Env = process.env,
  options: { productionBuild?: boolean; forTool?: boolean } = {},
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
  // By default the browser engine allowed to call the API is the Android app's WebView
  // (https://localhost) in production and the Vite dev server in development.
  const corsOrigin = corsOriginsOf(
    env.MIB_CORS_ORIGIN ?? (production ? ANDROID_APP_ORIGIN : 'http://localhost:5173'),
    production,
  );
  // Password-reset links are built from this URL, and the Privacy Policy says a production
  // deployment requires HTTPS; a production server with an http:// public URL would mail
  // plain-text links to its users (SEC-014).
  if (production && !options.forTool && !/^https:\/\//.test(appUrl))
    throw new ConfigError(
      'MIB_APP_URL must be the public https:// address of this server in production.',
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
    port: envIntIn(env, 'MIB_PORT', 3001, 1, 65_535),
    host: hostOf(env, production),
    databasePath: databasePath || path.join(API_ROOT, 'data', 'mib.sqlite'),
    devMode,
    logRequests: envBool(env, 'MIB_LOG_REQUESTS', true),
    msPerChartUnit: envIntIn(env, 'MIB_MS_PER_CHART_UNIT', HOUR, 1, 7 * DAY),
    minJourneyMs: envIntIn(env, 'MIB_MIN_JOURNEY_MS', 6 * HOUR, 0, 365 * DAY),
    defaultShoreCapacity: envIntIn(env, 'MIB_DEFAULT_SHORE_CAPACITY', 5, 1, 10_000),
    shoreCapacity: envIntIn(env, 'MIB_SHORE_CAPACITY', SHORE_CAPACITY, 1, 10_000),
    journeyTickMs: envIntIn(env, 'MIB_JOURNEY_TICK_MS', 15 * SECOND, 100, HOUR),
    sessionTtlMs: envIntIn(env, 'MIB_SESSION_TTL_MS', 30 * DAY, MINUTE, 365 * DAY),
    corsOrigin,
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
    // Hourly. The pass is idempotent and the window is 30 days, so the exact cadence only
    // decides how soon after the boundary the evidence actually goes.
    retentionTickMs: envIntIn(env, 'MIB_RETENTION_TICK_MS', HOUR, SECOND, DAY),
    ai: loadAiConfig(env, production),
  };
}

// Automated review stays on by default in development. In production the setting must be
// written down (audit SEC-R-015): whether a model reads reported letters is an operator's
// decision, so an unset MIB_AI_ENABLED stops the server rather than being guessed either way.
// Command-line tools never review anything, so they accept it unset (`requireAiDecision`).
function loadAiConfig(env: Env, production: boolean): AiConfig {
  const explicit = env.MIB_AI_ENABLED !== undefined && env.MIB_AI_ENABLED !== '';
  const enabled = envBool(env, 'MIB_AI_ENABLED', !production);
  return {
    enabled,
    explicit,
    endpoint: enabled ? aiEndpointOf(env) : (env.MIB_AI_ENDPOINT ?? '').replace(/\/+$/, ''),
    model: env.MIB_AI_MODEL ?? 'qwen2.5:7b',
    timeoutMs: envIntIn(env, 'MIB_AI_TIMEOUT_MS', MINUTE, SECOND, 10 * MINUTE),
    tickMs: envIntIn(env, 'MIB_AI_TICK_MS', 10 * SECOND, 100, HOUR),
  };
}

// The server's own start check. See loadAiConfig.
export function requireAiDecision(config: AppConfig, production: boolean): void {
  if (production && !config.ai.explicit)
    throw new ConfigError(
      'MIB_AI_ENABLED must be set to true or false in production. true sends reported letters ' +
        'to the review model at MIB_AI_ENDPOINT for a recommendation; false leaves every report ' +
        'to an administrator alone. See docs/DEPLOYMENT.md.',
    );
}

function loadMailConfig(env: Env, devMode: boolean): MailConfig {
  const raw = env.MIB_MAIL_PROVIDER ?? (devMode ? 'outbox' : 'disabled');
  if (raw !== 'outbox' && raw !== 'smtp' && raw !== 'disabled')
    throw new ConfigError('MIB_MAIL_PROVIDER must be outbox, smtp or disabled');
  if (raw === 'outbox' && !devMode)
    throw new ConfigError('MIB_MAIL_PROVIDER=outbox is development-only; use smtp or disabled');
  const port = envIntIn(env, 'MIB_SMTP_PORT', 587, 1, 65_535);
  const secure = envBool(env, 'MIB_SMTP_SECURE', false);
  // The two standard submission ports each have one TLS mode; the other one hangs or fails
  // with an unhelpful error on the first reset e-mail, long after startup.
  if (port === 465 && !secure)
    throw new ConfigError('MIB_SMTP_PORT=465 uses implicit TLS: set MIB_SMTP_SECURE=true');
  if (port === 587 && secure)
    throw new ConfigError('MIB_SMTP_PORT=587 upgrades with STARTTLS: set MIB_SMTP_SECURE=false');
  const requireTls = envBool(env, 'MIB_SMTP_REQUIRE_TLS', true);
  if (!requireTls && !devMode)
    throw new ConfigError(
      'MIB_SMTP_REQUIRE_TLS=false is development-only: outside it, mail is sent over TLS or not at all',
    );
  return {
    provider: raw,
    from: env.MIB_MAIL_FROM ?? 'SeaYou <no-reply@localhost>',
    smtp: {
      host: env.MIB_SMTP_HOST ?? '',
      port,
      secure,
      requireTls,
      user: env.MIB_SMTP_USER ?? '',
      pass: env.MIB_SMTP_PASS ?? '',
    },
  };
}

export const DISCLOSURE_VERSION = 1;
