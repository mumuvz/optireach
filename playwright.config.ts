// End-to-end tests. The global setup starts an isolated stack: the local fixture website (crawl
// target), the API serving the built web app, and the worker, all against the surfaced_e2e
// database and the "surfaced-e2e" Redis namespace, with no external providers (development LLM
// adapter, labeled demo AI provider, development billing, console email).
// Run with `npm run test:e2e` (builds the web app first).
import { defineConfig, devices } from '@playwright/test';

export const E2E_PORT = 4100;

export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'var/e2e-report' }]],
  outputDir: 'var/e2e-results',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
