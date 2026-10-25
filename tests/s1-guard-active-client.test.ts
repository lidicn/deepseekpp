/**
 * S1 守护用例（core/deepseek/active-client.ts）：
 *  - P2-6  (item9) ：上传结果缺 status 时不再直接当就绪返回，必须继续轮询到 SUCCESS
 *  - P2-8  (item10)：retainAssistantText:false 时 stall 日志 text_len 用本地累计，
 *                    不能恒为 0（summary.assistantText 在该模式下永不累积）
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEEPSEEK_BYPASS_HOOK_HEADER } from '../core/deepseek/contracts';
import { submitPromptStreaming, uploadDeepSeekFile } from '../core/deepseek/adapter';
import { diagnosticLogBuffer } from '../core/diagnostics/log-buffer';

vi.mock('../core/deepseek/pow', () => ({
  solvePowChallengeLocally: vi.fn(async () => ({
    algorithm: 'sha256', challenge: 'challenge', salt: 'salt', answer: 42, signature: 'signature',
  })),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  diagnosticLogBuffer.clear();
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

function createSubmitInput() {
  return {
    chatSessionId: 'session-1', parentMessageId: 1, modelType: null, prompt: 'hello',
    refFileIds: [], thinkingEnabled: false, searchEnabled: false, clientHeaders: {}, powHeaders: {},
  };
}

describe('S1 P2-6: 上传结果缺 status 时继续轮询，不立即当就绪返回', () => {
  it('上传响应无 status ⇒ 继续轮询 fetch_files，拿到 SUCCESS 才返回', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/api/v0/file/upload_file')) {
        // 注意：biz_data 故意不带 status（审计 P2-6 修复前会被直接当就绪返回）
        return jsonResponse({
          data: { biz_code: 0, biz_data: { id: 'file-1', file_name: 'a.png', file_size: 3, mime_type: 'image/png' } },
        });
      }
      if (url.includes('/api/v0/file/fetch_files')) {
        return jsonResponse({
          data: { biz_code: 0, biz_data: { files: [{ id: 'file-1', file_name: 'a.png', file_size: 3, mime_type: 'image/png', status: 'SUCCESS', audit_result: 'PASS' }] } },
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const promise = uploadDeepSeekFile({
      file: new Blob(['abc'], { type: 'image/png' }),
      filename: 'a.png', modelType: null,
      clientHeaders: {}, powHeaders: {},
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
    const uploaded = await promise;

    // 关键守卫：缺 status 不能被当作就绪直接返回，必须至少轮询过一次 fetch_files
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(uploaded.status).toBe('SUCCESS');
  });
});

describe('S1 P2-8: stall 日志 text_len 随可见文本累计（retainAssistantText:false）', () => {
  it('流产生可见文本后停滞 ⇒ stream_stall 记录里 text_len 等于可见文本长度（非 0）', async () => {
    vi.useFakeTimers();
    diagnosticLogBuffer.clear();

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        // 先产出两段可见文本（"Hello " + "world" = 11 字符），然后挂起不关闭。
        controller.enqueue(encoder.encode('data: {"v":"Hello "}\n\n'));
        controller.enqueue(encoder.encode('data: {"v":"world"}\n\n'));
        // 故意不 close：让流停滞，触发 stall 心跳。
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })));

    const caller = new AbortController();
    const done = submitPromptStreaming(createSubmitInput(), { retainAssistantText: false }, caller.signal);

    // 等可见文本被消费
    await vi.advanceTimersByTimeAsync(0);
    // 快进 40s：stall 轮询 10s 一次，30s 无帧后应记一次 stream_stall
    await vi.advanceTimersByTimeAsync(40_000);
    caller.abort();
    await done.catch(() => {});

    const stall = diagnosticLogBuffer.snapshot().find((e) => e.message === 'stream_stall');
    expect(stall).toBeDefined();
    const m = /text_len=(\d+)/.exec(stall?.details ?? '');
    expect(m).not.toBeNull();
    // 修复前这里恒为 0（summary.assistantText 在 retainAssistantText:false 下为空）；
    // 修复后应等于可见文本累计长度 11。
    expect(Number(m?.[1])).toBe(11);
  });
});
