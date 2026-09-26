import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RETIRED_PRODUCT_PHRASES } from '@mib/shared';

// `public/` is copied verbatim into the build and every file in it is fetchable, referenced or
// not. The retired product names must not ship there either (audit FE-020).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEXT = /\.(svg|html?|json|txt|webmanifest|xml|css|js)$/i;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? files(full) : TEXT.test(e.name) ? [full] : [];
  });
}

describe('static assets', () => {
  const shipped = [...files(path.join(root, 'public')), path.join(root, 'index.html')];

  it('finds the files it checks', () => {
    expect(shipped.length).toBeGreaterThan(1);
  });

  it.each(RETIRED_PRODUCT_PHRASES)('never ship the retired phrase "%s"', (phrase) => {
    for (const file of shipped)
      expect(fs.readFileSync(file, 'utf8'), path.relative(root, file)).not.toContain(phrase);
  });
});
