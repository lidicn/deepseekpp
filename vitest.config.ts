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
    // IndexedDB-backed tests (e.g. tool-runtime-externalized-payload) open the real
    // IndexedDB via fake-indexeddb; under high fork-pool concurrency the open
    // round-trip can exceed the default 10s **hook** timeout ⇒ 只放宽 hook。
    //
    // testTimeout 保持默认（5s）：把它一起抬到 30s 会让"卡死"类失败慢 6 倍才暴露，
    // 而且掩盖真实的挂起。确实需要更久的用例自己声明（见
    // tests/d1-audit-03c-streamfn-probe.test.ts:92 的 30000）。
    hookTimeout: 30_000,
  },
});

