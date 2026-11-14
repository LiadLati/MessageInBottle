import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ANDROID_APP_ORIGIN,
  ConfigError,
  corsOriginsOf,
  PRODUCTION_BUILD,
  envBool,
  isProductionRuntime,
  loadConfig,
  requireAiDecision,
} from './config.js';

// Audit finding DEPLOY-001 (ARCH-001 / SEC-001 / QA-002): development mode used to be the
// default, so a deployment that forgot one variable shipped seeded accounts with a published
// password and an unauthenticated mail outbox full of password-reset links. These tests pin the
// fail-closed replacement. Each builds its environment from scratch — never process.env.
const PROD_DB = path.resolve('/var/lib/seayou/seayou.sqlite');
const PROD_URL = 'https://seayou.example';

describe('development mode is off unless explicitly enabled', () => {
  it('treats a missing MIB_DEV_MODE as safe mode', () => {
    const config = loadConfig({});
    expect(config.devMode).toBe(false);
    expect(config.mail.provider).toBe('disabled');
  });

  it('treats an empty MIB_DEV_MODE as safe mode', () => {
    expect(loadConfig({ MIB_DEV_MODE: '' }).devMode).toBe(false);
  });

  it('honours an explicit MIB_DEV_MODE=false', () => {
    expect(loadConfig({ MIB_DEV_MODE: 'false' }).devMode).toBe(false);
  });

  it('enables development mode only for the exact value true, outside production', () => {
    const config = loadConfig({ MIB_DEV_MODE: 'true' });
    expect(config.devMode).toBe(true);
    expect(config.mail.provider).toBe('outbox');
  });

  it.each(['1', 'yes', 'on', 'TRUE', 'True', ' true', 'true ', 'enabled', '0', 'no'])(
    'rejects the invalid value %j instead of guessing',
    (value) => {
      expect(() => loadConfig({ MIB_DEV_MODE: value })).toThrow(ConfigError);
      expect(() => loadConfig({ MIB_DEV_MODE: value })).toThrow(/MIB_DEV_MODE must be exactly/);
    },
  );

  it('applies the same strict rule to every boolean setting', () => {
    for (const name of [
      'MIB_TRUST_PROXY',
      'MIB_LOG_REQUESTS',
      'MIB_AI_ENABLED',
      'MIB_AI_AUTO_DECIDE',
      'MIB_RETENTION_ENABLED',
      'MIB_SMTP_SECURE',
    ])
      expect(() => loadConfig({ [name]: 'yes' }), name).toThrow(ConfigError);
    expect(envBool({}, 'X', true)).toBe(true);
    expect(envBool({ X: 'false' }, 'X', true)).toBe(false);
  });

  it('refuses the development outbox whenever development mode is off', () => {
    expect(() => loadConfig({ MIB_MAIL_PROVIDER: 'outbox' })).toThrow(/development-only/);
  });
});

describe('production fails closed', () => {
  it('knows it is running from source here, not from the compiled artefact', () => {
    expect(PRODUCTION_BUILD).toBe(false);
    expect(isProductionRuntime({})).toBe(false);
    expect(isProductionRuntime({ NODE_ENV: 'production' })).toBe(true);
    expect(isProductionRuntime({}, true)).toBe(true);
  });

  it('refuses MIB_DEV_MODE=true with NODE_ENV=production', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', MIB_DEV_MODE: 'true', MIB_DATABASE_PATH: PROD_DB }),
    ).toThrow(/MIB_DEV_MODE=true is refused in production/);
  });

  it('refuses MIB_DEV_MODE=true in the compiled artefact whatever NODE_ENV says', () => {
    expect(() =>
      loadConfig({ MIB_DEV_MODE: 'true', MIB_DATABASE_PATH: PROD_DB }, { productionBuild: true }),
    ).toThrow(/refused in production/);
  });

  it('requires an explicit absolute database path in production', () => {
    expect(() => loadConfig({}, { productionBuild: true })).toThrow(/MIB_DATABASE_PATH/);
    expect(() =>
      loadConfig({ MIB_DATABASE_PATH: 'data/mib.sqlite' }, { productionBuild: true }),
    ).toThrow(/absolute path/);
  });

  it('starts in safe mode with a minimal production environment', () => {
    const config = loadConfig(
      { MIB_DATABASE_PATH: PROD_DB, MIB_APP_URL: PROD_URL },
      { productionBuild: true },
    );
    expect(config.devMode).toBe(false);
    expect(config.databasePath).toBe(PROD_DB);
    expect(config.mail.provider).toBe('disabled');
  });

  it('requires an https public URL in production', () => {
    expect(() => loadConfig({ MIB_DATABASE_PATH: PROD_DB }, { productionBuild: true })).toThrow(
      /MIB_APP_URL must be the public https/,
    );
    expect(() =>
      loadConfig(
        { MIB_DATABASE_PATH: PROD_DB, MIB_APP_URL: 'http://seayou.example' },
        { productionBuild: true },
      ),
    ).toThrow(/https/);
    // Development keeps its http default.
    expect(loadConfig({}).appUrl).toBe('http://localhost:5173');
  });

  it('reads the trusted proxy hop count as a whole number of at least 1', () => {
    expect(loadConfig({}).trustedProxyHops).toBe(1);
    expect(loadConfig({ MIB_TRUSTED_PROXY_HOPS: '2' }).trustedProxyHops).toBe(2);
    for (const bad of ['0', '-1', '1.5', 'two'])
      expect(() => loadConfig({ MIB_TRUSTED_PROXY_HOPS: bad }), bad).toThrow(ConfigError);
  });

  it('refuses the development outbox in production', () => {
    expect(() =>
      loadConfig(
        { MIB_DATABASE_PATH: PROD_DB, MIB_APP_URL: PROD_URL, MIB_MAIL_PROVIDER: 'outbox' },
        { productionBuild: true },
      ),
    ).toThrow(/development-only/);
  });

  it('never echoes a configured value in its error', () => {
    try {
      loadConfig({ MIB_SMTP_SECURE: 'hunter2-not-a-boolean' });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain('hunter2');
    }
  });
});

describe('browser-engine origins allowed to call the API (MIB_CORS_ORIGIN)', () => {
  const prod = { NODE_ENV: 'production', MIB_DATABASE_PATH: PROD_DB, MIB_APP_URL: PROD_URL };

  it('defaults to the Android app in production and the Vite dev server otherwise', () => {
    expect(loadConfig(prod, { productionBuild: true }).corsOrigin).toEqual([ANDROID_APP_ORIGIN]);
    expect(ANDROID_APP_ORIGIN).toBe('https://localhost');
    expect(loadConfig({}).corsOrigin).toEqual(['http://localhost:5173']);
  });

  it('accepts a comma-separated list of origins', () => {
    expect(corsOriginsOf('https://localhost, http://localhost:5173/', false)).toEqual([
      'https://localhost',
      'http://localhost:5173',
    ]);
    expect(
      loadConfig({ ...prod, MIB_CORS_ORIGIN: 'https://localhost' }, { productionBuild: true })
        .corsOrigin,
    ).toEqual(['https://localhost']);
  });

  it('refuses http, paths and wildcards in production, and anything that is not an origin', () => {
    expect(() => corsOriginsOf('http://localhost:5173', true)).toThrow(ConfigError);
    expect(() => corsOriginsOf('*', true)).toThrow(ConfigError);
    expect(() => corsOriginsOf('https://localhost/app', false)).toThrow(ConfigError);
    expect(() => corsOriginsOf('localhost', false)).toThrow(ConfigError);
    expect(() => corsOriginsOf(' , ', false)).toThrow(ConfigError);
    expect(corsOriginsOf('*', false)).toBe('*');
  });
});

// Re-audit ARCH-R-011, ARCH-R-004, SEC-R-011 and SEC-R-015.
describe('numeric settings are range-checked (ARCH-R-011)', () => {
  it('refuses out-of-range, fractional and nonsensical values and names the range', () => {
    const bad: Array<[string, string]> = [
      ['MIB_PORT', '0'],
      ['MIB_PORT', '70000'],
      ['MIB_PORT', '3000.5'],
      ['MIB_JOURNEY_TICK_MS', '-1'],
      ['MIB_JOURNEY_TICK_MS', '0'],
      ['MIB_SESSION_TTL_MS', '0'],
      ['MIB_SHORE_CAPACITY', '0'],
      ['MIB_DEFAULT_SHORE_CAPACITY', '-3'],
      ['MIB_MS_PER_CHART_UNIT', '0'],
      ['MIB_MIN_JOURNEY_MS', '-5'],
      ['MIB_RETENTION_TICK_MS', '5'],
      ['MIB_AI_TIMEOUT_MS', '0'],
      ['MIB_AI_TICK_MS', '1e12'],
      ['MIB_SMTP_PORT', '0'],
    ];
    for (const [name, value] of bad) {
      expect(() => loadConfig({ [name]: value }), `${name}=${value}`).toThrow(ConfigError);
      expect(() => loadConfig({ [name]: value }), `${name}=${value}`).toThrow(
        new RegExp(`${name} must be a whole number from`),
      );
    }
  });

  it('accepts sensible values', () => {
    const c = loadConfig({
      MIB_PORT: '8080',
      MIB_JOURNEY_TICK_MS: '5000',
      MIB_MIN_JOURNEY_MS: '0',
      MIB_SHORE_CAPACITY: '30',
    });
    expect([c.port, c.journeyTickMs, c.minJourneyMs, c.shoreCapacity]).toEqual([8080, 5000, 0, 30]);
  });
});

describe('the listening interface (ARCH-R-004)', () => {
  it('is loopback in production unless MIB_HOST says otherwise', () => {
    const prod = { MIB_DATABASE_PATH: PROD_DB, MIB_APP_URL: PROD_URL };
    expect(loadConfig(prod, { productionBuild: true }).host).toBe('127.0.0.1');
    expect(loadConfig({ ...prod, MIB_HOST: '0.0.0.0' }, { productionBuild: true }).host).toBe(
      '0.0.0.0',
    );
    expect(() => loadConfig({ ...prod, MIB_HOST: 'http://x/' }, { productionBuild: true })).toThrow(
      /MIB_HOST/,
    );
  });

  it('is every interface in development, so a device on the LAN can reach it', () => {
    expect(loadConfig({}).host).toBeUndefined();
    expect(loadConfig({ MIB_HOST: '127.0.0.1' }).host).toBe('127.0.0.1');
  });
});

describe('SMTP transport security (SEC-R-011)', () => {
  it('requires STARTTLS by default and refuses switching it off outside development', () => {
    expect(loadConfig({}).mail.smtp.requireTls).toBe(true);
    expect(() => loadConfig({ MIB_SMTP_REQUIRE_TLS: 'false' })).toThrow(/development-only/);
    expect(
      loadConfig({ MIB_DEV_MODE: 'true', MIB_SMTP_REQUIRE_TLS: 'false' }).mail.smtp.requireTls,
    ).toBe(false);
  });

  it('refuses a port and TLS mode that cannot work together', () => {
    expect(() => loadConfig({ MIB_SMTP_PORT: '465' })).toThrow(/MIB_SMTP_SECURE=true/);
    expect(() => loadConfig({ MIB_SMTP_PORT: '587', MIB_SMTP_SECURE: 'true' })).toThrow(
      /MIB_SMTP_SECURE=false/,
    );
    const gmail = loadConfig({ MIB_SMTP_PORT: '465', MIB_SMTP_SECURE: 'true' }).mail.smtp;
    expect([gmail.port, gmail.secure]).toEqual([465, true]);
  });
});

describe('automated review settings (SEC-R-015)', () => {
  const prod = { MIB_DATABASE_PATH: PROD_DB, MIB_APP_URL: PROD_URL };

  it('must be written down in production, either way', () => {
    const unset = loadConfig(prod, { productionBuild: true });
    expect(unset.ai.enabled).toBe(false);
    expect(() => requireAiDecision(unset, true)).toThrow(/MIB_AI_ENABLED must be set/);
    for (const value of ['true', 'false']) {
      const set = loadConfig({ ...prod, MIB_AI_ENABLED: value }, { productionBuild: true });
      expect(set.ai.enabled).toBe(value === 'true');
      expect(() => requireAiDecision(set, true)).not.toThrow();
    }
  });

  it('keeps the development default and needs no decision there', () => {
    const dev = loadConfig({});
    expect(dev.ai.enabled).toBe(true);
    expect(() => requireAiDecision(dev, false)).not.toThrow();
  });

  it('sends letters over plain http only to this machine', () => {
    for (const ok of [
      'http://127.0.0.1:11434',
      'http://localhost:11434/',
      'http://[::1]:11434',
      'https://models.example.org',
    ])
      expect(() => loadConfig({ MIB_AI_ENDPOINT: ok }), ok).not.toThrow();
    for (const bad of ['http://10.0.0.5:11434', 'http://models.example.org', 'ftp://x', 'nope'])
      expect(() => loadConfig({ MIB_AI_ENDPOINT: bad }), bad).toThrow(/MIB_AI_ENDPOINT/);
    // Not checked when review is off: nothing is ever sent.
    expect(() =>
      loadConfig({ MIB_AI_ENABLED: 'false', MIB_AI_ENDPOINT: 'http://10.0.0.5:11434' }),
    ).not.toThrow();
  });
});

describe('operator tools (ARCH-R-012)', () => {
  it('run in production without the public web address only the server needs', () => {
    const env = { MIB_DATABASE_PATH: PROD_DB };
    expect(() => loadConfig(env, { productionBuild: true })).toThrow(/MIB_APP_URL/);
    expect(() => loadConfig(env, { productionBuild: true, forTool: true })).not.toThrow();
    // Everything else still applies to them.
    expect(() => loadConfig({}, { productionBuild: true, forTool: true })).toThrow(
      /MIB_DATABASE_PATH/,
    );
    expect(() =>
      loadConfig({ ...env, MIB_DEV_MODE: 'true' }, { productionBuild: true, forTool: true }),
    ).toThrow(/MIB_DEV_MODE/);
  });
});
