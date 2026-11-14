import { z } from 'zod';

// The production CSP has no 'unsafe-eval'. Zod 4 probes for eval with `new Function` the first
// time it parses, and although it catches the failure, the browser still reports a CSP
// violation on every page load (found by the browser smoke tests, apps/e2e). Jitless mode skips
// the probe; validation is identical. Imported first by main.tsx, before any schema runs.
z.config({ jitless: true });
