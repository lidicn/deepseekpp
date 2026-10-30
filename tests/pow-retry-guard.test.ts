/**
 * PoW 重试守卫（审计 P2-4 / P3-5）。
 *
 * 变异（可判红）：
 *   - 去掉 abort 判定 ⇒ 用例 3 红
 *   - 去掉 AbortError 判定 ⇒ 用例 4 红
 *   - 去掉 attempt 上限判定 ⇒ 用例 2 死循环（用 maxAttempts 兜住会红）
 */
import { describe, expect, it, vi } from 'vitest';
import {
  POW_RETRY_BACKOFF_MS,
  POW_RETRY_MAX_ATTEMPTS,
  decidePowRetry,
  withPowRetry,
} from '../core/deepseek/pow-retry';

const noSleep = async () => {};

describe('decidePowRetry', () => {
  it('★ 首次失败 ⇒ 可重试', () => {
    expect(decidePowRetry({ attempt: 1, aborted: false })).toEqual({ retry: true, reason: 'retryable' });
  });

  it('★ 用尽次数 ⇒ 不再重试', () => {
    expect(decidePowRetry({ attempt: POW_RETRY_MAX_ATTEMPTS, aborted: false })).toEqual({
      retry: false,
      reason: 'exhausted',
    });
  });

  it('★★ 已取消 ⇒ 不重试（取消不是 PoW 失败）', () => {
    expect(decidePowRetry({ attempt: 1, aborted: true })).toEqual({ retry: false, reason: 'aborted' });
  });

  it('★★ AbortError / TimeoutError ⇒ 不重试（P3-5）', () => {
    const abort = new DOMException('stop', 'AbortError');
    expect(decidePowRetry({ attempt: 1, aborted: false, error: abort })).toEqual({
      retry: false,
      reason: 'abort-error',
    });
    const timeout = new DOMException('slow', 'TimeoutError');
    expect(decidePowRetry({ attempt: 1, aborted: false, error: timeout })).toEqual({
      retry: false,
      reason: 'abort-error',
    });
  });
});

describe('withPowRetry', () => {
  it('★★ 前两次失败、第三次成功 ⇒ 一共调用 3 次', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom-1'))
      .mockRejectedValueOnce(new Error('boom-2'))
      .mockResolvedValue('ok');
    const onRetry = vi.fn();
    await expect(withPowRetry(run, { sleep: noSleep, onRetry })).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('★ 一直失败 ⇒ 抛**最后一次**错误，调用次数 = 上限', async () => {
    const run = vi.fn().mockRejectedValue(new Error('always'));
    await expect(withPowRetry(run, { sleep: noSleep })).rejects.toThrow('always');
    expect(run).toHaveBeenCalledTimes(POW_RETRY_MAX_ATTEMPTS);
  });

  it('★★ AbortError ⇒ 一次就放弃，不重试', async () => {
    const run = vi.fn().mockRejectedValue(new DOMException('stop', 'AbortError'));
    await expect(withPowRetry(run, { sleep: noSleep })).rejects.toBeTruthy();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('★ 退避序列是 300/600/900', () => {
    expect(POW_RETRY_BACKOFF_MS).toEqual([300, 600, 900]);
  });
});
