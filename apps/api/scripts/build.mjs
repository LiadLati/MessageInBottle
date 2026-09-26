// Production build of the API: `pnpm --filter @mib/api build` (or `pnpm build` at the root).
//
// Emits a self-contained ESM artefact into apps/api/dist that runs on plain Node — no tsx, no
// TypeScript runtime. `@mib/shared` is published as TypeScript source inside the workspace, so it
// is bundled in; every npm dependency of @mib/api stays external and is installed with
// `pnpm install --prod` (better-sqlite3 is a native module and cannot be bundled anyway).
//
// Layout, all at one level so that each entry resolves the same paths as its source did:
//   dist/server.js            the API               node dist/server.js
//   dist/migrate.js           apply migrations      node dist/migrate.js
//   dist/grant-admin.js       role provisioning     node dist/grant-admin.js -- …
//   dist/grant-developer.js
//   dist/retention.js         retention dry-run / apply
//   dist/backup.js            online backup and backup verification
//   dist/deletion-backfill.js deletion rules for accounts deleted earlier (dry run by default)
//   dist/audit-export.js      moderation audit trail for one account (data-subject requests)
//   dist/data/sea-graph.v2.json   read at start to seed the chart
// The migrations stay in apps/api/drizzle, which config.ts resolves as <dist>/../drizzle.
//
// Deliberately absent: the seed and reset scripts (development only), the geo dataset
// generator, tests, source maps and any .env or database file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(apiRoot, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(apiRoot, 'package.json'), 'utf8'));

// Everything the API declares as a runtime dependency is resolved from node_modules at run
// time, except the workspace package, which exists only as TypeScript source.
const external = Object.keys(pkg.dependencies ?? {}).filter((name) => name !== '@mib/shared');

const entryPoints = {
  server: 'src/server.ts',
  migrate: 'src/db/migrate.ts',
  'grant-admin': 'src/tools/grant-admin.ts',
  'grant-developer': 'src/tools/grant-developer.ts',
  retention: 'src/tools/retention.ts',
  backup: 'src/tools/backup.ts',
  'deletion-backfill': 'src/tools/deletion-backfill.ts',
  'audit-export': 'src/tools/audit-export.ts',
};

fs.rmSync(dist, { recursive: true, force: true });

const result = await build({
  absWorkingDir: apiRoot,
  entryPoints,
  outdir: dist,
  entryNames: '[name]',
  bundle: true,
  // One file per entry, no shared chunks: a chunk in a subdirectory would see a different
  // import.meta.url and resolve the API root and the data directory wrongly.
  splitting: false,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external,
  // The compiled artefact is production by construction (config.ts): it refuses
  // MIB_DEV_MODE=true and requires an absolute MIB_DATABASE_PATH.
  define: { __MIB_PRODUCTION_BUILD__: 'true' },
  // No source maps: they would ship the source. Stack traces point at readable, unminified
  // JavaScript instead, which is enough to diagnose a production error.
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});

// Nothing from node_modules may be bundled by accident: a devDependency pulled into the
// artefact would work here and then be missing — or silently duplicated — in production.
const bundledPackages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(input);
  if (m && m[1] !== '@mib/shared') bundledPackages.add(m[1]);
}
if (bundledPackages.size > 0) {
  console.error(`Refusing to bundle npm packages into the API: ${[...bundledPackages].join(', ')}`);
  process.exit(1);
}

fs.mkdirSync(path.join(dist, 'data'), { recursive: true });
fs.copyFileSync(
  path.join(apiRoot, 'src/db/geo/data/sea-graph.v2.json'),
  path.join(dist, 'data/sea-graph.v2.json'),
);

const files = fs
  .readdirSync(dist, { recursive: true })
  .filter((f) => !fs.statSync(path.join(dist, f)).isDirectory());
console.log(
  `API built into ${path.relative(process.cwd(), dist) || 'dist'}: ${files.sort().join(', ')}`,
);
