import { describe, it, expect } from 'vitest';
import {
  evaluateBudget,
  estimateTextTokens,
  evaluateBudgetForText,
  CHAT_CONTEXT_TOKEN_LIMIT,
} from '../core/chat/context-budget';

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

describe('R06 本地长度粗估与文本预算', () => {
  it('estimateTextTokens：CJK 每字约 1，ASCII 每 4 字符约 1', () => {
    expect(estimateTextTokens('你好世界')).toBe(4);
    expect(estimateTextTokens('abcd')).toBe(1);
    expect(estimateTextTokens('你ab')).toBe(2); // 1 CJK + 2/4 ASCII ≈ 1.5 → 2
  });

  it('evaluateBudgetForText 短文本为 ok', () => {
    const b = evaluateBudgetForText('你好');
    expect(b.level).toBe('ok');
    expect(b.remaining).toBe(CHAT_CONTEXT_TOKEN_LIMIT - b.estimatedTokens);
  });

  it('evaluateBudgetForText 超长文本进入 critical', () => {
    const long = '一'.repeat(Math.floor(CHAT_CONTEXT_TOKEN_LIMIT * 0.9));
    expect(evaluateBudgetForText(long).level).toBe('critical');
  });
});
