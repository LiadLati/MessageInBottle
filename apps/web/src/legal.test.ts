import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PUBLISHED_DOCUMENTS, textOf } from '@mib/shared';

// The production surface of the App: what a person can actually read and type. These guard the
// two promises that cannot be checked by looking at one file — that no draft or Hebrew content
// survives anywhere, and that nothing anywhere asks for an age or a date of birth.
const webSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const apiSrc = path.resolve(webSrc, '../../api/src');
const sharedSrc = path.resolve(webSrc, '../../../packages/shared/src');

// The evaluation corpus for the moderation model is deliberately multilingual — Hebrew,
// Arabic and Russian abuse samples are what it exists to test. It is a fixture, never shown to
// anyone, so the English-only rule does not apply to it.
const NOT_USER_FACING = [path.join('services', 'ai-eval-samples.ts')];

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

// Written as escapes so this file is itself ASCII and does not trip its own rule.
const HEBREW = new RegExp('[\\u0590-\\u05FF]');

const productionSources = [
  ...sourceFiles(webSrc),
  ...sourceFiles(apiSrc),
  ...sourceFiles(sharedSrc),
].filter((f) => !NOT_USER_FACING.some((skip) => f.endsWith(skip)));

describe('production content', () => {
  it('reads every source file it checks', () => {
    expect(productionSources.length).toBeGreaterThan(40);
  });

  it('contains no Hebrew, no draft notice and no unresolved field', () => {
    for (const file of productionSources) {
      const body = fs.readFileSync(file, 'utf8');
      expect(body, `${file} contains Hebrew`).not.toMatch(HEBREW);
    }
    // The unresolved-field check belongs to the documents, not to source, where `[[` is
    // ordinary TypeScript in a nested array type.
    for (const doc of PUBLISHED_DOCUMENTS) {
      const body = `${doc.title}\n${doc.summary}\n${textOf(doc)}`;
      expect(body).not.toMatch(/\[\[/);
      expect(body).not.toMatch(/\bdraft\b/i);
    }
  });

  it('never asks for an age or a date of birth, anywhere', () => {
    const forbidden = [
      /date[_ -]?of[_ -]?birth/i,
      /\bdateOfBirth\b/,
      /\bbirth[_ ]?date\b/i,
      /\bdob\b/i,
      /age[_ -]?verif/i,
      /\bageConfirmed\b/i,
      /\bisAdult\b/i,
      /\bminimumAge\b/i,
      /\bunder ?18\b/i,
      /\b18\+/,
    ];
    for (const file of productionSources) {
      const body = fs.readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        expect(body, `${file} matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('keeps the two registration consents and their exact wording in one place', () => {
    const consent = fs.readFileSync(path.join(webSrc, 'components/PolicyConsent.tsx'), 'utf8');
    expect(consent).toMatch(/I agree to the \{link\('terms', 'Terms of Use'\)\} and\{' '\}/);
    expect(consent).toMatch(/\{link\('guidelines', 'Community Rules'\)\}/);
    expect(consent).toMatch(/I have read the \{link\('privacy', 'Privacy Policy'\)\}/);
    // Both start unchecked and neither is optional.
    expect(consent).toMatch(/EMPTY_CONSENT: ConsentState = \{ terms: false, privacy: false \}/);
    // There is no third control of any kind, and no marketing consent.
    expect(consent).not.toMatch(/marketing|newsletter|promotion/i);
    expect((consent.match(/type="checkbox"/g) ?? []).length).toBe(2);
  });
});
