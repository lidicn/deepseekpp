import { describe, it, expect } from 'vitest';
import {
  normalizeDeepSeekModelType,
  normalizeDeepSeekMessageId,
  matchDeepSeekWebRoute,
  isDeepSeekAugmentableWebRoute,
} from '../core/deepseek/request-codec';

describe('normalizeDeepSeekModelType', () => {
  it('null → default', () => {
    expect(normalizeDeepSeekModelType(null)).toBe('default');
  });
  it('expert 保留', () => {
    expect(normalizeDeepSeekModelType('expert')).toBe('expert');
  });
  it('reasoner → expert', () => {
    expect(normalizeDeepSeekModelType('reasoner')).toBe('expert');
  });
  it('未知值 → default', () => {
    expect(normalizeDeepSeekModelType('unknown')).toBe('default');
  });
});

describe('normalizeDeepSeekMessageId', () => {
  it('数字', () => {
    expect(normalizeDeepSeekMessageId(123)).toBe(123);
  });
  it('数字字符串', () => {
    expect(normalizeDeepSeekMessageId('123')).toBe(123);
  });
  it('负数拒绝', () => {
    expect(normalizeDeepSeekMessageId(-1)).toBeNull();
  });
  it('超 0xFFFFFFFF 拒绝', () => {
    expect(normalizeDeepSeekMessageId(0x100000000)).toBeNull();
  });
  it('null/空 → null', () => {
    expect(normalizeDeepSeekMessageId(null)).toBeNull();
    expect(normalizeDeepSeekMessageId('')).toBeNull();
  });
});

describe('matchDeepSeekWebRoute', () => {
  it('非 DS origin 返回 null', () => {
    expect(matchDeepSeekWebRoute({ url: 'https://example.com/api/chat/completion', method: 'POST' })).toBeNull();
  });
  it('路径+方法匹配', () => {
    const r = matchDeepSeekWebRoute({ url: 'https://chat.deepseek.com/api/v0/chat/completion', method: 'POST' });
    expect(r).toBe('completion');
  });
  it('方法不匹配返回 null', () => {
    expect(matchDeepSeekWebRoute({ url: 'https://chat.deepseek.com/api/v0/chat/completion', method: 'GET' })).toBeNull();
  });
});

describe('isDeepSeekAugmentableWebRoute', () => {
  it('completion true', () => {
    expect(isDeepSeekAugmentableWebRoute('completion')).toBe(true);
  });
  it('history false', () => {
    expect(isDeepSeekAugmentableWebRoute('history')).toBe(false);
  });
});
