import { defineConfig } from 'vitest/config';

// Each workspace has its own vitest.config.ts (environment, setup files). The global setup
// recreates the isolated test database once per run; set SKIP_DB_RESET=true to skip it.
export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    projects: ['packages/shared', 'packages/core', 'apps/api', 'apps/worker', 'apps/web'],
  },
});
