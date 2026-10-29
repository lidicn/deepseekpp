/**
 * 第十二批 P0-1 · 侧栏认证重试。
 *
 * 变异：CHAT_AUTH_RETRY_DELAYS_MS 改为 [] ⇒ 「false→true」用例必须红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_AUTH_RETRY_DELAYS_MS,
  loadAuthStatusWithRetry,
  isChatAuthed,
} from '../core/chat/auth-retry';
import { createChatController } from '../entrypoints/sidepanel/controllers/chat-controller';
import type { SidepanelRuntimeClient } from '../entrypoints/sidepanel/runtime-client';

function authStatus(hasToken: boolean, hasApiKey = false) {
  return {
    available: hasToken || hasApiKey,
    provider: hasApiKey ? 'official-api' as const : hasToken ? 'deepseek-web' as const : null,
    hasApiKey,
    hasToken,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('loadAuthStatusWithRetry', () => {
  it('returns immediately when the first probe is already authed', async () => {
    const fetchAuth = vi.fn(async () => authStatus(true));
    const sleep = vi.fn(async () => {});
    const result = await loadAuthStatusWithRetry(fetchAuth, isChatAuthed, { sleep });
    expect(result.hasToken).toBe(true);
    expect(fetchAuth).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('false then true: retries and returns the second probe (mutation guard)', async () => {
    const fetchAuth = vi.fn()
      .mockResolvedValueOnce(authStatus(false))
      .mockResolvedValueOnce(authStatus(true));
    const sleep = vi.fn(async () => {});
    const run = loadAuthStatusWithRetry(fetchAuth, isChatAuthed, { sleep });
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await run;
    expect(result.hasToken).toBe(true);
    expect(isChatAuthed(result)).toBe(true);
    expect(fetchAuth).toHaveBeenCalledTimes(2);
    // 800ms backoff used before the second probe
    expect(sleep).toHaveBeenCalledWith(800);
  });

  it('delaysMs=[] keeps one-shot probe behavior (mutation: retry count 0)', async () => {
    const fetchAuth = vi.fn(async () => authStatus(false));
    const sleep = vi.fn(async () => {});
    const result = await loadAuthStatusWithRetry(fetchAuth, isChatAuthed, {
      delaysMs: [],
      sleep,
    });
    expect(result.hasToken).toBe(false);
    expect(fetchAuth).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('default delays are 800ms then 2500ms (2 retries)', () => {
    expect([...CHAT_AUTH_RETRY_DELAYS_MS]).toEqual([800, 2_500]);
  });
});

describe('createChatController.load auth retry', () => {
  function makeClient(authResponses: unknown[]): SidepanelRuntimeClient {
    let authIndex = 0;
    return {
      request: vi.fn(async (request: { type: string }) => {
        if (request.type === 'GET_AUTH_STATUS') {
          const value = authResponses[Math.min(authIndex, authResponses.length - 1)];
          authIndex += 1;
          return value;
        }
        if (request.type === 'GET_OFFICIAL_API_CHAT_CONFIG') {
          return { model: 'deepseek-v4-flash', thinking: 'disabled', reasoningEffort: 'high' };
        }
        if (request.type === 'GET_MODEL_TYPE') return null;
        if (request.type === 'GET_VOICE_SETTINGS') {
          return {
            inputEnabled: false,
            readAloudEnabled: false,
            rate: 1,
            pitch: 1,
          };
        }
        throw new Error(`unexpected ${request.type}`);
      }),
    } as unknown as SidepanelRuntimeClient;
  }

  it('first GET_AUTH_STATUS false, second true ⇒ load resolves available', async () => {
    const client = makeClient([
      authStatus(false),
      authStatus(true),
    ]);
    const controller = createChatController(client);
    const run = controller.load();
    await vi.advanceTimersByTimeAsync(3_000);
    const snapshot = await run;
    expect(snapshot.authStatus.hasToken).toBe(true);
    expect(snapshot.authStatus.available).toBe(true);
    const authCalls = (client.request as ReturnType<typeof vi.fn>).mock.calls
      .filter(([req]) => (req as { type: string }).type === 'GET_AUTH_STATUS');
    expect(authCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('retry count 0 (delays empty via module mutation simulation): stays unavailable', async () => {
    // 直接用 helper 模拟把重试关掉 —— 与变异「CHAT_AUTH_RETRY_DELAYS_MS=[]」等价
    const client = makeClient([authStatus(false)]);
    const controller = createChatController(client);
    // 不推进 timers 时 fake sleep 不会完成，但默认 delays 非空会挂起；
    // 这里改走 helper 的 delaysMs=[] 路径验证语义：
    const result = await loadAuthStatusWithRetry(
      async () => authStatus(false),
      isChatAuthed,
      { delaysMs: [], sleep: async () => {} },
    );
    expect(result.available).toBe(false);
    void controller;
  });

  it('refreshAuthStatus re-probes GET_AUTH_STATUS once', async () => {
    const client = makeClient([authStatus(false), authStatus(true)]);
    const controller = createChatController(client);
    const first = await controller.refreshAuthStatus();
    expect(first.hasToken).toBe(false);
    const second = await controller.refreshAuthStatus();
    expect(second.hasToken).toBe(true);
  });
});
