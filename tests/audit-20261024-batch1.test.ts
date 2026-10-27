// 审计报告《deepseek-pp-审计报告.md》（2026-10-24，100 条）第一批修复的守护用例。
//
// 本批 6 条：
//   #30 状态条 running 阶段 tool 名未转义（XSS）
//   #31 RichMessageContent 的 urlTransform 全局恒等 ⇒ 链接协议未净化（XSS）
//   #3  request-context.ts 的 getDeepSeekLocale 无 document 守卫（SW 上下文崩）
//   #98 侧栏会话链接只校验 sessionId、不校验 origin（外站跳转）
//   #13 web_fetch 重定向目标 URL 不校验（SSRF 面）
//   #14 web_fetch / bingSearch 全量 response.text() 无大小上限（OOM）
//
// 说明：#30 / #3 / #98 的宿主函数都在巨石文件里没导出，用**结构断言**守；
// #13 / #14 走 `fetch` 打桩做**行为断言**。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeWebSearchToolCall } from '../core/tool/web-search';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function readSource(relative: string): string {
  return readFileSync(join(process.cwd(), relative), 'utf8');
}

describe('审计 #30：状态条 tool 名必须转义', () => {
  it('running 分支的 tool 插值必须走 escapeHtml', () => {
    const source = readSource('entrypoints/content.ts');
    // 修复后的形状：<span class="...">${escapeHtml(tool)}</span>
    expect(source).toMatch(/dpp-status-bar-tool">\$\{escapeHtml\(tool\)\}/);
    // 反向：不允许裸插值
    expect(source).not.toMatch(/dpp-status-bar-tool">\$\{tool\}</);
  });

  it('状态条三个插值分支（tool / complete message / error message）都已转义', () => {
    const source = readSource('entrypoints/content.ts');
    expect(source).toMatch(/dpp-status-bar-tool">\$\{escapeHtml\(tool\)\}/);
    // S2 抽文案后 shape 变为 contentT("content.agent.statusBarComplete/Error", { message: escapeHtml(...) })
    expect(source).toMatch(/content\.agent\.statusBarComplete.*escapeHtml\(String\(options\?\.message/);
    expect(source).toMatch(/content\.agent\.statusBarError.*escapeHtml\(String\(options\?\.message/);
  });
});

describe('审计 #3：request-context 的 locale 读取必须有 document 守卫', () => {
  it('getDeepSeekLocale 先判 typeof document 再读 documentElement.lang', () => {
    const source = readSource('core/interceptor/request-context.ts');
    const start = source.indexOf('function getDeepSeekLocale');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n}', start) + 2);
    // 守卫必须在读取之前，且读取只能出现在守卫语句里
    expect(body).toContain("typeof document !== 'undefined'");
    expect(body.indexOf("typeof document !== 'undefined'"))
      .toBeLessThan(body.indexOf('document.documentElement.lang'));
    // documentElement.lang 那一行必须同时带可选链（守卫内也防 documentElement 为 null）
    expect(body).toMatch(/document\.documentElement\?\.lang/);
  });
});

describe('审计 #98：侧栏会话链接必须校验同源', () => {
  it('normalizeConversationHrefForSession 在采用原 url 前比较 origin', () => {
    const source = readSource('entrypoints/content/adapters/project-sidebar-organizer.ts');
    const fn = source.slice(
      source.indexOf('function normalizeConversationHrefForSession'),
    );
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
    // 必须同时存在 sessionId 校验与 origin 校验
    expect(body).toContain('parseSessionId(trimmed) === sessionId');
    expect(body).toContain('=== location.origin');
  });
});

describe('审计 #13：web_fetch 重定向后的目标 URL 必须重新校验', () => {
  const call = { name: 'web_fetch' as const, payload: { url: 'https://example.test/start' }, raw: '<web_fetch />' };

  // 注：executeWebSearchToolCall 内部 catch 后返回 `ok:false` 的 ToolResult，不向上抛，
  // 所以断言落在返回值上（这与工具运行时的契约一致：工具失败不炸 Agent 循环）。
  it('https 入口被重定向到 http 内网地址 ⇒ 拒绝', async () => {
    const response = {
      ok: true,
      status: 200,
      statusText: 'OK',
      url: 'http://169.254.169.254/latest/meta-data/',
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: null,
      text: async () => 'metadata',
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const result = await executeWebSearchToolCall(call, 'en');
    expect(result.ok).toBe(false);
    expect(String(result.detail)).toMatch(/Refused redirect from https to http/);
  });

  it('重定向到非 http(s) scheme ⇒ 拒绝', async () => {
    const response = {
      ok: true,
      status: 200,
      statusText: 'OK',
      url: 'file:///etc/passwd',
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: null,
      text: async () => 'x',
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const result = await executeWebSearchToolCall(call, 'en');
    expect(result.ok).toBe(false);
    expect(String(result.detail)).toMatch(/Redirected to unsupported URL/);
  });

  it('同 scheme 正常响应仍成功（负控：别把正常请求挡了）', async () => {
    const response = new Response('hello', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const result = await executeWebSearchToolCall(call, 'en');
    expect(result.ok).toBe(true);
  });
});

describe('审计 #14：web_fetch 响应体必须有字节上限', () => {
  const call = { name: 'web_fetch' as const, payload: { url: 'https://example.test/big' }, raw: '<web_fetch />' };

  it('Content-Length 超限 ⇒ 读完前就拒绝', async () => {
    const response = new Response('tiny', {
      status: 200,
      headers: { 'content-type': 'text/plain', 'content-length': String(8 * 1024 * 1024) },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const result = await executeWebSearchToolCall(call, 'en');
    expect(result.ok).toBe(false);
    expect(String(result.detail)).toMatch(/larger than \d+ bytes/);
  });

  it('无 Content-Length 但实际流超限 ⇒ 边读边停并拒绝', async () => {
    const chunk = new Uint8Array(512 * 1024).fill(65); // 512 KiB
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 10) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const response = new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const result = await executeWebSearchToolCall(call, 'en');
    expect(result.ok).toBe(false);
    expect(String(result.detail)).toMatch(/exceeded \d+ bytes/);
    // 关键：没有把 10 块全拉完（10 × 512KiB = 5MiB）；超 1MiB 就该停
    expect(pulls).toBeLessThan(10);
  });

  it('正常小响应仍能读出内容（负控：别把正常页面挡了）', async () => {
    const response = new Response('<html><body>hello world</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const result = await executeWebSearchToolCall(call, 'en');
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.output)).toContain('hello world');
  });
});
