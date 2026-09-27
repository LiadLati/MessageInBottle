// Builds SeaYou's interface for the Android app and syncs it into the Android project.
//
//   pnpm --filter @mib/web android:dev       # emulator, development API on the host computer
//   pnpm --filter @mib/web android:release   # Google Play; needs VITE_MIB_API_ORIGIN=https://…
//
// Then build the app itself with Gradle (docs/ANDROID.md): assembleDebug for the emulator,
// bundleRelease for the Play upload. The release Gradle build refuses assets that were not
// produced by `android:release` (android/app/build.gradle, verifySeaYouReleaseAssets).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV_ORIGIN = 'http://10.0.2.2:3001';
// Strings that must never reach a release bundle.
const DEV_MARKERS = ['10.0.2.2', '127.0.0.1', 'localhost:3001', 'localhost:5173'];

/** Why an API origin is unfit for a release build, or null when it is fit. */
export function releaseOriginProblem(raw) {
  if (!raw)
    return 'VITE_MIB_API_ORIGIN is not set. Set it to the public https:// origin of the API.';
  let url;
  try {
    url = new URL(raw);
  } catch {
    return `VITE_MIB_API_ORIGIN is not a URL: ${raw}`;
  }
  if (url.protocol !== 'https:')
    return `VITE_MIB_API_ORIGIN must be https:// for a release: ${raw}`;
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    return `VITE_MIB_API_ORIGIN must be an origin only (no path, query or credentials): ${raw}`;
  const host = url.hostname;
  if (
    host === 'localhost' ||
    host === '10.0.2.2' ||
    /^(127|10|192\.168)\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /\.(local|localhost|test|example|invalid)$/.test(host) ||
    /(^|\.)example\.(com|org|net)$/.test(host)
  )
    return `VITE_MIB_API_ORIGIN points at a development or placeholder host: ${raw}`;
  return null;
}

function run(cmd, args, env) {
  execFileSync(cmd, args, { cwd: WEB, stdio: 'inherit', env: { ...process.env, ...env } });
}

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(p) : [p];
  });
}

function main() {
  const mode = process.argv[2];
  if (mode !== 'dev' && mode !== 'release') {
    console.error('usage: android-build.mjs dev|release');
    process.exit(2);
  }
  const apiOrigin =
    mode === 'dev'
      ? (process.env.VITE_MIB_API_ORIGIN ?? DEV_ORIGIN)
      : process.env.VITE_MIB_API_ORIGIN;
  if (mode === 'release') {
    const problem = releaseOriginProblem(apiOrigin);
    if (problem) {
      console.error(`Refusing to build a release: ${problem}`);
      process.exit(1);
    }
  }
  const origin = new URL(apiOrigin).origin;

  // A production bundle in both modes: development controls exist only under `vite dev`.
  run('pnpm', ['exec', 'tsc', '--noEmit']);
  run('pnpm', ['exec', 'vite', 'build', '--mode', 'production'], { VITE_MIB_API_ORIGIN: origin });

  const dist = path.join(WEB, 'dist');
  if (mode === 'release') {
    for (const file of filesUnder(dist).filter((f) => /\.(js|html|css|json)$/.test(f))) {
      const text = fs.readFileSync(file, 'utf8');
      const hit = DEV_MARKERS.find((m) => text.includes(m));
      if (hit) {
        console.error(`Refusing to sync a release: ${path.relative(WEB, file)} contains "${hit}".`);
        process.exit(1);
      }
    }
  }
  // What the release Gradle build checks before it will package anything.
  fs.writeFileSync(
    path.join(dist, 'seayou-build.json'),
    `${JSON.stringify({ mode, apiOrigin: origin }, null, 2)}\n`,
  );
  run('pnpm', ['exec', 'cap', 'sync', 'android'], { SEAYOU_ANDROID_MODE: mode });
  console.log(`\nAndroid project synced for ${mode}, API ${origin}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
