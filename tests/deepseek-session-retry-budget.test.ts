// 2026-10-22 回归：新建对话最开头高概率报「服务器暂时不可用」。
//
// 这个文案不是扩展产生的（源码里除内存注释外无此字符串），它来自 DeepSeek
// 自己的 503 空体。R-7 注释早就点名这是主因，但原重试预算只有 3 次、
// 总等待 300+900+2700 = 3.9s，撑不过常见的十几秒 503 抖动。
//
// 本测试锁定契约：
//  1. 连续的 5xx 会被重试多次（预算足够穿越短时抖动）
//  2. 期间一旦成功就立即返回 sessionId，不浪费剩余次数
//  3. 4xx / 认证错误不重试（不做无意义等待）
import { describe, expect, it, vi } from 'vitest';
import { createDeepSeekAutomationClient } from '../core/deepseek/active-client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sessionOk(id: string): Response {
  return jsonResponse({
    code: 0,
    msg: '',
    data: { biz_code: 0, biz_data: { chat_session: { id } } },
  });
}

function serverError(): Response {
  return new Response('', { status: 503 });
}

describe('createChatSession 重试预算', () => {
  it('连续 5xx 会重试到 5 次才放弃（足够穿越十几秒抖动）', async () => {
    const fetchImpl = vi.fn(async () => serverError());
    const client = createDeepSeekAutomationClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      client.createChatSession({ Authorization: 'Bearer x' }, { signal: new AbortController().signal }),
    ).rejects.toBeTruthy();

    expect(fetchImpl).toHaveBeenCalledTimes(5);
  }, 30_000);

  it('中途成功就立即返回，不浪费剩余重试次数', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call < 3 ? serverError() : sessionOk('session-after-retry');
    });
    const client = createDeepSeekAutomationClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const id = await client.createChatSession(
      { Authorization: 'Bearer x' },
      { signal: new AbortController().signal },
    );

    expect(id).toBe('session-after-retry');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  }, 30_000);

  it('401 认证失败立即抛，不重试', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 40003, msg: 'auth' }, 401));
    const client = createDeepSeekAutomationClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      client.createChatSession({ Authorization: 'Bearer bad' }, { signal: new AbortController().signal }),
    ).rejects.toBeTruthy();

    // 认证类失败不该无意义地反复等
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(1);
  }, 30_000);

  it('用户取消（AbortError）立即抛，不打满重试', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const client = createDeepSeekAutomationClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      client.createChatSession({ Authorization: 'Bearer x' }, { signal: controller.signal }),
    ).rejects.toBeTruthy();

    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(1);
  }, 30_000);
});
