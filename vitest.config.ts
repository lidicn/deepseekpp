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
    // Batch-4 fix: IndexedDB-backed tests (e.g. tool-runtime-externalized-payload)
    // open the real IndexedDB via fake-indexeddb; under high fork-pool concurrency
    // the open round-trip can exceed the default 10s hook timeout. Bump hook/test
    // timeouts so those setups don't spuriously kill themselves.
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});

