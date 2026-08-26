import { defineConfig } from 'vitest/config';

// Runs only the end-to-end tests (`.e2e.test.ts`). Requires a real Postgres
// database with migrations applied — see the "End-to-end tests" section in
// README.md. Not run by CI; run locally with `npm run test:e2e`.
export default defineConfig({
  test: {
    include: ['tests/**/*.e2e.test.ts']
  }
});
