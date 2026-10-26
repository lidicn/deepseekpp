/**
 * 审计 #62：web_fetch 遇到非文本 Content-Type（octet-stream / 图片 / PDF）时，
 * 旧实现返回 ok:true 但 output 里没有内容 —— 模型会以为抓取成功，基于空内容胡说。
 * 现在应返回 ok:false + error.code = UNSUPPORTED_CONTENT_TYPE。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeWebSearchToolCall } from '../core/tool/web-search';

function mockFetch(contentType: string): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { 'content-type': contentType },
  })));
}

describe('web_fetch · 非文本 Content-Type', () => {
  beforeEach(() => {
    mockFetch('application/octet-stream');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('octet-stream 返回 ok:false + 明确 error.code，不是裸 ok:true', async () => {
    const result = await executeWebSearchToolCall({
      name: 'web_fetch',
      payload: { url: 'https://example.com/file.bin' },
      raw: '',
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNSUPPORTED_CONTENT_TYPE');
    // 关键：output 里不应伪装成有内容
    expect(result.output).toBeUndefined();
  });

  it('text/html 仍正常返回 ok:true 且有 content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<p>hello</p>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })));
    const result = await executeWebSearchToolCall({
      name: 'web_fetch',
      payload: { url: 'https://example.com/' },
      raw: '',
    });
    expect(result.ok).toBe(true);
    expect(result.output).toBeDefined();
  });
});
