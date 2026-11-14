// A production-shaped SeaYou for the browser tests: the compiled API (node dist/server.js, in
// production mode) on a fresh temporary database, behind a small proxy that does what the
// reference Caddyfile does (docs/deploy/Caddyfile): the API owns /api, /legal and /support,
// everything else is the built web app with the same security headers and CSP, and unknown
// paths fall back to index.html.
//
//   node apps/e2e/serve.mjs            (needs `pnpm build` first)
//
// Nothing here reaches a real service. The environment handed to the API is built from
// scratch: no .env, no secrets, no real database.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const apiDist = path.join(root, 'apps', 'api', 'dist');
const webDist = path.join(root, 'apps', 'web', 'dist');
const webPort = Number(process.env.E2E_PORT ?? 4317);
const apiPort = webPort + 1;

for (const [what, file] of [
  ['the compiled API', path.join(apiDist, 'server.js')],
  ['the built web app', path.join(webDist, 'index.html')],
]) {
  if (!fs.existsSync(file)) {
    console.error(`${what} is missing (${file}). Run \`pnpm build\` first.`);
    process.exit(1);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seayou-e2e-'));
const env = {
  PATH: process.env.PATH,
  HOME: tmp,
  MIB_DATABASE_PATH: path.join(tmp, 'e2e.sqlite'),
  MIB_PORT: String(apiPort),
  MIB_HOST: '127.0.0.1',
  // Production requires an https public address; nothing is ever sent to it here.
  MIB_APP_URL: 'https://seayou.example',
  MIB_AI_ENABLED: 'false',
  MIB_LOG_REQUESTS: 'false',
};
const migrated = spawnSync(process.execPath, [path.join(apiDist, 'migrate.js')], {
  cwd: tmp,
  env,
  encoding: 'utf8',
});
if (migrated.status !== 0) {
  console.error(migrated.stderr);
  process.exit(1);
}
const api = spawn(process.execPath, [path.join(apiDist, 'server.js')], {
  cwd: tmp,
  env,
  stdio: ['ignore', 'inherit', 'inherit'],
});

// The reference Caddyfile's headers for the web app.
const WEB_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pbf': 'application/x-protobuf',
  '.glb': 'model/gltf-binary',
  '.txt': 'text/plain; charset=utf-8',
};
const isApi = (p) =>
  p.startsWith('/api/') || p === '/legal' || p.startsWith('/legal/') || p === '/support';

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (isApi(url.pathname)) {
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: apiPort,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `127.0.0.1:${apiPort}` },
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
    return;
  }
  // try_files {path} /index.html, never outside the web root.
  let file = path.join(webDist, path.normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(webDist) || !fs.existsSync(file) || fs.statSync(file).isDirectory())
    file = path.join(webDist, 'index.html');
  res.writeHead(200, {
    ...WEB_HEADERS,
    'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    ...(url.pathname.startsWith('/assets/')
      ? { 'cache-control': 'public, max-age=31536000, immutable' }
      : {}),
  });
  fs.createReadStream(file).pipe(res);
});
server.listen(webPort, '127.0.0.1', () =>
  console.log(`SeaYou e2e: web on http://127.0.0.1:${webPort}, API on ${apiPort}`),
);

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  server.close();
  api.kill('SIGTERM');
  api.once('exit', () => {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
  });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
api.on('exit', (code) => {
  if (!stopping) {
    console.error(`the API exited (${code})`);
    process.exit(1);
  }
});
