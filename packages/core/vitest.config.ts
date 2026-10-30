import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'core',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['../../test/setup-env.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
