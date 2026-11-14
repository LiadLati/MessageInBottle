// Renders SeaYou's Android launcher icons, splash images and the Play listing icon from the
// brand symbol (public/brand/app-symbol.svg). The output is committed; run this only when the
// symbol changes:
//
//   node apps/web/scripts/android-assets.mjs
//
// It needs a Chromium and the `playwright-core` package, which are not project dependencies
// (set NODE_PATH to a directory containing playwright-core, and CHROMIUM_PATH if Chromium is
// not at /opt/pw-browsers/chromium).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RES = path.join(WEB, 'android/app/src/main/res');
const STORE = path.join(WEB, 'android/store');
const svg = fs.readFileSync(path.join(WEB, 'public/brand/app-symbol.svg'), 'utf8');
// The artwork without its rounded background tile: the adaptive-icon foreground.
const glyph = svg.replace(/<rect width="96" height="96" rx="24" fill="url\(#bg\)"><\/rect>/, '');
if (glyph === svg)
  throw new Error('app-symbol.svg changed shape: update the foreground extraction');

const NIGHT = '#092331';
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const SPLASH = {
  mdpi: [320, 480],
  hdpi: [480, 800],
  xhdpi: [720, 1280],
  xxhdpi: [960, 1600],
  xxxhdpi: [1280, 1920],
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 2000, height: 2000 } });

async function render(file, width, height, body, background = 'transparent') {
  await page.setContent(
    `<!doctype html><html><body style="margin:0;width:${width}px;height:${height}px;` +
      `background:${background};display:grid;place-items:center;overflow:hidden">${body}</body></html>`,
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({
    path: file,
    clip: { x: 0, y: 0, width, height },
    omitBackground: background === 'transparent',
  });
}
const sized = (markup, px) =>
  markup.replace('width="96" height="96"', `width="${px}" height="${px}"`);

for (const [density, scale] of Object.entries(DENSITIES)) {
  const dir = path.join(RES, `mipmap-${density}`);
  const legacy = Math.round(48 * scale);
  // Legacy launcher icon: the whole symbol, rounded tile included.
  await render(path.join(dir, 'ic_launcher.png'), legacy, legacy, sized(svg, legacy));
  // Round launcher icon: the symbol clipped to a circle.
  await render(
    path.join(dir, 'ic_launcher_round.png'),
    legacy,
    legacy,
    `<div style="width:${legacy}px;height:${legacy}px;border-radius:50%;overflow:hidden">${sized(
      svg.replace('rx="24"', 'rx="0"'),
      legacy,
    )}</div>`,
  );
  // Adaptive foreground: 108dp canvas, artwork inside the 66dp safe zone.
  const canvas = Math.round(108 * scale);
  await render(
    path.join(dir, 'ic_launcher_foreground.png'),
    canvas,
    canvas,
    sized(glyph, Math.round(72 * scale)),
  );
}

for (const [density, [w, h]] of Object.entries(SPLASH)) {
  const icon = Math.round(Math.min(w, h) * 0.32);
  await render(
    path.join(RES, `drawable-port-${density}`, 'splash.png'),
    w,
    h,
    sized(svg, icon),
    NIGHT,
  );
  await render(
    path.join(RES, `drawable-land-${density}`, 'splash.png'),
    h,
    w,
    sized(svg, icon),
    NIGHT,
  );
}
await render(path.join(RES, 'drawable', 'splash.png'), 480, 320, sized(svg, 102), NIGHT);

// The Play listing icon: 512×512, full-bleed square (Play applies its own mask).
await render(
  path.join(STORE, 'play-icon-512.png'),
  512,
  512,
  sized(svg.replace('rx="24"', 'rx="0"'), 512),
);

await browser.close();
console.log('Android icons, splash images and the Play icon were written.');
