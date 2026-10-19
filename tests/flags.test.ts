import { describe, it, expect } from 'vitest';
import { FLAG_REGISTRY, stableHash, shouldEnable } from '../core/flags/flags';

describe('flags', () => {
  it('默认值正确', () => {
    expect(shouldEnable(FLAG_REGISTRY.boot_health, 'test')).toBe(true);
    expect(shouldEnable(FLAG_REGISTRY.resume_enabled, 'test')).toBe(false);
  });

  it('override 优先', () => {
    expect(shouldEnable(FLAG_REGISTRY.resume_enabled, 'test', { resume_enabled: true })).toBe(true);
  });

  it('灰度 0% 关闭', () => {
    expect(shouldEnable({ ...FLAG_REGISTRY.boot_health, rolloutPercent: 0 }, 'any')).toBe(false);
  });

  it('灰度 100% 用默认值', () => {
    expect(shouldEnable({ ...FLAG_REGISTRY.boot_health, rolloutPercent: 100 }, 'any')).toBe(true);
  });

  it('同 installId 稳定', () => {
    const flag = { ...FLAG_REGISTRY.boot_health, rolloutPercent: 50 };
    const a = shouldEnable(flag, 'install-123');
    const b = shouldEnable(flag, 'install-123');
    expect(a).toBe(b);
  });

  it('不同 installId 分布', () => {
    const flag = { ...FLAG_REGISTRY.boot_health, rolloutPercent: 50 };
    const results = new Set();
    for (let i = 0; i < 100; i++) {
      results.add(shouldEnable(flag, `install-${i}`));
    }
    expect(results.size).toBe(2);
  });
});
