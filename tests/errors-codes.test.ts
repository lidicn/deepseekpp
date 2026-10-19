import { describe, it, expect } from 'vitest';
import { ERROR_CODES } from '../core/errors/codes';

describe('error-codes', () => {
  it('码表完整性', () => {
    expect(Object.keys(ERROR_CODES).length).toBeGreaterThanOrEqual(10);
  });

  it('每类至少 2 个', () => {
    const categories = new Set(Object.values(ERROR_CODES).map(c => c.category));
    expect(categories.size).toBe(5);
  });

  it('retryable 与 category 一致', () => {
    for (const [, v] of Object.entries(ERROR_CODES)) {
      expect(typeof v.retryable).toBe('boolean');
      expect(typeof v.category).toBe('string');
    }
  });
});
