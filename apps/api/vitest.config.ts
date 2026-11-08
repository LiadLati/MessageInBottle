import { defineConfig } from 'vitest/config';

// Checked in so the suite runs the same everywhere (audit QA-R-007). The timeout is vitest's own
// default, stated rather than raised: a test that needs more says so itself, with a reason.
export default defineConfig({
  test: {
    testTimeout: 5_000,
    hookTimeout: 10_000,
    // Every id a test creates is derived from the test's name (audit QA-R-008).
    setupFiles: ['./src/test/deterministic-ids.ts'],
  },
});
