import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnvFiles, parseEnvFile } from './env.js';

describe('.env loading', () => {
  it('parses the documented format and ignores anything else', () => {
    expect(
      parseEnvFile(
        [
          '# a comment',
          '',
          'MIB_MAIL_PROVIDER=smtp',
          'MIB_SMTP_PORT = 465 ',
          'MIB_MAIL_FROM="Message in a Bottle <no-reply@example.com>"',
          "MIB_SMTP_USER='someone'",
          'export MIB_SMTP_SECURE=true',
          'not a variable',
          '=nokey',
        ].join('\n'),
      ),
    ).toEqual({
      MIB_MAIL_PROVIDER: 'smtp',
      MIB_SMTP_PORT: '465',
      MIB_MAIL_FROM: 'Message in a Bottle <no-reply@example.com>',
      MIB_SMTP_USER: 'someone',
      MIB_SMTP_SECURE: 'true',
    });
  });

  it('applies a file, lets the real environment win, and prefers the first file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mib-env-'));
    const first = path.join(dir, 'first.env');
    const second = path.join(dir, 'second.env');
    fs.writeFileSync(first, 'FROM_FILE=one\nSHARED=first\nALREADY=from-file\n');
    fs.writeFileSync(second, 'SHARED=second\nONLY_SECOND=yes\n');
    const env: NodeJS.ProcessEnv = { ALREADY: 'from-environment' };

    const loaded = loadEnvFiles([first, path.join(dir, 'missing.env'), second], env);

    expect(loaded).toEqual([first, second]);
    expect(env.FROM_FILE).toBe('one');
    expect(env.ONLY_SECOND).toBe('yes');
    expect(env.SHARED).toBe('first');
    expect(env.ALREADY).toBe('from-environment');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is a no-op when no file exists', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(loadEnvFiles([path.join(os.tmpdir(), 'mib-absent-.env')], env)).toEqual([]);
    expect(Object.keys(env)).toEqual([]);
  });
});
