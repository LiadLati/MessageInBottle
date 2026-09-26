import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  PRODUCTION_BUILD,
  envBool,
  isProductionRuntime,
  loadConfig,
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
