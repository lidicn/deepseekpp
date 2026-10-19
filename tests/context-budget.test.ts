import { describe, it, expect } from 'vitest';
import { evaluateBudget } from '../core/chat/context-budget';

describe('context-budget', () => {
  it('ok 档', () => {
    expect(evaluateBudget(10, 1000, 10000).level).toBe('ok');
  });
  it('warn 档', () => {
    expect(evaluateBudget(20, 6000, 10000).level).toBe('warn');
  });
  it('critical 档', () => {
    expect(evaluateBudget(30, 9000, 10000).level).toBe('critical');
  });
  it('remaining 计算', () => {
    expect(evaluateBudget(10, 3000, 10000).remaining).toBe(7000);
  });
  it('边界 50%', () => {
    expect(evaluateBudget(10, 5000, 10000).level).toBe('warn');
  });
});
