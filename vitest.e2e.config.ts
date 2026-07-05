/**
 * vitest.e2e.config.ts — Vitest configuration for end-to-end browser tests.
 *
 * E2E tests live in tests/e2e/ and require Playwright browser binaries.
 * They are run separately from unit tests:
 *
 *   npm run test:e2e
 *
 * Separate from the default config so the CI unit-test step stays fast
 * and browser-free. E2E tests can be run on-demand or in a dedicated
 * CI stage with browser images.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 60000,    // 60 s per test — browser launch + network
    hookTimeout: 30000,    // 30 s for beforeAll/afterAll
    pool: 'forks',         // Isolate browser processes between test files
    poolOptions: {
      forks: { singleFork: true }, // One process per test file (safer for browser tests)
    },
  },
});
