/**
 * D1-02 · T4 新建对话首条消息——createPowHeaders 失败被吞成 PoW 错误，
 *         且 Web 路径 runWebPrompt 的 createChatSession 失败无任何重试。
 *
 * 候选根因链：
 *  chat-runtime-service.runWebToolLoop 每一步都调用 createPowHeaders；
 *  新建对话第一步 = createChatSession + createPowHeaders(completion) + submit。
 *  createPowHeadersForPathWithContext 把所有非 PoW/Auth/Network 异常
 *  统一包装为 DeepSeekPowError（active-client.ts:242），丢失原始类型，
 *  调用方无法区分"该重试"与"不该重试"。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../core/network/request-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/network/request-policy')>();
  return {
    ...actual,
    fetchWithNetworkPolicy: vi.fn(),
    readNetworkResponseText: vi.fn(),
  };
});

import {
  createDeepSeekAutomationClient,
  DeepSeekPowError,
  DeepSeekAuthError,
} from '../core/deepseek/active-client';
import { NetworkPolicyError } from '../core/network/request-policy';
import { fetchWithNetworkPolicy, readNetworkResponseText } from '../core/network/request-policy';

const mockedFetchPolicy = vi.mocked(fetchWithNetworkPolicy);
const mockedReadText = vi.mocked(readNetworkResponseText);

const SIGNAL = new AbortController().signal;
const HEADERS = { Authorization: 'Bearer test-token' };
const CONTEXT = { signal: SIGNAL };

function okResponse() {
  return {
    ok: true, status: 200, statusText: '', headers: new Headers(), body: null,
  } as unknown as Response;
}

describe('D1-02 createPowHeaders error classification', () => {
  beforeEach(() => {
    mockedFetchPolicy.mockReset();
    mockedReadText.mockReset();
  });

  it('classifies a transport failure during the PoW challenge as DeepSeekPowError (loses retryability)', async () => {
    mockedFetchPolicy.mockRejectedValue(new TypeError('Failed to fetch'));

    const client = createDeepSeekAutomationClient();
    let caught: unknown;
    try {
      await client.createPowHeaders(HEADERS, CONTEXT);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DeepSeekPowError);
    // The original TypeError is not preserved as a retryable signal.
    expect(caught).not.toBeInstanceOf(NetworkPolicyError);
    expect((caught as DeepSeekPowError).message).not.toMatch(/retryable/i);
  });

  it('preserves DeepSeekAuthError for a 401 PoW challenge (auth must not be masked as PoW)', async () => {
    mockedFetchPolicy.mockResolvedValue({
      ok: false, status: 401, statusText: '', headers: new Headers(), body: null,
    } as unknown as Response);

    const client = createDeepSeekAutomationClient();
    await expect(
      client.createPowHeaders(HEADERS, CONTEXT),
    ).rejects.toBeInstanceOf(DeepSeekAuthError);
  });

  it('re-challenges once per continuation step (no PoW answer reuse)', async () => {
    const originalChrome = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
    };
    // Stub the WASM fetch + instantiate so the PoW solve path is exercised
    // without a real wasm module.
    const wasmBytes = new Uint8Array(64);
    const challengeJson = JSON.stringify({
      code: 0,
      data: {
        biz_code: 0,
        biz_data: {
          challenge: {
            algorithm: 'DeepSeekHashV1',
            challenge: 'a'.repeat(64),
            salt: 'salt',
            difficulty: 1,
            signature: 'sig',
            expire_at: Math.floor(Date.now() / 1000) + 60,
          },
        },
      },
    });
    mockedReadText.mockResolvedValue(challengeJson);
    mockedFetchPolicy.mockImplementation(async () => ({
      ok: true, status: 200, statusText: '', headers: new Headers(), body: null,
      arrayBuffer: async () => wasmBytes.buffer,
    }) as unknown as Response);
    // pow.ts uses the native fetch (not the policy wrapper) for the wasm module.
    const nativeFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: '',
      headers: new Headers(),
      arrayBuffer: async () => wasmBytes.buffer,
    }));
    vi.stubGlobal('fetch', nativeFetch);
    const powMemory = new WebAssembly.Memory({ initial: 1 });
    vi.spyOn(WebAssembly, 'instantiate').mockResolvedValue({
      instance: {
        exports: {
          memory: powMemory,
          wasm_solve: (retPtr: number) => {
            // Emulate the wasm contract: status=1 (solved) at retPtr, answer at retPtr+8.
            const view = new DataView(powMemory.buffer);
            view.setInt32(retPtr, 1, true);
            view.setFloat64(retPtr + 8, 42, true);
          },
          __wbindgen_add_to_stack_pointer: () => 0,
          __wbindgen_export_0: () => 0,
        },
      },
    } as any);

    try {
      const client = createDeepSeekAutomationClient();
      // Two successive calls must each perform a fresh challenge request.
      await client.createPowHeaders(HEADERS, CONTEXT);
      await client.createPowHeaders(HEADERS, CONTEXT);
      // 2 challenge requests, one per continuation step (no cached answer).
      expect(mockedFetchPolicy).toHaveBeenCalledTimes(2);
    } finally {
      (globalThis as { chrome?: unknown }).chrome = originalChrome;
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
