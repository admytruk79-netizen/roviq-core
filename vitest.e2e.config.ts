import { defineConfig } from 'vitest/config';

// End-to-end suites share one real Postgres database. Run test files
// sequentially so actors/capabilities created by one scenario cannot race
// another scenario's routing assertions. CI applies migrations to a fresh
// database before invoking this configuration.
export default defineConfig({
  test: {
    include: ['tests/**/*.e2e.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1
  }
});
