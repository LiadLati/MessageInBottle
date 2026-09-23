// Production-artefact smoke test. Starts the *compiled* API (`node dist/server.js`), never the
// TypeScript source, against a fresh temporary database, and checks that it is safe by default.
//
//   node apps/api/scripts/smoke-artefact.mjs [--artefact <dir>] [--prod-only]
//
// --artefact  directory holding package.json, dist/ and drizzle/ (default: apps/api). Pass the
//             output of `pnpm --filter @mib/api deploy --prod <dir>` to test what ships.
// --prod-only additionally assert that no TypeScript runtime (tsx, ts-node) is installed there.
//
// The environment handed to the server is built from scratch: nothing from the caller's shell,
// no .env values, no secrets. It never touches apps/api/data/mib.sqlite.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const artefact = path.resolve(option('artefact', path.resolve(here, '..')));
const prodOnly = flag('prod-only');
const port = Number(option('port', 3900 + Math.floor(Math.random() * 90)));
const base = `http://127.0.0.1:${port}`;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
};

// The seeded development accounts, read from the source so this test tracks the real seed.
// The password is used only to prove that it does NOT work; it is never printed.
const seedSource = fs.readFileSync(path.resolve(here, '../src/db/seed-data.ts'), 'utf8');
const seedPassword = /DEV_SEED_PASSWORD\s*=\s*'([^']+)'/.exec(seedSource)?.[1];
const seedUsers = [
  ...seedSource.slice(seedSource.indexOf('SEED_USERS')).matchAll(/username:\s*'([a-z0-9_]+)'/g),
].map((m) => m[1]);
if (!seedPassword || seedUsers.length === 0) throw new Error('could not read the seed accounts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seayou-smoke-'));
const databasePath = path.join(tmp, 'smoke.sqlite');
const env = {
  PATH: process.env.PATH,
  HOME: tmp,
  MIB_DATABASE_PATH: databasePath,
  MIB_PORT: String(port),
  // Production requires an https public URL; nothing is ever sent to it here.
  MIB_APP_URL: 'https://seayou.example',
  MIB_AI_ENABLED: 'false',
  MIB_LOG_REQUESTS: 'false',
};
const node = process.execPath;
const dist = (file) => path.join(artefact, 'dist', file);

console.log(`Artefact: ${artefact}\nTemporary database: ${databasePath}\n`);

// 1. What is installed.
check('compiled server exists', fs.existsSync(dist('server.js')));
check(
  'no source maps shipped',
  !fs.readdirSync(path.join(artefact, 'dist')).some((f) => f.endsWith('.map')),
);
if (prodOnly) {
  const req = createRequire(path.join(artefact, 'package.json'));
  for (const runtime of ['tsx', 'ts-node', 'typescript']) {
    let found = true;
    try {
      req.resolve(`${runtime}/package.json`);
    } catch {
      found = false;
    }
    check(`${runtime} is not installed in the artefact`, !found);
  }
  check('no TypeScript source in the artefact', !fs.existsSync(path.join(artefact, 'src')));
  check('no .env in the artefact', !fs.existsSync(path.join(artefact, '.env')));
  check('no database in the artefact', !fs.existsSync(path.join(artefact, 'data')));
}

// 2. Fail closed: development mode is refused by the production artefact.
const refused = spawnSync(node, [dist('server.js')], {
  cwd: tmp,
  env: { ...env, MIB_DEV_MODE: 'true' },
  encoding: 'utf8',
  timeout: 20_000,
});
check(
  'MIB_DEV_MODE=true is refused at startup',
  refused.status !== 0 && /MIB_DEV_MODE=true is refused in production/.test(refused.stderr),
  `exit ${refused.status}`,
);
const relative = spawnSync(node, [dist('server.js')], {
  cwd: tmp,
  env: { ...env, MIB_DATABASE_PATH: 'relative.sqlite' },
  encoding: 'utf8',
  timeout: 20_000,
});
check('a relative MIB_DATABASE_PATH is refused', relative.status !== 0, `exit ${relative.status}`);

// 3. Fresh migration with the compiled migrator.
const migrated = spawnSync(node, [dist('migrate.js')], { cwd: tmp, env, encoding: 'utf8' });
check('fresh migration (node dist/migrate.js)', migrated.status === 0, migrated.stderr.trim());
const backupFile = path.join(tmp, 'backups', 'smoke-backup.sqlite');
const backedUp = spawnSync(node, [dist('backup.js'), '--to', backupFile], {
  cwd: tmp,
  env,
  encoding: 'utf8',
});
check(
  'online backup of the fresh database (node dist/backup.js)',
  backedUp.status === 0 && /"integrity": "ok"/.test(backedUp.stdout),
  backedUp.stderr.trim(),
);
check('migration wrote the temporary database', fs.existsSync(databasePath));

// 4. Start the compiled server. The working directory is the temp dir on purpose: nothing may
// depend on being started from the repository.
const server = spawn(node, [dist('server.js')], {
  cwd: tmp,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', (d) => (output += d));
server.stderr.on('data', (d) => (output += d));
const exited = new Promise((resolve) =>
  server.on('exit', (code, signal) => resolve({ code, signal })),
);

async function waitForHealth() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return r;
    } catch {
      // not listening yet
    }
    if (server.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

const call = async (method, url, { token, body } = {}) => {
  const r = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // HTML pages
  }
  return { status: r.status, json, text };
};

try {
  const health = await waitForHealth();
  check('server starts and /api/health answers', !!health, health ? '' : output.trim());
  if (!health) throw new Error('server did not start');
  const h = await health.json();
  check(
    'health reports ok and no development details',
    h.ok === true && !('devMode' in h) && !('mail' in h),
  );
  check('startup log says devMode=false', /devMode=false/.test(output));
  check(
    'security headers are set (frame, sniffing, CSP, HSTS)',
    health.headers.get('x-frame-options') === 'DENY' &&
      health.headers.get('x-content-type-options') === 'nosniff' &&
      /default-src 'none'/.test(health.headers.get('content-security-policy') ?? '') &&
      /max-age=/.test(health.headers.get('strict-transport-security') ?? ''),
  );
  const big = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'x', password: 'x'.repeat(70_000) }),
  });
  check('an oversized request body is refused (413)', big.status === 413, String(big.status));

  for (const page of [
    '/legal',
    '/legal/terms',
    '/legal/privacy',
    '/legal/delete-account',
    '/support',
  ]) {
    const r = await call('GET', page);
    check(`GET ${page}`, r.status === 200, String(r.status));
  }

  // Seeded development accounts must not exist in a clean production database.
  for (const username of seedUsers) {
    const r = await call('POST', '/api/auth/login', { body: { username, password: seedPassword } });
    check(`seeded account "${username}" cannot sign in`, r.status === 401, String(r.status));
  }

  // A minimal core flow: register (with the published policy versions), sign in, read.
  const policies = await call('GET', '/api/policies');
  const version = (id) => policies.json?.documents?.find((d) => d.id === id)?.version;
  const username = `smoke_${Date.now().toString(36)}`;
  const password = `Smoke-${Math.random().toString(36).slice(2)}-pw`;
  const registered = await call('POST', '/api/auth/register', {
    body: {
      username,
      email: `${username}@example.test`,
      password,
      // Ignored by the server: a role is never taken from a request.
      role: 'developer',
      policies: {
        acceptTerms: true,
        acceptGuidelines: true,
        acknowledgePrivacy: true,
        versions: {
          terms: version('terms'),
          guidelines: version('guidelines'),
          privacy: version('privacy'),
        },
      },
    },
  });
  check('register', registered.status === 201, String(registered.status));
  check(
    'a role in the request body is ignored',
    registered.json?.user?.role === 'member',
    registered.json?.user?.role,
  );
  const login = await call('POST', '/api/auth/login', { body: { username, password } });
  check('sign in', login.status === 200, String(login.status));
  const token = login.json?.token;
  const me = await call('GET', '/api/auth/me', { token });
  check('GET /api/auth/me', me.status === 200 && me.json?.username === username, String(me.status));
  const chart = await call('GET', '/api/chart', { token });
  check('GET /api/chart (authenticated core API)', chart.status === 200, String(chart.status));

  // The development surface is absent — 404, not 401/403 — with and without a session.
  const devRoutes = [
    ['GET', '/api/dev/outbox'],
    ['GET', '/api/dev/status'],
    ['POST', '/api/dev/advance'],
    ['POST', '/api/dev/arrive'],
    ['POST', '/api/dev/lose'],
    ['POST', '/api/dev/tick'],
    ['POST', '/api/dev/forget-policy-acceptances'],
  ];
  for (const [method, url] of devRoutes) {
    const anon = await call(method, url, { body: method === 'POST' ? {} : undefined });
    const authed = await call(method, url, { token, body: method === 'POST' ? {} : undefined });
    check(
      `${method} ${url} is absent`,
      anon.status === 404 && authed.status === 404,
      `${anon.status}/${authed.status}`,
    );
  }

  // The audited takeover chain: request a reset, try to read the link, try to use it.
  const forgot = await call('POST', '/api/auth/password/forgot', {
    body: { email: `${username}@example.test` },
  });
  check('forgot password answers 202', forgot.status === 202, String(forgot.status));
  const outbox = await call('GET', '/api/dev/outbox');
  check(
    'the reset link cannot be read',
    outbox.status === 404 && !/reset=/.test(outbox.text),
    String(outbox.status),
  );
  const reset = await call('POST', '/api/auth/password/reset', {
    body: { token: 'f'.repeat(64), password: 'Attacker-chosen-pw-1' },
  });
  check('a reset without the real token fails', reset.status === 400, String(reset.status));
  const stillMine = await call('POST', '/api/auth/login', { body: { username, password } });
  check(
    'the account still signs in with its own password',
    stillMine.status === 200,
    String(stillMine.status),
  );
} catch (err) {
  check('smoke run completed', false, err instanceof Error ? err.message : String(err));
} finally {
  // 5. Clean stop.
  server.kill('SIGTERM');
  const timer = setTimeout(() => server.kill('SIGKILL'), 15_000);
  const { code, signal } = await exited;
  clearTimeout(timer);
  check('server stops cleanly on SIGTERM', code === 0, `code ${code}, signal ${signal}`);
}

// 6. The server really used the database it was given.
try {
  const Database = createRequire(path.join(artefact, 'package.json'))('better-sqlite3');
  const db = new Database(databasePath, { readonly: true });
  const users = db.prepare('select count(*) as n from users').get().n;
  const shores = db.prepare('select count(*) as n from shores').get().n;
  db.close();
  check(
    'the temporary database holds the smoke account and no seeded users',
    users === 1,
    `${users} user(s)`,
  );
  check('the sea chart was seeded', shores > 0, `${shores} shores`);
} catch (err) {
  check('inspect the temporary database', false, err instanceof Error ? err.message : String(err));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(
  failures === 0
    ? '\nProduction artefact smoke: all checks passed.'
    : `\n${failures} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
