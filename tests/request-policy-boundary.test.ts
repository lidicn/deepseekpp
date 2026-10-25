import { describe, expect, it, vi } from 'vitest';
import {
  fetchWithNetworkPolicy,
  NetworkPolicyError,
  type NetworkRequestPolicy,
} from '../core/network/request-policy';

// T23: 经公开 fetchWithNetworkPolicy 触发内部 assertRequestWithinPolicy 与 classifyNetworkFailure，
// 不直接引用私有函数。覆盖：恰好上限放行、超 1 字节拒绝、非 string body 跳过；
// callerSignal 已 abort 返回 signal reason、deadline 过期 network_deadline_exceeded、普通错误 network_request_failed。

function policy(overrides: Partial<NetworkRequestPolicy> = {}): NetworkRequestPolicy {
  return {
    operation: 'test-op',
    maxResponseBytes: 10_000,
    ...overrides,
  };
}

const emptyResponse = { ok: true, body: null } as unknown as Response;

describe('assertRequestWithinPolicy · byte boundary', () => {
  it('allows a string body exactly at maxRequestBytes and still calls fetch', async () => {
    const fetchImpl = vi.fn(async () => emptyResponse);
    await fetchWithNetworkPolicy('https://x.test', { body: 'a'.repeat(5), method: 'POST' },
      policy({ maxRequestBytes: 5, fetchImpl }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a string body one byte over the limit without calling fetch', async () => {
    const fetchImpl = vi.fn(async () => emptyResponse);
    await expect(fetchWithNetworkPolicy('https://x.test', { body: 'a'.repeat(6), method: 'POST' },
      policy({ maxRequestBytes: 5, fetchImpl }))).rejects.toMatchObject({
        code: 'network_request_too_large',
        retryable: false,
      });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips the byte check for a non-string (undefined) body', async () => {
    const fetchImpl = vi.fn(async () => emptyResponse);
    await fetchWithNetworkPolicy('https://x.test', { method: 'GET' },
      policy({ maxRequestBytes: 1, fetchImpl }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // 审计 #10（2026-10-24 报告 P1）：原来只对 string body 计字节数，
  // Blob / FormData / ArrayBuffer 全部绕过 maxRequestBytes 预算。
  it('rejects an oversized Blob body without calling fetch', async () => {
    const fetchImpl = vi.fn(async () => emptyResponse);
    await expect(fetchWithNetworkPolicy('https://x.test', {
      method: 'POST',
      body: new Blob([new Uint8Array(64)]),
    }, policy({ maxRequestBytes: 16, fetchImpl }))).rejects.toBeInstanceOf(NetworkPolicyError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an oversized ArrayBuffer body', async () => {
    const fetchImpl = vi.fn(async () => emptyResponse);
    await expect(fetchWithNetworkPolicy('https://x.test', {
      method: 'POST',
      body: new Uint8Array(64).buffer,
    }, policy({ maxRequestBytes: 16, fetchImpl }))).rejects.toBeInstanceOf(NetworkPolicyError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an oversized FormData body', async () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(64)]), 'a.bin');
    const fetchImpl = vi.fn(async () => emptyResponse);
    await expect(fetchWithNetworkPolicy('https://x.test', {
      method: 'POST',
      body: form,
    }, policy({ maxRequestBytes: 16, fetchImpl }))).rejects.toBeInstanceOf(NetworkPolicyError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still allows a small Blob body (负控：别把正常附件挡了)', async () => {
    const fetchImpl = vi.fn(async () => emptyResponse);
    await fetchWithNetworkPolicy('https://x.test', {
      method: 'POST',
      body: new Blob([new Uint8Array(8)]),
    }, policy({ maxRequestBytes: 16, fetchImpl }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('classifyNetworkFailure · caller signal / deadline / ordinary error', () => {
  it('returns the caller signal reason when already aborted', async () => {
    const ctrl = new AbortController();
    const reason = new Error('user-stop');
    ctrl.abort(reason);
    const fetchImpl = vi.fn(async () => emptyResponse);
    await expect(fetchWithNetworkPolicy('https://x.test', { signal: ctrl.signal },
      policy({ fetchImpl }))).rejects.toBe(reason);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps an already-passed deadline to network_deadline_exceeded', async () => {
    const fetchImpl = vi.fn(async () => emptyResponse);
    await expect(fetchWithNetworkPolicy('https://x.test', {},
      policy({ deadlineAt: Date.now() - 1, fetchImpl }))).rejects.toMatchObject({
        code: 'network_deadline_exceeded',
        retryable: false,
      });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps an ordinary fetch failure to network_request_failed', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('boom'); });
    const error = await fetchWithNetworkPolicy('https://x.test', {},
      policy({ deadlineAt: Date.now() + 10_000, fetchImpl })).catch((e) => e);
    expect(error).toBeInstanceOf(NetworkPolicyError);
    expect((error as NetworkPolicyError).code).toBe('network_request_failed');
  });
});
