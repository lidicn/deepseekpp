import { describe, it, expect } from 'vitest';
import { toUserMessage } from '../core/errors/user-message';

describe('user-message', () => {
  it('超时错误', () => {
    const m = toUserMessage(new Error('timeout after 120s'));
    expect(m.title).toBe('请求超时');
  });
  it('网络错误', () => {
    const m = toUserMessage(new Error('fetch failed'));
    expect(m.title).toBe('网络错误');
  });
  it('权限错误', () => {
    const m = toUserMessage(new Error('permission denied'));
    expect(m.title).toBe('权限不足');
  });
  it('未知错误兜底', () => {
    const m = toUserMessage(new Error('something weird'));
    expect(m.title).toBe('出错了');
  });
  it('非 Error 对象', () => {
    const m = toUserMessage('string error');
    expect(m.detail).toBe('string error');
  });
});
