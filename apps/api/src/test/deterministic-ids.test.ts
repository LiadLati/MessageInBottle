import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { newId, newSecretToken } from '../lib/ids.js';
import { createTestWorld } from './harness.js';

// The setup file really applies (audit QA-R-008): ids come from the test's name, so a world's
// accounts — and so their storm rolls — are the same on every run.
describe('deterministic test ids', () => {
  it('derives ids from the running test and a counter', () => {
    const expected = (n: number) =>
      createHash('sha256')
        .update(`${expect.getState().currentTestName}\u0000${n}`)
        .digest('hex')
        .slice(0, 32);
    expect(newId('usr')).toBe(`usr_${expected(0)}`);
    expect(newId('btl')).toBe(`btl_${expected(1)}`);
    // Secret tokens are never derived.
    expect(newSecretToken()).not.toBe(newSecretToken());
  });

  it('applies to the accounts a test world seeds', () => {
    const ada = createTestWorld().user('ada').id;
    const hex = ada.slice(4);
    // One of the first few ids this test derived.
    const derived = Array.from({ length: 200 }, (_, n) =>
      createHash('sha256')
        .update(`${expect.getState().currentTestName}\u0000${n}`)
        .digest('hex')
        .slice(0, 32),
    );
    expect(derived).toContain(hex);
  });
});
