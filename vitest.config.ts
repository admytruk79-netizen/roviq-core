import { defineConfig } from 'vitest/config';

// Default `vitest run` (used by `npm test`, CI, and every workflow) only runs
// fast unit tests with no external dependencies. End-to-end tests that need a
// real Postgres database use the `.e2e.test.ts` suffix and run separately via
// `npm run test:e2e`, since CI has no database available.
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/*.e2e.test.ts']
  }
});
