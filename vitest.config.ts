import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // F3 fix: reset mocks between test files to prevent cross-file spy leakage
    // (e.g. performance.now spy persisting into later test suites).
    restoreMocks: true,
    clearMocks: true,
    unstubGlobals: true,
  },
});

