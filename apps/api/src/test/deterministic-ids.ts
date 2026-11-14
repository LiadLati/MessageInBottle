import { createHash } from 'node:crypto';
import { beforeEach, expect, vi } from 'vitest';
import type * as Ids from '../lib/ids.js';

// Deterministic ids for every test (audit QA-R-008). Storm rolls are drawn from the account id
// and losses from the bottle id, so with random ids a test that sends a long journey could,
// rarely, lose it in a storm and fail on one run in hundreds; that reached CI before
// (4355b5a). Here every id is a hash of the running test's name and a counter that starts again
// for each test, so a test draws the same weather on every run, on every machine. The format
// is the production one (prefix, underscore, 32 hex digits). Secret tokens stay random.
//
// A test file that mocks lib/ids.js itself (to pin a specific id) keeps its own mock.
const state = vi.hoisted(() => ({ n: 0 }));

vi.mock('../lib/ids.js', async (importOriginal) => {
  const real = await importOriginal<typeof Ids>();
  return {
    ...real,
    newId: (prefix: string) => {
      const test = expect.getState().currentTestName ?? '(outside a test)';
      const hex = createHash('sha256')
        .update(`${test}\u0000${state.n++}`)
        .digest('hex')
        .slice(0, 32);
      return `${prefix}_${hex}`;
    },
  };
});

beforeEach(() => {
  state.n = 0;
});
