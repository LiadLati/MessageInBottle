import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PRIVACY_POLICY, textOf } from '@mib/shared';

// The Privacy Policy makes a closed statement about what SeaYou puts in a browser: a session
// token and an unsent letter in sessionStorage, and the device time zone in localStorage —
// and nothing else, no cookies, no IndexedDB.
//
// A closed statement is only worth making if something checks it, so this walks the real
// source and fails if the implementation ever grows a fourth thing to store. Either the code
// changes or the policy does; they are not allowed to drift.

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = here;

function sources(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return sources(full);
      if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) return [];
      return [full];
    })
    .sort();
}
const files = sources(SRC);
const bodies = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));

// Every key each mechanism is used with, read straight out of the source. Keys are always
// module constants — a string, or a list of them walked by a loop — so this resolves both and
// refuses to guess: an unresolvable key fails the test rather than passing quietly.
function keysFor(api: 'sessionStorage' | 'localStorage'): Set<string> {
  const found = new Set<string>();
  for (const [file, body] of bodies) {
    const strings = new Map<string, string>();
    for (const m of body.matchAll(/const\s+(\w+)\s*=\s*'([^']+)'/g)) strings.set(m[1]!, m[2]!);
    const lists = new Map<string, string[]>();
    for (const m of body.matchAll(/const\s+(\w+)\s*=\s*\[([^\]]*)\]/g))
      lists.set(
        m[1]!,
        [...m[2]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!),
      );
    // `for (const key of SOME_LIST)` — the loop variable stands for every member.
    const loopVars = new Map<string, string[]>();
    for (const m of body.matchAll(/for\s*\(\s*const\s+(\w+)\s+of\s+(\w+)\s*\)/g))
      if (lists.has(m[2]!)) loopVars.set(m[1]!, lists.get(m[2]!)!);

    for (const m of body.matchAll(
      new RegExp(`${api}\\.(?:get|set|remove)Item\\(\\s*([\\w.]+)`, 'g'),
    )) {
      const token = m[1]!;
      const resolved = strings.has(token)
        ? [strings.get(token)!]
        : (loopVars.get(token) ?? lists.get(token));
      expect(resolved, `${file}: cannot resolve ${api} key ${token}`).toBeDefined();
      for (const key of resolved!) found.add(key);
    }
  }
  return found;
}

describe('what SeaYou stores in the browser', () => {
  it('uses sessionStorage for exactly the session token and the unsent letter', () => {
    expect([...keysFor('sessionStorage')].sort()).toEqual(['mib.draft', 'mib.session.token']);
  });

  it('uses localStorage for exactly the device time zone', () => {
    expect([...keysFor('localStorage')].sort()).toEqual(['mib.accountTimeZone']);
  });

  it('sets no cookies and uses no IndexedDB', () => {
    for (const [file, body] of bodies) {
      expect(body, file).not.toMatch(/document\.cookie/);
      expect(body, file).not.toMatch(/\bindexedDB\b/);
      expect(body, file).not.toMatch(/\bopenDatabase\b/);
      // Nor any other storage API smuggled in under a different name.
      expect(body, file).not.toMatch(/\bnavigator\.storage\b/);
      expect(body, file).not.toMatch(/\bcaches\.open\b/);
    }
  });

  // The promises themselves are proven by behaviour, not by these files' text:
  // state/session.test.tsx signs out and inspects storage, lib/draft.test.ts and
  // screens/WriteScreen.test.tsx send a letter and check the draft is gone (audit QA-008).
  // What stays here is the cheap backstop: the clean-up code exists where it should.
  it('keeps the clean-up code the behavioural tests exercise', () => {
    const session = bodies.get(path.join(SRC, 'state', 'session.tsx'))!;
    expect(session).toMatch(/sessionStorage\.removeItem\(STORAGE_KEY\)/);
    expect(session).toMatch(/sessionStorage\.removeItem\(sessionKey\)/);
    expect(session).toMatch(/localStorage\.removeItem\(localKey\)/);
    const draft = bodies.get(path.join(SRC, 'lib', 'draft.ts'))!;
    expect(draft).toMatch(/sessionStorage\.removeItem\(DRAFT_KEY\)/);
  });

  it('says all of this, and only this, in the Privacy Policy', () => {
    const privacy = textOf(PRIVACY_POLICY);
    expect(privacy).toMatch(/session token, in sessionStorage/i);
    expect(privacy).toMatch(/in sessionStorage, so that a reload does not lose it/i);
    expect(privacy).toMatch(/time zone as last received from the server, in localStorage/i);
    expect(privacy).toMatch(/sets no cookies, and uses no IndexedDB/i);
    // The policy promises they go on sign-out and on sending; the tests above prove they do.
    expect(privacy).toMatch(/removed when you sign out/i);
    expect(privacy).toMatch(/removed as soon as the letter is sent/i);
  });
});
