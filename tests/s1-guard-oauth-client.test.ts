/**
 * S1 守护用例（core/sync/oauth-client.ts）：
 *  - P1-45 (item6)：200 但缺 access_token/expires_in 必须抛错，不写 expiresAt=NaN
 *  - P2-100 (item7)：authedFetch 在调用方自带 signal 时仍组合独立超时（authSignal）
 *  - P2-46 (item8)：401 重试后仍 401 ⇒ invalidate + 抛错，绝不把错误 Response 原样返回
 *
 * t 用桩函数，避免依赖 i18n 文案；错误身份以 key + 参数断言。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authedFetch, getAccessToken, invalidateToken } from '../core/sync/oauth-client';

const t = ((key: string, params?: unknown) => `TESTERR:${key}:${JSON.stringify(params ?? {})}`) as never;

const REFRESH_URL = 'https://provider.example/token';
const BUSINESS_URL = 'https://api.example/data';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function tokenResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function statusResponse(status: number): Response {
  return { ok: status >= 200 && status < 300, status } as Response;
}

describe('S1 P1-45: token 响应形状校验', () => {
  it('200 但 body={}（缺 access_token/expires_in）⇒ 抛 malformed token response', async () => {
    invalidateToken('k-malformed');
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse({})));
    await expect(
      getAccessToken('k-malformed', 'refresh-secret', REFRESH_URL, {}, t as never),
    ).rejects.toThrow(/malformed token response/);
  });

  it('对照：合法 token 形状正常返回 access token', async () => {
    invalidateToken('k-ok');
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse({ access_token: 'abc', expires_in: 3600 })));
    await expect(
      getAccessToken('k-ok', 'refresh-secret', REFRESH_URL, {}, t as never),
    ).resolves.toBe('abc');
  });
});

describe('S1 P2-100: authSignal 组合 caller signal + 超时', () => {
  it('调用方传 signal 时，传给业务 fetch 的是组合 signal（非同一引用），且 caller abort 能终止', async () => {
    invalidateToken('k-combine');
    const caller = new AbortController();
    let passedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === REFRESH_URL) return tokenResponse({ access_token: 'tok', expires_in: 3600 });
      passedSignal = (init as RequestInit).signal as AbortSignal;
      return statusResponse(200);
    });
    vi.stubGlobal('fetch', fetchMock);

    await authedFetch('k-combine', 'refresh-secret', REFRESH_URL, {}, BUSINESS_URL, { signal: caller.signal }, t as never);

    // 关键守卫：组合 signal 不能就是 caller.signal 本身（否则等于丢掉了独立超时兜底）
    expect(passedSignal).toBeDefined();
    expect(passedSignal).not.toBe(caller.signal);
    // caller 任一 abort 仍能终止请求
    caller.abort();
    expect(passedSignal?.aborted).toBe(true);
  });
});

describe('S1 P2-46: 重试后仍 401 ⇒ 抛错且不返回 Response', () => {
  it('业务请求连续两次 401 ⇒ authedFetch 抛错，不 resolve 成 Response', async () => {
    invalidateToken('k-401');
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === REFRESH_URL) return tokenResponse({ access_token: 'fresh', expires_in: 3600 });
      return statusResponse(401);
    });
    vi.stubGlobal('fetch', fetchMock);

    let resolvedValue: unknown = 'UNSET';
    let caught: unknown;
    try {
      resolvedValue = await authedFetch('k-401', 'refresh-secret', REFRESH_URL, {}, BUSINESS_URL, {}, t as never);
    } catch (e) {
      caught = e;
    }
    // 必须是抛错路径，且不能把 401 Response 当结果返回
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toContain('oauthRefreshFailed');
    expect(resolvedValue).toBe('UNSET');
  });
});
