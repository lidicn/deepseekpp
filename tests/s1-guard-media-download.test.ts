/**
 * S1 守护用例（审计 P2-54 / P2-55，core/multimodal/media.ts downloadImageAsDataUrl）。
 *
 * 这两条修复此前零守护：撤掉它们没有任何测试会红。这里用行为断言直接打桩 fetch：
 *  - P2-54：https 入口被 302 到 http:// 必须抛 "Refused redirect"（防 SSRF 协议降级）
 *  - P2-55：Content-Length 超限必须先 abort() 再抛错，且绝不读取 body（避免超大流进内存）
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadImageAsDataUrl, URL_IMAGE_MAX_BYTES } from '../core/multimodal/media';

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeResponse(init: {
  url?: string;
  contentLength?: string;
  contentType?: string;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}): Response {
  const headers = new Headers();
  if (init.contentLength !== undefined) headers.set('content-length', init.contentLength);
  if (init.contentType !== undefined) headers.set('content-type', init.contentType);
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    url: init.url ?? 'https://example.com/a.png',
    headers,
    arrayBuffer: init.arrayBuffer ?? (async () => new ArrayBuffer(0)),
  } as unknown as Response;
}

describe('S1 P2-54: https→http 重定向降级被拒绝', () => {
  it('初始 https 而最终 response.url 是 http:// 时抛 Refused redirect，且不读 body', async () => {
    const bodyRead = vi.fn(async () => new ArrayBuffer(0));
    const fetchMock = vi.fn<typeof fetch>(async () =>
      fakeResponse({ url: 'http://evil.internal/a.png', contentType: 'image/png', contentLength: '100', arrayBuffer: bodyRead }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadImageAsDataUrl('https://cdn.example.com/a.png'))
      .rejects.toThrow(/Refused redirect from https to http/);
    expect(bodyRead).not.toHaveBeenCalled();
  });

  it('初始 http:// 入口跳到 http:// 不算协议降级（不抛 Refused redirect）', async () => {
    // 守卫只拦截「https 入口被降到 http」，http→http 的同协议跳转不该被误伤。
    const fetchMock = vi.fn<typeof fetch>(async () =>
      fakeResponse({ url: 'http://cdn2.example.com/a.png', contentType: 'image/png', contentLength: '4', arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await downloadImageAsDataUrl('http://cdn.example.com/a.png');
    expect(result.sizeBytes).toBe(4);
  });
});

describe('S1 P2-55: Content-Length 超限先 abort，不读 body', () => {
  it('声明 content-length 超过上限 ⇒ 调用方 signal 被 abort、抛错、arrayBuffer 未被读取', async () => {
    const bodyRead = vi.fn(async () => new ArrayBuffer(10));
    let abortedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      abortedSignal = init?.signal as AbortSignal;
      return fakeResponse({
        url: 'https://example.com/big.png',
        contentType: 'image/png',
        contentLength: String(URL_IMAGE_MAX_BYTES + 1),
        arrayBuffer: bodyRead,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadImageAsDataUrl('https://example.com/big.png'))
      .rejects.toThrow(/exceeds URL image limit/);
    // controller.abort() 必须被调用（断言 1：abort 被调用）
    expect(abortedSignal?.aborted).toBe(true);
    // 断言 2：超限预判后绝不读取响应体
    expect(bodyRead).not.toHaveBeenCalled();
  });
});
