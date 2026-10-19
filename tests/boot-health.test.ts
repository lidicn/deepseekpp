import { describe, it, expect } from 'vitest';
import { runBootHealth } from '../core/diagnostics/boot-health';

const goodDeps = {
  runtimeId: 'rt-123',
  storedVersion: '1.22.0',
  currentVersion: '1.22.0',
  hasAuthToken: true,
  registeredProviderCount: 5,
  mcpStatus: 'connected' as const,
  keepaliveAlive: true,
};

describe('boot-health', () => {
  it('全部通过', () => {
    const checks = runBootHealth(goodDeps);
    expect(checks.every(c => c.ok)).toBe(true);
  });

  it('runtime 失败', () => {
    const checks = runBootHealth({ ...goodDeps, runtimeId: undefined });
    expect(checks[0].ok).toBe(false);
  });

  it('version 不匹配', () => {
    const checks = runBootHealth({ ...goodDeps, storedVersion: '1.0.0' });
    expect(checks[1].ok).toBe(false);
  });

  it('auth 缺失', () => {
    const checks = runBootHealth({ ...goodDeps, hasAuthToken: false });
    expect(checks[2].ok).toBe(false);
  });

  it('tools 为 0', () => {
    const checks = runBootHealth({ ...goodDeps, registeredProviderCount: 0 });
    expect(checks[3].ok).toBe(false);
  });

  it('mcp 失败', () => {
    const checks = runBootHealth({ ...goodDeps, mcpStatus: 'failed' });
    expect(checks[4].ok).toBe(false);
  });
});
