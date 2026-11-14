import { defineConfig, devices } from '@playwright/test';

// Browser and accessibility smoke tests (re-audit QA-R-002) against what would ship: the
// production web bundle and the compiled API in production mode, served with the reference
// proxy's headers and CSP (serve.mjs). Run `pnpm build` first. One worker: the tests share one
// server and one temporary database.
const port = Number(process.env.E2E_PORT ?? 4317);

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'off',
  },
  projects: [
    { name: 'phone', use: { ...devices['Pixel 7'] } },
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: 'node serve.mjs',
    url: `http://127.0.0.1:${port}/api/health`,
    timeout: 60_000,
    reuseExistingServer: false,
    stdout: 'pipe',
  },
});
