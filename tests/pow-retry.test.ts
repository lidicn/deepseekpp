import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P1-1: PoW solve 独立重试（3 次 / 退避 300-600-900ms / abort 不重试）。
const adapterMocks = vi.hoisted(() => ({
  createPowHeaders: vi.fn(),
}));

vi.mock('../core/deepseek/adapter', () => ({
  createClientHeaders: vi.fn(() => ({ Authorization: 'Bearer test' })),
  createPowHeaders: adapterMocks.createPowHeaders,
  submitPromptStreaming: vi.fn(),
}));

import { solvePowWithRetry } from '../core/inline-agent/pi/deepseek-stream-fn';

describe('solvePowWithRetry（P1-1 PoW 独立重试）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('前两次失败、第三次成功：重试 3 次并在退避后返回成功 headers', async () => {
    adapterMocks.createPowHeaders
      .mockRejectedValueOnce(new Error('wasm load failed'))
      .mockRejectedValueOnce(new Error('challenge fetch failed'))
      .mockResolvedValueOnce({ 'X-DS-PoW-Response': 'ok-3' });

    const promise = solvePowWithRetry({ Authorization: 'Bearer test' }, undefined);
    // 快进前两次退避（300ms + 600ms = 900ms），第三次立即成功，无需等到 900。
    await vi.advanceTimersByTimeAsync(900);
    const headers = await promise;

    expect(adapterMocks.createPowHeaders).toHaveBeenCalledTimes(3);
    expect(headers).toEqual({ 'X-DS-PoW-Response': 'ok-3' });
  });

  it('aborted signal：立即抛出且不重试', async () => {
    const controller = new AbortController();
    controller.abort();
    adapterMocks.createPowHeaders.mockRejectedValue(new Error('x'));

    await expect(
      solvePowWithRetry({ Authorization: 'Bearer test' }, undefined, controller.signal),
    ).rejects.toBeTruthy();
    expect(adapterMocks.createPowHeaders).not.toHaveBeenCalled();
  });

  it('三次全部失败：抛出最后一次错误，调用 3 次', async () => {
    const fatal = new Error('poi forever');
    adapterMocks.createPowHeaders.mockRejectedValue(fatal);

    const promise = solvePowWithRetry({ Authorization: 'Bearer test' }, undefined);
    // 先挂 catch 订阅，避免 fake-timer 推进期间最终 rejection 未被处理。
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(900 + 900);
    await expect(promise).rejects.toBe(fatal);
    expect(adapterMocks.createPowHeaders).toHaveBeenCalledTimes(3);
  });
});
